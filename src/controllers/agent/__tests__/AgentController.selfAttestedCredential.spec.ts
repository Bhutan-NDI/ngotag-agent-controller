/**
 * Regression tests for AgentController.createW3cSelfAttestedCredential — ported from
 * pipeline-implementation's endpoint of the same name (originally on MultiTenancyController).
 *
 * Locks in the real changes from the legacy version:
 *   1. It must resolve the agent from request.agent, not the legacy this.agent field, which no
 *      longer exists on this class.
 *   2. It operates directly on request.agent (no tenantId param, no withTenantAgent()) — matching
 *      verifyCredential/verify's generic-op convention on this same controller, not the legacy
 *      /multi-tenancy/:tenantId placement, which only a base-wallet token could ever reach (see
 *      the #75 review: a dedicated agent or a tenant's own token both 401'd there).
 *   3. It must build a real W3cCredential instance and call w3cCredentials.store({ record }) via
 *      W3cCredentialRecord.fromCredential(...) — the legacy w3cCredentials.storeCredential(...)
 *      method no longer exists on the current Credo version, and passing a plain object literal
 *      (rather than a W3cCredential instance) to signCredential's `credential` field no longer
 *      type-checks either.
 *   4. Claims must survive into the signed credential — W3cCredentialSubject's constructor only
 *      reads options.id/options.claims, so they must be nested under `claims`, not spread at the
 *      top level (which would silently drop every claim while still "succeeding").
 *   5. The response restores a top-level `credential` field for back-compat with consumers that
 *      read response.credential directly — 0.6.2's W3cCredentialRecord only exposes
 *      `credentialInstances` via JsonTransformer.toJSON.
 *   6. The default DID is resolved via a GenericRecord (tags: { isDefaultDid: 'true' }), not a
 *      DidRepository query — Credo 0.6.2's DidRecord custom tags are typed to just
 *      recipientKeyFingerprints/alternativeDids, so a DidRecord-tag-based lookup (the legacy
 *      approach) matches nothing on this Credo version. See DidController.writeDid, which writes
 *      the GenericRecord this reads.
 *   7. The DID document itself comes from dids.resolveCreatedDidDocumentWithKeys(selfDid), not
 *      getCreatedDids({did}) + record.didDocument — Credo only persists didDocument on the
 *      DidRecord for some methods (never for did:key, only for did:peer numAlgo 1), so reading it
 *      straight off the record silently breaks for did:key/did:peer(numAlgo2) defaults, the two
 *      most likely methods for this endpoint. The resolving API falls back to actually resolving
 *      the document when it wasn't persisted, and throws RecordNotFoundError (-> 404) when the
 *      DID itself is gone.
 *
 * Runs under Jest's ESM mode (see jest.config.base.ts) — tsyringe is mocked so constructing the
 * controller does not require a real DI container. @credo-ts/core itself is used for real (its
 * W3cCredential/NotFoundError classes are plain JS, not native-bound — safe and fast in tests).
 */
import type { W3cCredentialSubject } from '@credo-ts/core'

import { jest } from '@jest/globals'

const noopDecorator = () => () => {}

jest.unstable_mockModule('tsyringe', () => ({
  injectable: noopDecorator,
  singleton: noopDecorator,
  scoped: noopDecorator,
  autoInjectable: noopDecorator,
  inject: noopDecorator,
  injectAll: noopDecorator,
  delay: (fn: unknown) => fn,
  Lifecycle: { Singleton: 0, Transient: 1, ResolutionScoped: 2, ContainerScoped: 3 },
  container: {
    resolve: jest.fn(() => ({})),
    register: jest.fn(),
    registerInstance: jest.fn(),
    isRegistered: jest.fn(() => false),
  },
}))

const { AgentController } = await import('../AgentController')
const { W3cCredential, W3cJsonLdVerifiableCredential, RecordNotFoundError } = await import('@credo-ts/core')

const SELF_DID = 'did:key:self-attesting-tenant'
const VERIFICATION_METHOD_ID = `${SELF_DID}#key-1`

const REQUEST_BODY = {
  '@context': ['https://www.w3.org/2018/credentials/v1'],
  type: ['VerifiableCredential'],
  credentialSubject: { claim: 'value' },
  proofType: 'Ed25519Signature2018',
} as never

