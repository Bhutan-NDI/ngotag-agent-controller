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
const { W3cCredential, W3cJsonLdVerifiableCredential } = await import('@credo-ts/core')

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
// through genericRecords (the GenericRecord DidController.writeDid saves) then dids.getCreatedDids
// (to fetch the actual DidRecord's didDocument), not DidRepository.
function makeAgent({
  defaultDid,
  didRecord,
  signCredentialImpl,
}: {
  defaultDid: string | null
  didRecord?: unknown
  signCredentialImpl: jest.Mock
}) {
  return {
    context: {},
    genericRecords: {
      findAllByQuery: jest.fn(async () => (defaultDid ? [{ content: { did: defaultDid } }] : [])) as jest.Mock,
    },
    dids: {
      getCreatedDids: jest.fn(async () => (didRecord ? [didRecord] : [])) as jest.Mock,
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
    const didRecord = { did: SELF_DID, didDocument: { verificationMethod: [{ id: VERIFICATION_METHOD_ID }] } }
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
    const agent = makeAgent({ defaultDid: SELF_DID, didRecord, signCredentialImpl: signCredential })
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
    expect(agent.dids.getCreatedDids).toHaveBeenCalledWith({ did: SELF_DID })
  })

  it('supports an array credentialSubject — each entry gets the agent DID as id and its own object as claims', async () => {
    const didRecord = { did: SELF_DID, didDocument: { verificationMethod: [{ id: VERIFICATION_METHOD_ID }] } }
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
    const agent = makeAgent({ defaultDid: SELF_DID, didRecord, signCredentialImpl: signCredential })
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

  it('throws NotFoundError when the agent has no default DID', async () => {
    const { NotFoundError } = await import('../../../errors')
    const signCredential = jest.fn() as jest.Mock
    const agent = makeAgent({ defaultDid: null, signCredentialImpl: signCredential })
    const controller = new AgentController()

    await expect(controller.createW3cSelfAttestedCredential(makeRequest(agent), REQUEST_BODY)).rejects.toThrow(
      NotFoundError,
    )
    expect(signCredential).not.toHaveBeenCalled()
    expect(agent.dids.getCreatedDids).not.toHaveBeenCalled()
  })

  it('throws NotFoundError when the default DID GenericRecord points at a DID that no longer resolves', async () => {
    const { NotFoundError } = await import('../../../errors')
    const signCredential = jest.fn() as jest.Mock
    const agent = makeAgent({ defaultDid: SELF_DID, didRecord: undefined, signCredentialImpl: signCredential })
    const controller = new AgentController()

    await expect(controller.createW3cSelfAttestedCredential(makeRequest(agent), REQUEST_BODY)).rejects.toThrow(
      NotFoundError,
    )
    expect(signCredential).not.toHaveBeenCalled()
  })

  it('throws when the default DID has no verification method', async () => {
    const didRecord = { did: SELF_DID, didDocument: { verificationMethod: [] } }
    const signCredential = jest.fn() as jest.Mock
    const agent = makeAgent({ defaultDid: SELF_DID, didRecord, signCredentialImpl: signCredential })
    const controller = new AgentController()

    await expect(controller.createW3cSelfAttestedCredential(makeRequest(agent), REQUEST_BODY)).rejects.toThrow(
      /[Vv]erification method/,
    )
    expect(signCredential).not.toHaveBeenCalled()
  })
})
