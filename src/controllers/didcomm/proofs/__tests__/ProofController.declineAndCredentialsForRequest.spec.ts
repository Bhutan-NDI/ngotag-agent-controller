/**
 * Regression tests for ProofController.declineRequest / getCredentialsForRequest — porting
 * DidCommProofsApi.declineRequest() and DidCommProofsApi.getCredentialsForRequest(), which existed
 * on the legacy pipeline-implementation stack (as /multi-tenancy/proofs/:proofRecordId/
 * decline-request/:tenantId and /multi-tenancy/credentialsForRequest/:tenantId/:proofRecordId) but
 * had no equivalent anywhere on this repo's /didcomm/proofs family. Both APIs are still present on
 * this repo's installed Credo 0.6.2 (@credo-ts/didcomm), and both have live production consumers
 * via cloud-wallet-service's /proofs/decline-request and /credentialsForRequest/:proofRecordId.
 *
 * declineRequest optionally sends a problem-report message to the verifier; getCredentialsForRequest
 * is the "let the holder choose among matching credentials" read path, complementing acceptRequest's
 * existing auto-select via selectCredentialsForRequest.
 *
 * Runs under Jest's ESM mode, mirroring DidController.polygon.spec.ts: tsyringe is mocked so
 * constructing the controller doesn't require a real DI container / agent spin-up. Unlike
 * DidController, ProofController has no instance-level Agent field resolved at construction time,
 * so the tsyringe mock exists only to keep @injectable()/@Tags()/@Route() etc. as harmless no-ops
 * during import.
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

const { ProofController } = await import('../ProofController')

const PROOF_RECORD_ID = 'proof-record-1'

const makeAgent = (
  overrides: {
    declineRequestImpl?: jest.Mock
    getCredentialsForRequestImpl?: jest.Mock
    getByIdImpl?: jest.Mock
  } = {},
) => ({
  modules: {
    didcomm: {
      proofs: {
        // Defaults to a record in request-received -- the only state declineRequest/
        // getCredentialsForRequest actually accept -- so every test below exercises the happy
        // path unless it explicitly overrides this.
        getById:
          overrides.getByIdImpl ??
          (jest.fn(async () => ({
            state: 'request-received',
            toJSON: () => ({ id: PROOF_RECORD_ID, state: 'request-received' }),
          })) as jest.Mock),
        declineRequest:
          overrides.declineRequestImpl ??
          (jest.fn(async () => ({ toJSON: () => ({ id: PROOF_RECORD_ID, state: 'declined' }) })) as jest.Mock),
        getCredentialsForRequest:
          overrides.getCredentialsForRequestImpl ??
          (jest.fn(async () => ({ proofFormats: { indy: [{ credentialId: 'cred-1' }] } })) as jest.Mock),
        // Only ever asserted on with not.toHaveBeenCalled() below -- getCredentialsForRequest is
        // a read-only lookup and must never reach either of these.
        acceptRequest: jest.fn() as jest.Mock,
        selectCredentialsForRequest: jest.fn() as jest.Mock,
      },
    },
  },
})

const makeRequest = (agent: unknown) => ({ agent }) as never

describe('ProofController.declineRequest', () => {
  it('declines the request and returns the JSON-serialized proof record', async () => {
    const agent = makeAgent()
    const controller = new ProofController()

    const result = await controller.declineRequest(makeRequest(agent), PROOF_RECORD_ID, {})

    expect(agent.modules.didcomm.proofs.declineRequest).toHaveBeenCalledWith({
      proofExchangeRecordId: PROOF_RECORD_ID,
      sendProblemReport: undefined,
      problemReportDescription: undefined,
    })
    expect(result).toEqual({ id: PROOF_RECORD_ID, state: 'declined' })
  })

  it('forwards sendProblemReport and problemReportDescription when supplied', async () => {
    const agent = makeAgent()
    const controller = new ProofController()

    await controller.declineRequest(makeRequest(agent), PROOF_RECORD_ID, {
      sendProblemReport: true,
      problemReportDescription: 'Not interested',
    })

    expect(agent.modules.didcomm.proofs.declineRequest).toHaveBeenCalledWith({
      proofExchangeRecordId: PROOF_RECORD_ID,
      sendProblemReport: true,
      problemReportDescription: 'Not interested',
    })
  })

  it('routes a decline failure through ErrorHandlingService rather than throwing the raw Credo error', async () => {
    const agent = makeAgent({
      declineRequestImpl: jest.fn(async () => {
        throw new Error('proof record not found')
      }) as jest.Mock,
    })
    const controller = new ProofController()

    await expect(controller.declineRequest(makeRequest(agent), PROOF_RECORD_ID, {})).rejects.toBeDefined()
  })

  it('rejects an oversized problemReportDescription before it ever reaches declineRequest/the DIDComm send', async () => {
    // The field otherwise accepts an unbounded string (up to the app-wide 5 MB body limit) that
    // gets encrypted, stored, and delivered to the verifier.
    const agent = makeAgent()
    const controller = new ProofController()

    await expect(
      controller.declineRequest(makeRequest(agent), PROOF_RECORD_ID, {
        sendProblemReport: true,
        problemReportDescription: 'x'.repeat(501),
      }),
    ).rejects.toThrow('problemReportDescription must be at most 500 characters.')
    expect(agent.modules.didcomm.proofs.declineRequest).not.toHaveBeenCalled()
  })

  it('accepts a problemReportDescription right at the length boundary', async () => {
    const agent = makeAgent()
    const controller = new ProofController()

    await controller.declineRequest(makeRequest(agent), PROOF_RECORD_ID, {
      sendProblemReport: true,
      problemReportDescription: 'x'.repeat(500),
    })

    expect(agent.modules.didcomm.proofs.declineRequest).toHaveBeenCalledTimes(1)
  })

  it('forwards an empty-string problemReportDescription as undefined, not "" — an empty string defeats Credo\'s own default reason', async () => {
    // A bare truthiness guard would let "" through unvalidated, and Credo's
    // `description: options.problemReportDescription ?? 'Request declined'` does not treat ""
    // as nullish, so the verifier would receive a reasonless problem report instead of the default.
    const agent = makeAgent()
    const controller = new ProofController()

    await controller.declineRequest(makeRequest(agent), PROOF_RECORD_ID, {
      sendProblemReport: true,
      problemReportDescription: '',
    })

    expect(agent.modules.didcomm.proofs.declineRequest).toHaveBeenCalledWith(
      expect.objectContaining({ problemReportDescription: undefined }),
    )
  })

  it('is idempotent when the record is already declined — returns the existing record instead of erroring', async () => {
    // Credo's own assertState throws a plain CredoError for a repeat decline (e.g. a retry after
    // a lost response, or a double-tap), which ErrorHandlingService maps to a raw 500. A caller
    // retrying can't distinguish "nothing to do" from a genuine failure.
    const agent = makeAgent({
      getByIdImpl: jest.fn(async () => ({
        state: 'declined',
        toJSON: () => ({ id: PROOF_RECORD_ID, state: 'declined' }),
      })) as jest.Mock,
    })
    const controller = new ProofController()

    const result = await controller.declineRequest(makeRequest(agent), PROOF_RECORD_ID, {})

    expect(result).toEqual({ id: PROOF_RECORD_ID, state: 'declined' })
    expect(agent.modules.didcomm.proofs.declineRequest).not.toHaveBeenCalled()
  })

  it('rejects declining a record that is not in request-received with a 4xx, not a raw 500 from Credo', async () => {
    const agent = makeAgent({
      getByIdImpl: jest.fn(async () => ({
        state: 'presentation-sent',
        toJSON: () => ({ id: PROOF_RECORD_ID, state: 'presentation-sent' }),
      })) as jest.Mock,
    })
    const controller = new ProofController()

    await expect(controller.declineRequest(makeRequest(agent), PROOF_RECORD_ID, {})).rejects.toThrow(
      /presentation-sent/,
    )
    expect(agent.modules.didcomm.proofs.declineRequest).not.toHaveBeenCalled()
  })
})

describe('ProofController.getCredentialsForRequest', () => {
  it('returns the credentials matching the proof request without accepting or selecting any of them', async () => {
    const agent = makeAgent()
    const controller = new ProofController()

    const result = await controller.getCredentialsForRequest(makeRequest(agent), PROOF_RECORD_ID)

    expect(agent.modules.didcomm.proofs.getCredentialsForRequest).toHaveBeenCalledWith({
      proofExchangeRecordId: PROOF_RECORD_ID,
    })
    expect(result).toEqual({ proofFormats: { indy: [{ credentialId: 'cred-1' }] } })
  })

  it('does not call acceptRequest/selectCredentialsForRequest — this is a read-only lookup', async () => {
    // Asserts on the two methods this test's title actually names, so the test protects the
    // invariant it claims to rather than a vacuous check.
    const agent = makeAgent()
    const controller = new ProofController()

    await controller.getCredentialsForRequest(makeRequest(agent), PROOF_RECORD_ID)

    expect(agent.modules.didcomm.proofs.acceptRequest).not.toHaveBeenCalled()
    expect(agent.modules.didcomm.proofs.selectCredentialsForRequest).not.toHaveBeenCalled()
  })

  it('rejects listing credentials for a record that is not in request-received with a 4xx, not a raw 500 from Credo', async () => {
    // DidCommProofV2Protocol.getCredentialsForRequest asserts protocol version and state
    // (request-received only) itself and throws a plain CredoError otherwise -- including
    // immediately after a successful decline, on a verifier-side record, or a v1 record reached
    // via this v2-only path.
    const agent = makeAgent({
      getByIdImpl: jest.fn(async () => ({
        state: 'declined',
        toJSON: () => ({ id: PROOF_RECORD_ID, state: 'declined' }),
      })) as jest.Mock,
    })
    const controller = new ProofController()

    await expect(controller.getCredentialsForRequest(makeRequest(agent), PROOF_RECORD_ID)).rejects.toThrow(/declined/)
    expect(agent.modules.didcomm.proofs.getCredentialsForRequest).not.toHaveBeenCalled()
  })
})