// request.agent's own shape — no tenantId param, no withTenantAgent() indirection, matching how
// verifyCredential/verify already consume it on this controller. Default DID resolution goes
// through genericRecords (the GenericRecord DidController.writeDid saves) then
// dids.resolveCreatedDidDocumentWithKeys, not DidRepository or a raw getCreatedDids() + record
// .didDocument read — the real Credo API resolves the document when the DidRecord itself never
// persisted one (did:key, did:peer numAlgo 2), and throws RecordNotFoundError when the DID is
// gone, which is why `didDocument: undefined` here models "known DID, no document" while
// `didDocument: null` models "DID not found" (the resolveCreatedDidDocumentWithKeys mock below
// throws for that case, matching the real API rather than returning a falsy record).
function makeAgent({
  defaultDid,
  didDocument,
  allCreatedDids = [],
  signCredentialImpl,
}: {
  defaultDid: string | null
  didDocument?: unknown | null
  // Backs the no-GenericRecord fallback: dids.getCreatedDids() with no filter, as the endpoint
  // calls it when there's no explicit default — models an existing/migrated wallet's full set of
  // created DIDs.
  allCreatedDids?: { did: string }[]
  signCredentialImpl: jest.Mock
}) {
  return {
    context: {},
    genericRecords: {
      findAllByQuery: jest.fn(async () => (defaultDid ? [{ content: { did: defaultDid } }] : [])) as jest.Mock,
    },
    dids: {
      resolveCreatedDidDocumentWithKeys: jest.fn(async (did: string) => {
        if (didDocument === null) {
          throw new RecordNotFoundError(`Created did '${did}' not found`, { recordType: 'DidRecord' })
        }
        return { keys: [], didDocument }
      }) as jest.Mock,
      getCreatedDids: jest.fn(async () => allCreatedDids) as jest.Mock,
    },
    w3cCredentials: {
      signCredential: signCredentialImpl,
      store: jest.fn(async ({ record }: { record: unknown }) => record) as jest.Mock,
    },
  }
}

const makeRequest = (agent: unknown) => ({ agent }) as never

