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
 *   6. The default DID is resolved via a DidRepository tag query ({ isDefault: true }) against the
 *      DID's own DidRecord, not a separate GenericRecord pointer — verified directly against the
 *      installed @credo-ts/core/@credo-ts/askar packages that arbitrary DidRecord tags round-trip
 *      through save and query. See DidController.writeDid, which writes this same tag. (An earlier
 *      version of this endpoint read a GenericRecord instead, on the incorrect belief that
 *      DidRecord tags could no longer carry this on Credo 0.6.2; see the #75 review.)
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
const { W3cCredential, W3cJsonLdVerifiableCredential, RecordNotFoundError, DidRepository } =
  await import('@credo-ts/core')

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
// through a DidRepository tag query ({ isDefault: true }, the same tag DidController.writeDid
// sets) then dids.resolveCreatedDidDocumentWithKeys, not a raw getCreatedDids({did}) + record
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
  // Backs the no-default-tag fallback: dids.getCreatedDids() with no filter, as the endpoint calls
  // it when there's no explicit default — models an existing/migrated wallet's full set of created
  // DIDs.
  allCreatedDids?: { did: string }[]
  signCredentialImpl: jest.Mock
}) {
  const didRepository = {
    findByQuery: jest.fn(async () => (defaultDid ? [{ did: defaultDid }] : [])) as jest.Mock,
  }
  const logger = { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() }
  return {
    context: {},
    config: { logger },
    _logger: logger,
    dependencyManager: {
      resolve: jest.fn((token: unknown) => (token === DidRepository ? didRepository : undefined)) as jest.Mock,
    },
    _didRepository: didRepository,
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
    // assertionMethod, not verificationMethod: the endpoint only ever signs with a key listed
    // under assertionMethod (see AgentController's own comment on why verificationMethod alone
    // does not authorize it) -- this fixture models a document that authorizes the key correctly.
    const didDocument = { assertionMethod: [{ id: VERIFICATION_METHOD_ID }] }
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
    // SelfAttestedW3cCredentialResponse types `credential`/`credentialInstances` as JsonObject/
    // JsonObject[] (accurate to what JsonTransformer.toJSON actually returns), which doesn't
    // structurally overlap with this narrower test-only shape -- route through `unknown` first,
    // same as TS's own suggestion for an intentional narrowing cast.
    const response = result as unknown as { credential: { credentialSubject: unknown }; credentialInstances: unknown }
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
    expect(agent._didRepository.findByQuery).toHaveBeenCalledWith(agent.context, { isDefault: true })
    expect(agent.dids.resolveCreatedDidDocumentWithKeys).toHaveBeenCalledWith(SELF_DID)
  })

  // W3cCredential's constructor always assigns its own `id`/`expirationDate` fields, even to
  // undefined -- and Credo's JsonTransformer.toJSON (exposeDefaultValues: true) carries that
  // undefined value through to the plain object @digitalcredentials/vc's issuer actually checks,
  // which looks at key presence (`'expirationDate' in credential`), not truthiness. A real
  // (non-mocked) signCredential call throws "must be a valid date: undefined" for id/expirationDate
  // alike -- confirmed directly against a real in-memory Credo agent, not just inferred from
  // reading the library. Neither field was ever set here before this fix. See the #75 review.
  it('always supplies a real id and a far-future default expirationDate, since W3cCredential/vc-js require both present', async () => {
    const didDocument = { assertionMethod: [{ id: VERIFICATION_METHOD_ID }] }
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
    const before = Date.now()

    await controller.createW3cSelfAttestedCredential(makeRequest(agent), REQUEST_BODY)

    const signedWith = signCredential.mock.calls[0][0] as {
      credential: InstanceType<typeof W3cCredential>
    }
    expect(signedWith.credential.id).toMatch(/^urn:uuid:[0-9a-f-]{36}$/)
    const expiresAt = Date.parse(signedWith.credential.expirationDate as string)
    expect(expiresAt).toBeGreaterThan(before + 99 * 365 * 24 * 60 * 60 * 1000) // ~99+ years out
  })

  it('uses a caller-supplied expirationDate instead of the default, when one is provided', async () => {
    const didDocument = { assertionMethod: [{ id: VERIFICATION_METHOD_ID }] }
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
    const explicitExpiration = '2030-01-01T00:00:00.000Z'

    await controller.createW3cSelfAttestedCredential(makeRequest(agent), {
      ...(REQUEST_BODY as Record<string, unknown>),
      expirationDate: explicitExpiration,
    } as never)

    const signedWith = signCredential.mock.calls[0][0] as {
      credential: InstanceType<typeof W3cCredential>
    }
    expect(signedWith.credential.expirationDate).toBe(explicitExpiration)
  })

  it('rejects a caller-supplied expirationDate that does not parse as a date, before ever signing', async () => {
    const didDocument = { assertionMethod: [{ id: VERIFICATION_METHOD_ID }] }
    const signCredential = jest.fn() as jest.Mock
    const agent = makeAgent({ defaultDid: SELF_DID, didDocument, signCredentialImpl: signCredential })
    const controller = new AgentController()

    await expect(
      controller.createW3cSelfAttestedCredential(makeRequest(agent), {
        ...(REQUEST_BODY as Record<string, unknown>),
        expirationDate: 'not-a-date',
      } as never),
    ).rejects.toThrow('not-a-date')
    expect(signCredential).not.toHaveBeenCalled()
  })

  // SSRF guard: @context is caller-controlled and unvalidated URLs reach Credo's document loader.
  // Scope-limited to literal-address/scheme filtering -- see AgentController's own comment on
  // assertSafeContextUrl for what this does and does not cover.
  describe('@context SSRF guard', () => {
    const rejectsContext = async (context: unknown, expectedMessageFragment: string) => {
      const didDocument = { assertionMethod: [{ id: VERIFICATION_METHOD_ID }] }
      const signCredential = jest.fn() as jest.Mock
      const agent = makeAgent({ defaultDid: SELF_DID, didDocument, signCredentialImpl: signCredential })
      const controller = new AgentController()

      await expect(
        controller.createW3cSelfAttestedCredential(makeRequest(agent), {
          ...(REQUEST_BODY as Record<string, unknown>),
          '@context': context,
        } as never),
      ).rejects.toThrow(expectedMessageFragment)
      expect(signCredential).not.toHaveBeenCalled()
    }

    it('rejects a non-https context URL, before ever signing', async () => {
      await rejectsContext(['http://example.com/context.jsonld'], 'must use https')
    })

    it('rejects a context URL targeting localhost', async () => {
      await rejectsContext(['https://localhost/context.jsonld'], 'disallowed host')
    })

    it.each([
      ['https://127.0.0.1/context.jsonld', 'IPv4 loopback'],
      ['https://169.254.169.254/latest/meta-data/', 'IPv4 link-local (cloud metadata endpoint)'],
      ['https://10.0.0.5/context.jsonld', 'IPv4 private (10.0.0.0/8)'],
      ['https://172.16.0.1/context.jsonld', 'IPv4 private (172.16.0.0/12)'],
      ['https://192.168.1.1/context.jsonld', 'IPv4 private (192.168.0.0/16)'],
      ['https://[::1]/context.jsonld', 'IPv6 loopback'],
      ['https://[fe80::1]/context.jsonld', 'IPv6 link-local'],
      ['https://[fc00::1]/context.jsonld', 'IPv6 unique-local'],
      ['https://[::ffff:127.0.0.1]/context.jsonld', 'IPv4-mapped IPv6 loopback (filter-bypass form)'],
    ])('rejects a context URL with a literal %s address (%s)', async (url) => {
      await rejectsContext([url], 'disallowed host')
    })

    it('accepts a normal https context URL alongside an inline JsonObject context entry', async () => {
      const didDocument = { assertionMethod: [{ id: VERIFICATION_METHOD_ID }] }
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

      await controller.createW3cSelfAttestedCredential(makeRequest(agent), {
        ...(REQUEST_BODY as Record<string, unknown>),
        '@context': ['https://www.w3.org/2018/credentials/v1', { '@version': 1.1 }],
      } as never)

      expect(signCredential).toHaveBeenCalled()
    })
  })

  it('supports an array credentialSubject — each entry gets the agent DID as id and its own object as claims', async () => {
    // assertionMethod, not verificationMethod: the endpoint only ever signs with a key listed
    // under assertionMethod (see AgentController's own comment on why verificationMethod alone
    // does not authorize it) -- this fixture models a document that authorizes the key correctly.
    const didDocument = { assertionMethod: [{ id: VERIFICATION_METHOD_ID }] }
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
    // assertionMethod, not verificationMethod: the endpoint only ever signs with a key listed
    // under assertionMethod (see AgentController's own comment on why verificationMethod alone
    // does not authorize it) -- this fixture models a document that authorizes the key correctly.
    const didDocument = { assertionMethod: [{ id: VERIFICATION_METHOD_ID }] }
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

    // See the cast above: SelfAttestedW3cCredentialResponse's JsonObject-typed fields don't
    // structurally overlap with this narrower test-only shape, so route through `unknown` first.
    const result = (await controller.createW3cSelfAttestedCredential(makeRequest(agent), REQUEST_BODY)) as unknown as {
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
    // assertionMethod, not verificationMethod: the endpoint only ever signs with a key listed
    // under assertionMethod (see AgentController's own comment on why verificationMethod alone
    // does not authorize it) -- this fixture models a document that authorizes the key correctly.
    const didDocument = { assertionMethod: [{ id: VERIFICATION_METHOD_ID }] }
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

    // See the cast above: SelfAttestedW3cCredentialResponse's JsonObject-typed fields don't
    // structurally overlap with this narrower test-only shape, so route through `unknown` first.
    const result = (await controller.createW3cSelfAttestedCredential(makeRequest(agent), REQUEST_BODY)) as unknown as {
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

  it('picks the most recently created DID when more than one is tagged isDefault — not an arbitrary unordered pick', async () => {
    // #73 review: findByQuery applies no ordering of its own (a plain Askar scan, no createdAt
    // sort). A wallet migrated from the legacy stack can carry more than one isDefault-tagged
    // DID (the old default was never cleared before writeDid's own fix), so an unordered [0]
    // pick is whatever the store happens to return first -- Askar's rowid-ordered scan returns
    // the EARLIEST-created record, which can be a long-superseded DID, not the one an operator
    // actually tagged default most recently.
    // assertionMethod, not verificationMethod: the endpoint only ever signs with a key listed
    // under assertionMethod (see AgentController's own comment on why verificationMethod alone
    // does not authorize it) -- this fixture models a document that authorizes the key correctly.
    const didDocument = { assertionMethod: [{ id: VERIFICATION_METHOD_ID }] }
    const RECENT_DID = 'did:indy:recent-default'
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
    // Deliberately returned in earliest-first order, matching an unordered store scan -- the fix
    // must sort these itself rather than rely on query order.
    agent._didRepository.findByQuery = jest.fn(async () => [
      { did: SELF_DID, createdAt: new Date('2024-01-01T00:00:00.000Z') },
      { did: RECENT_DID, createdAt: new Date('2025-06-01T00:00:00.000Z') },
    ]) as jest.Mock
    const controller = new AgentController()

    await controller.createW3cSelfAttestedCredential(makeRequest(agent), REQUEST_BODY)

    const signedWith = signCredential.mock.calls[0][0] as { credential: InstanceType<typeof W3cCredential> }
    expect(signedWith.credential.issuerId).toBe(RECENT_DID)
    expect(agent.dids.resolveCreatedDidDocumentWithKeys).toHaveBeenCalledWith(RECENT_DID)
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

  it('throws when the default DID has an empty assertionMethod (verificationMethod alone does not help)', async () => {
    const didDocument = { assertionMethod: [], verificationMethod: [{ id: VERIFICATION_METHOD_ID }] }
    const signCredential = jest.fn() as jest.Mock
    const agent = makeAgent({ defaultDid: SELF_DID, didDocument, signCredentialImpl: signCredential })
    const controller = new AgentController()

    await expect(controller.createW3cSelfAttestedCredential(makeRequest(agent), REQUEST_BODY)).rejects.toThrow(
      /[Vv]erification method/,
    )
    expect(signCredential).not.toHaveBeenCalled()
  })

  it('rejects a verificationMethod-only document before signing -- verificationMethod alone does not authorize the assertionMethod proof purpose this endpoint signs with', async () => {
    // The actual bug this fix closes: a verification method being listed under
    // verificationMethod does not authorize it for credential assertions. The JSON-LD verifier
    // checks that the proof key is referenced by the DID document's assertionMethod relationship
    // specifically -- so the pre-fix fallback (assertionMethod ?? verificationMethod) could sign,
    // store, and return 200 for a credential that later fails verification everywhere else with
    // "not authorized by controller for proof purpose 'assertionMethod'". Same failure mode
    // already correctly identified and removed for the authentication fallback; a bare
    // verificationMethod fallback is not any safer. See the #75 review.
    const didDocument = { verificationMethod: [{ id: VERIFICATION_METHOD_ID }] }
    const signCredential = jest.fn() as jest.Mock
    const agent = makeAgent({ defaultDid: SELF_DID, didDocument, signCredentialImpl: signCredential })
    const controller = new AgentController()

    await expect(controller.createW3cSelfAttestedCredential(makeRequest(agent), REQUEST_BODY)).rejects.toThrow(
      `Default DID '${SELF_DID}' has no assertionMethod verification method; it cannot be used to issue credentials`,
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
    // assertionMethod, not verificationMethod: the endpoint only ever signs with a key listed
    // under assertionMethod (see AgentController's own comment on why verificationMethod alone
    // does not authorize it) -- this fixture models a document that authorizes the key correctly.
    const didDocument = { assertionMethod: [{ id: VERIFICATION_METHOD_ID }] }
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

  it('uses assertionMethod and ignores verificationMethod/authentication entirely when a document carries all three', async () => {
    // Pins the selection itself: assertionMethod is the only purpose this endpoint ever signs
    // with (proofPurpose is always assertionMethod, see toSubject above), so verificationMethod
    // and authentication (both pointing at deliberately wrong ids here) must never be consulted
    // at all, not merely deprioritized -- neither authorizes a key for the assertionMethod proof
    // purpose this endpoint signs with. See the #73/#75 reviews.
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

  it('throws instead of silently signing with an authentication-only key, for a did:peer default DID with no assertionMethod', async () => {
    // The actual vulnerability this fix closes: did:peer's handleDidPeer document has
    // authentication but no assertionMethod. The pre-fix code fell back to authentication, so
    // signCredential (nothing at issuance time checks a key's authorized purpose) would succeed
    // with a 200 and persist a credential that is permanently unverifiable everywhere else --
    // ControllerProofPurpose.validate rejects it at verification time as "not authorized by
    // controller for proof purpose 'assertionMethod'". A loud, immediate error here is strictly
    // better than that silent, delayed failure. See the #75 review.
    const didDocument = {
      verificationMethod: undefined,
      assertionMethod: undefined,
      authentication: ['wrong-auth-id'],
    }
    const signCredential = jest.fn() as jest.Mock
    const agent = makeAgent({ defaultDid: SELF_DID, didDocument, signCredentialImpl: signCredential })
    const controller = new AgentController()

    await expect(controller.createW3cSelfAttestedCredential(makeRequest(agent), REQUEST_BODY)).rejects.toThrow(
      `Default DID '${SELF_DID}' has no assertionMethod verification method; it cannot be used to issue credentials`,
    )
    expect(signCredential).not.toHaveBeenCalled()
  })

  it('sanitizes a signCredential failure instead of exposing its raw message, and logs the real cause server-side', async () => {
    // #75 review: a caller-controlled @context can drive CachedDocumentLoader's fallback to
    // Credo's native JSON-LD loader, reaching attacker-chosen or internal addresses (SSRF).
    // Whatever that document loader (or signCredential itself) throws must not be echoed back
    // verbatim -- ErrorHandlingService's generic branch serializes error.message straight into the
    // HTTP response, which would turn this into a probing oracle (resolved URL, HTTP status,
    // redirect/network failure detail). The real error must still reach the server-side log.
    // assertionMethod, not verificationMethod: the endpoint only ever signs with a key listed
    // under assertionMethod (see AgentController's own comment on why verificationMethod alone
    // does not authorize it) -- this fixture models a document that authorizes the key correctly.
    const didDocument = { assertionMethod: [{ id: VERIFICATION_METHOD_ID }] }
    const signCredential = jest.fn(async () => {
      throw new Error('getaddrinfo ENOTFOUND internal-service.svc.cluster.local:8080/secrets')
    }) as jest.Mock
    const agent = makeAgent({ defaultDid: SELF_DID, didDocument, signCredentialImpl: signCredential })
    const controller = new AgentController()

    let caught: Error | undefined
    try {
      await controller.createW3cSelfAttestedCredential(makeRequest(agent), REQUEST_BODY)
    } catch (error) {
      caught = error as Error
    }

    expect(caught?.message).toContain('Failed to sign the self-attested credential')
    expect(caught?.message).not.toMatch(/internal-service|ENOTFOUND/)
    expect((agent._logger as { error: jest.Mock }).error).toHaveBeenCalledWith(
      expect.stringContaining('internal-service.svc.cluster.local'),
    )
  })
})
