/**
 * Regression tests for MultiTenancyController.createW3cSelfAttestedCredential — ported from
 * pipeline-implementation's endpoint of the same name.
 *
 * Locks in the two real changes from the legacy version:
 *   1. It must resolve the agent from request.agent, not the legacy this.agent field, which no
 *      longer exists on this class.
 *   2. It must build a real W3cCredential instance and call w3cCredentials.store({ record }) via
 *      W3cCredentialRecord.fromCredential(...) — the legacy w3cCredentials.storeCredential(...)
 *      method no longer exists on the current Credo version, and passing a plain object literal
 *      (rather than a W3cCredential instance) to signCredential's `credential` field no longer
 *      type-checks either.
 *
 * Runs under Jest's ESM mode (see jest.config.base.ts) — tsyringe is mocked so constructing the
 * controller does not require a real DI container. @credo-ts/core itself is used for real (its
 * W3cCredential/NotFoundError classes are plain JS, not native-bound — safe and fast in tests).
 */
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

const { MultiTenancyController } = await import('../MultiTenancyController')
const { DidRepository, W3cCredential, W3cJsonLdVerifiableCredential } = await import('@credo-ts/core')

const SELF_DID = 'did:key:self-attesting-tenant'
const VERIFICATION_METHOD_ID = `${SELF_DID}#key-1`

const REQUEST_BODY = {
  '@context': ['https://www.w3.org/2018/credentials/v1'],
  type: ['VerifiableCredential'],
  credentialSubject: { claim: 'value' },
  proofType: 'Ed25519Signature2018',
} as never

function makeDidRepository(defaultDidRecord: unknown) {
  return { findSingleByQuery: jest.fn(async () => defaultDidRecord) as jest.Mock }
}

function makeTenantAgent(didRepository: ReturnType<typeof makeDidRepository>, signCredentialImpl: jest.Mock) {
  return {
    context: {},
    dependencyManager: { resolve: jest.fn(() => didRepository) },
    w3cCredentials: {
      signCredential: signCredentialImpl,
      store: jest.fn(async ({ record }: { record: unknown }) => record) as jest.Mock,
    },
  }
}

function makeAgent(tenantAgent: ReturnType<typeof makeTenantAgent>) {
  return {
    modules: {
      tenants: {
        withTenantAgent: jest.fn(async (_options: { tenantId: string }, cb: (a: unknown) => Promise<void>) => {
          await cb(tenantAgent)
        }),
      },
    },
  }
}

const makeRequest = (agent: unknown) => ({ agent }) as never

describe('MultiTenancyController.createW3cSelfAttestedCredential', () => {
  it('signs with the tenant default DID, stores via store({ record }), and returns the stored record', async () => {
    const didRepository = makeDidRepository({
      did: SELF_DID,
      didDocument: { verificationMethod: [{ id: VERIFICATION_METHOD_ID }] },
    })
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
    const tenantAgent = makeTenantAgent(didRepository, signCredential)
    const agent = makeAgent(tenantAgent)
    const controller = new MultiTenancyController()

    const result = await controller.createW3cSelfAttestedCredential(makeRequest(agent), 'tenant-1', REQUEST_BODY)

    // Signed with a real W3cCredential instance (not a plain object) — this is the type/runtime
    // fix from the legacy version.
    const signedWith = signCredential.mock.calls[0][0] as { credential: unknown; verificationMethod: string }
    expect(signedWith.credential).toBeInstanceOf(W3cCredential)
    expect(signedWith.verificationMethod).toBe(VERIFICATION_METHOD_ID)
    expect((signedWith.credential as InstanceType<typeof W3cCredential>).issuerId).toBe(SELF_DID)

    // store() was called with a real W3cCredentialRecord built via fromCredential(signedCred),
    // and its return value (echoed by the mocked store()) is what the endpoint returns.
    const { W3cCredentialRecord } = await import('@credo-ts/core')
    expect(result).toBeInstanceOf(W3cCredentialRecord)
    expect((result as InstanceType<typeof W3cCredentialRecord>).firstCredential.issuerId).toBe(SELF_DID)
    expect(didRepository.findSingleByQuery).toHaveBeenCalledWith(tenantAgent.context, { isDefault: true })
  })

  it('throws NotFoundError when the tenant has no default DID', async () => {
    const { NotFoundError } = await import('../../../errors')
    const didRepository = makeDidRepository(null)
    const signCredential = jest.fn() as jest.Mock
    const tenantAgent = makeTenantAgent(didRepository, signCredential)
    const agent = makeAgent(tenantAgent)
    const controller = new MultiTenancyController()

    await expect(
      controller.createW3cSelfAttestedCredential(makeRequest(agent), 'tenant-1', REQUEST_BODY),
    ).rejects.toThrow(NotFoundError)
    expect(signCredential).not.toHaveBeenCalled()
  })

  it('throws when the default DID has no verification method', async () => {
    const didRepository = makeDidRepository({ did: SELF_DID, didDocument: { verificationMethod: [] } })
    const signCredential = jest.fn() as jest.Mock
    const tenantAgent = makeTenantAgent(didRepository, signCredential)
    const agent = makeAgent(tenantAgent)
    const controller = new MultiTenancyController()

    await expect(
      controller.createW3cSelfAttestedCredential(makeRequest(agent), 'tenant-1', REQUEST_BODY),
    ).rejects.toThrow(/[Vv]erification method/)
    expect(signCredential).not.toHaveBeenCalled()
  })

  it('sanity: DidRepository is the real class (constructor-based DI token, not a string)', () => {
    expect(typeof DidRepository).toBe('function')
  })
})