describe('AgentController.createW3cSelfAttestedCredential', () => {
  it('signs with the agent default DID, stores via store({ record }), and returns the stored record', async () => {
    const didDocument = { verificationMethod: [{ id: VERIFICATION_METHOD_ID }] }
    // Real signCredential returns a signed W3cVerifiableCredential (a W3cCredential subclass with
    // a `proof`, driving the `.encoded` getter that W3cCredentialRecord.fromCredential relies on)
    // — echoing back the unsigned W3cCredential the mock was given would not have that shape.
    const signCredential = jest.fn(async (options: { credential: InstanceType<typeof W3cCredential> }) => {
      return new W3cJsonLdVerifiableCredential({
        ...options.credential,
        proof: {
          type: 'Ed25519Signature2018',
          proofPurpose: 'assertionMethod',
          verificationMethod: VERIFICATION_METHOD_ID,
          created: new Date().toISOString(),
          jws: 'fake-jws',
        },
      })
    }) as jest.Mock
    const agent = makeAgent({ defaultDid: SELF_DID, didDocument, signCredentialImpl: signCredential })
    const controller = new AgentController()

    const result = await controller.createW3cSelfAttestedCredential(makeRequest(agent), REQUEST_BODY)

    // Signed with a real W3cCredential instance (not a plain object) — this is the type/runtime
    // fix from the legacy version.
    const signedWith = signCredential.mock.calls[0][0] as { credential: unknown; verificationMethod: string }
    expect(signedWith.credential).toBeInstanceOf(W3cCredential)
    expect(signedWith.verificationMethod).toBe(VERIFICATION_METHOD_ID)
    expect((signedWith.credential as InstanceType<typeof W3cCredential>).issuerId).toBe(SELF_DID)

    // The requested claims must actually reach the signed credential. W3cCredentialSubject's
    // constructor only reads options.id/options.claims — spreading the request's claims at the
    // top level (rather than nesting them under `claims`) leaves this undefined and every claim
    // silently dropped, while the credential still signs and stores "successfully".
    const signedSubject = (signedWith.credential as InstanceType<typeof W3cCredential>)
      .credentialSubject as InstanceType<typeof W3cCredentialSubject>
    expect(signedSubject.id).toBe(SELF_DID)
    expect(signedSubject.claims).toEqual({ claim: 'value' })

    // store() was called with a real W3cCredentialRecord built via fromCredential(signedCred).
    // The endpoint returns a JSON-safe envelope built from it, not the class instance directly —
    // and restores a top-level `credential` field for back-compat with 0.5.x consumers (platform
    // -> agent-service -> mobile wallet) that read response.credential: 0.6.2's W3cCredentialRecord
    // only exposes `credentialInstances`, dropping that field from JsonTransformer.toJSON entirely.
    const response = result as { credential: { credentialSubject: unknown }; credentialInstances: unknown }
    expect(response.credentialInstances).toBeDefined() // the record's own current-shape fields are still present
    expect(response.credential).toBeDefined()
    // Pinned end-to-end: the claims survive all the way through to the returned response too — at
    // the JSON layer, W3cCredentialSubjectTransformer flattens `claims` back onto the subject
    // object (`{ ...claims, id }`), matching the real VC-JSON-LD wire format, rather than keeping
    // the `{ id, claims }` shape the in-memory class instance uses.
    expect(response.credential.credentialSubject).toMatchObject({
      id: SELF_DID,
      claim: 'value',
    })
    expect(agent.genericRecords.findAllByQuery).toHaveBeenCalledWith({ isDefaultDid: 'true' })
    expect(agent.dids.resolveCreatedDidDocumentWithKeys).toHaveBeenCalledWith(SELF_DID)
  })

  it('supports an array credentialSubject — each entry gets the agent DID as id and its own object as claims', async () => {
    const didDocument = { verificationMethod: [{ id: VERIFICATION_METHOD_ID }] }
    const signCredential = jest.fn(async (options: { credential: InstanceType<typeof W3cCredential> }) => {
      return new W3cJsonLdVerifiableCredential({
        ...options.credential,
        proof: {
          type: 'Ed25519Signature2018',
          proofPurpose: 'assertionMethod',
          verificationMethod: VERIFICATION_METHOD_ID,
          created: new Date().toISOString(),
          jws: 'fake-jws',
        },
      })
    }) as jest.Mock
    const agent = makeAgent({ defaultDid: SELF_DID, didDocument, signCredentialImpl: signCredential })
    const controller = new AgentController()

    const requestBody = {
      '@context': ['https://www.w3.org/2018/credentials/v1'],
      type: ['VerifiableCredential'],
      credentialSubject: [{ claim: 'first' }, { claim: 'second' }],
      proofType: 'Ed25519Signature2018',
    } as never

    await controller.createW3cSelfAttestedCredential(makeRequest(agent), requestBody)

    const signedWith = signCredential.mock.calls[0][0] as { credential: InstanceType<typeof W3cCredential> }
    const subjects = signedWith.credential.credentialSubject as InstanceType<typeof W3cCredentialSubject>[]
    expect(Array.isArray(subjects)).toBe(true)
    expect(subjects).toHaveLength(2)
    expect(subjects[0]).toMatchObject({ id: SELF_DID, claims: { claim: 'first' } })
    expect(subjects[1]).toMatchObject({ id: SELF_DID, claims: { claim: 'second' } })
  })

  it('throws NotFoundError when the agent has no default DID and no created DIDs to fall back on', async () => {
    const { NotFoundError } = await import('../../../errors')
    const signCredential = jest.fn() as jest.Mock
    const agent = makeAgent({ defaultDid: null, signCredentialImpl: signCredential })
    const controller = new AgentController()

    await expect(controller.createW3cSelfAttestedCredential(makeRequest(agent), REQUEST_BODY)).rejects.toThrow(
      NotFoundError,
    )
    expect(signCredential).not.toHaveBeenCalled()
    expect(agent.dids.resolveCreatedDidDocumentWithKeys).not.toHaveBeenCalled()
  })

  it("falls back to the agent's single created DID when no GenericRecord marks a default — existing/migrated wallets", async () => {
    // The #75 review's core scenario: a wallet from before the GenericRecord-based default-DID
    // tracking existed. There's no backfill step, so without this fallback every such wallet
    // 404s here forever, with re-anchoring a brand-new DID as the only workaround.
    const didDocument = { verificationMethod: [{ id: VERIFICATION_METHOD_ID }] }
    const signCredential = jest.fn(async (options: { credential: InstanceType<typeof W3cCredential> }) => {
      return new W3cJsonLdVerifiableCredential({
        ...options.credential,
        proof: {
          type: 'Ed25519Signature2018',
          proofPurpose: 'assertionMethod',
          verificationMethod: VERIFICATION_METHOD_ID,
          created: new Date().toISOString(),
          jws: 'fake-jws',
        },
      })
    }) as jest.Mock
    const agent = makeAgent({
      defaultDid: null,
      didDocument,
      allCreatedDids: [{ did: SELF_DID }],
      signCredentialImpl: signCredential,
    })
    const controller = new AgentController()

    const result = (await controller.createW3cSelfAttestedCredential(makeRequest(agent), REQUEST_BODY)) as {
      credential: { credentialSubject: unknown }
    }

    expect(agent.dids.getCreatedDids).toHaveBeenCalledWith()
    expect(agent.dids.resolveCreatedDidDocumentWithKeys).toHaveBeenCalledWith(SELF_DID)
    expect(result.credential.credentialSubject).toMatchObject({ id: SELF_DID })
  })

  it('excludes did:peer connection DIDs from the single-created-DID fallback — the common case for a wallet that has ever connected', async () => {
    // The fallback's own follow-up finding: getCreatedDids() is a role filter ("everything with
    // role: Created"), not "DIDs the operator explicitly wrote" — PeerDidRegistrar saves every
    // DIDComm connection/mediation-routing DID with that same role. A holder wallet's whole
    // purpose is DIDComm, so a migrated wallet with one real issuer DID and several existing
    // connections is the common case, not the exception — without excluding did:peer entries
    // first, length === 1 would almost never hold for exactly the wallets this fallback targets.
    const didDocument = { verificationMethod: [{ id: VERIFICATION_METHOD_ID }] }
    const signCredential = jest.fn(async (options: { credential: InstanceType<typeof W3cCredential> }) => {
      return new W3cJsonLdVerifiableCredential({
        ...options.credential,
        proof: {
          type: 'Ed25519Signature2018',
          proofPurpose: 'assertionMethod',
          verificationMethod: VERIFICATION_METHOD_ID,
          created: new Date().toISOString(),
          jws: 'fake-jws',
        },
      })
    }) as jest.Mock
    const agent = makeAgent({
      defaultDid: null,
      didDocument,
      allCreatedDids: [
        { did: SELF_DID },
        { did: 'did:peer:2.Ez6L...connection-one' },
        { did: 'did:peer:2.Ez6L...connection-two' },
        { did: 'did:peer:4zQm...mediation-routing' },
      ],
      signCredentialImpl: signCredential,
    })
    const controller = new AgentController()

    const result = (await controller.createW3cSelfAttestedCredential(makeRequest(agent), REQUEST_BODY)) as {
      credential: { credentialSubject: unknown }
    }

    expect(agent.dids.resolveCreatedDidDocumentWithKeys).toHaveBeenCalledWith(SELF_DID)
    expect(result.credential.credentialSubject).toMatchObject({ id: SELF_DID })
  })

  it('does not guess among multiple created DIDs — still 404s rather than silently picking one', async () => {
    const { NotFoundError } = await import('../../../errors')
    const signCredential = jest.fn() as jest.Mock
    const agent = makeAgent({
      defaultDid: null,
      allCreatedDids: [{ did: SELF_DID }, { did: 'did:key:some-other-tenant-did' }],
      signCredentialImpl: signCredential,
    })
    const controller = new AgentController()

    await expect(controller.createW3cSelfAttestedCredential(makeRequest(agent), REQUEST_BODY)).rejects.toThrow(
      NotFoundError,
    )
    expect(signCredential).not.toHaveBeenCalled()
    expect(agent.dids.resolveCreatedDidDocumentWithKeys).not.toHaveBeenCalled()
  })

  it('throws NotFoundError when the default DID GenericRecord points at a DID that no longer resolves', async () => {
    const { NotFoundError } = await import('../../../errors')
    const signCredential = jest.fn() as jest.Mock
    const agent = makeAgent({ defaultDid: SELF_DID, didDocument: null, signCredentialImpl: signCredential })
    const controller = new AgentController()

    await expect(controller.createW3cSelfAttestedCredential(makeRequest(agent), REQUEST_BODY)).rejects.toThrow(
      NotFoundError,
    )
    expect(signCredential).not.toHaveBeenCalled()
  })

  it('throws when the default DID has no verification method', async () => {
    const didDocument = { verificationMethod: [] }
    const signCredential = jest.fn() as jest.Mock
    const agent = makeAgent({ defaultDid: SELF_DID, didDocument, signCredentialImpl: signCredential })
    const controller = new AgentController()

    await expect(controller.createW3cSelfAttestedCredential(makeRequest(agent), REQUEST_BODY)).rejects.toThrow(
      /[Vv]erification method/,
    )
    expect(signCredential).not.toHaveBeenCalled()
  })

  it('resolves the verification method for a did:key default DID even though KeyDidRegistrar never persists a didDocument on the DidRecord', async () => {
    // This is the exact regression the #75 review flagged: for did:key/did:peer(numAlgo2), the
    // DidRecord's own didDocument field is undefined (nothing sets it at creation time), so a
    // naive getCreatedDids({did}) + record.didDocument read would find selfDidVerificationMethod
    // undefined here even though the DID is real and resolvable. This test's fake
    // resolveCreatedDidDocumentWithKeys mimics the real API's resolver-fallback behavior — it
    // always returns a document, proving the endpoint goes through the resolving API rather than
    // reading an (in this scenario, never-persisted) field directly off the DidRecord.
    const didDocument = { verificationMethod: [{ id: VERIFICATION_METHOD_ID }] }
    const signCredential = jest.fn(async (options: { credential: InstanceType<typeof W3cCredential> }) => {
      return new W3cJsonLdVerifiableCredential({
        ...options.credential,
        proof: {
          type: 'Ed25519Signature2018',
          proofPurpose: 'assertionMethod',
          verificationMethod: VERIFICATION_METHOD_ID,
          created: new Date().toISOString(),
          jws: 'fake-jws',
        },
      })
    }) as jest.Mock
    const agent = makeAgent({ defaultDid: SELF_DID, didDocument, signCredentialImpl: signCredential })
    const controller = new AgentController()

    await controller.createW3cSelfAttestedCredential(makeRequest(agent), REQUEST_BODY)

    expect(agent.dids.resolveCreatedDidDocumentWithKeys).toHaveBeenCalledWith(SELF_DID)
    expect(signCredential).toHaveBeenCalled()
  })

  it('resolves the verification method for a did:peer default DID, whose document has no top-level verificationMethod at all', async () => {
    // The #75 review's follow-up finding: resolveCreatedDidDocumentWithKeys fixed did:key, but
    // did:peer's numAlgo2 document is built purely through purpose-specific setters
    // (addAssertionMethod/addAuthentication/addKeyAgreement) — none of which populate
    // didDocument.verificationMethod at all, so DidDocumentBuilder leaves it undefined for every
    // did:peer:2. Reading verificationMethod[0] directly (the pre-fix code) would find this
    // undefined even for a real, fully-resolved did:peer document. assertionMethod holds a plain
    // DID-URL string here, not an embedded object — proving the fix normalises both forms, not
    // just the object one didDocument.verificationMethod entries use.
    const didDocument = {
      verificationMethod: undefined,
      assertionMethod: [VERIFICATION_METHOD_ID],
    }
    const signCredential = jest.fn(async (options: { credential: InstanceType<typeof W3cCredential> }) => {
      return new W3cJsonLdVerifiableCredential({
        ...options.credential,
        proof: {
          type: 'Ed25519Signature2018',
          proofPurpose: 'assertionMethod',
          verificationMethod: VERIFICATION_METHOD_ID,
          created: new Date().toISOString(),
          jws: 'fake-jws',
        },
      })
    }) as jest.Mock
    const agent = makeAgent({ defaultDid: SELF_DID, didDocument, signCredentialImpl: signCredential })
    const controller = new AgentController()

    await controller.createW3cSelfAttestedCredential(makeRequest(agent), REQUEST_BODY)

    const signedWith = signCredential.mock.calls[0][0] as { verificationMethod: string }
    expect(signedWith.verificationMethod).toBe(VERIFICATION_METHOD_ID)
  })

  it('prefers assertionMethod over authentication, and authentication over verificationMethod, when more than one is present', async () => {
    // Pins the fallback order itself: assertionMethod is the purpose this endpoint actually signs
    // with (proofPurpose is always assertionMethod, see toSubject above), so it must win over the
    // other two when a document happens to carry all three.
    const didDocument = {
      verificationMethod: [{ id: 'wrong-vm-id' }],
      authentication: ['wrong-auth-id'],
      assertionMethod: [{ id: VERIFICATION_METHOD_ID }],
    }
    const signCredential = jest.fn(async (options: { credential: InstanceType<typeof W3cCredential> }) => {
      return new W3cJsonLdVerifiableCredential({
        ...options.credential,
        proof: {
          type: 'Ed25519Signature2018',
          proofPurpose: 'assertionMethod',
          verificationMethod: VERIFICATION_METHOD_ID,
          created: new Date().toISOString(),
          jws: 'fake-jws',
        },
      })
    }) as jest.Mock
    const agent = makeAgent({ defaultDid: SELF_DID, didDocument, signCredentialImpl: signCredential })
    const controller = new AgentController()

    await controller.createW3cSelfAttestedCredential(makeRequest(agent), REQUEST_BODY)

    const signedWith = signCredential.mock.calls[0][0] as { verificationMethod: string }
    expect(signedWith.verificationMethod).toBe(VERIFICATION_METHOD_ID)
  })
})
