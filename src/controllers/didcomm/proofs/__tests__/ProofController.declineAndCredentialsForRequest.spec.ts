/**
 * Regression tests for ProofController.declineRequest / getCredentialsForRequest — porting
 * DidCommProofsApi.declineRequest() and DidCommProofsApi.getCredentialsForRequest(), which existed
 * on the legacy pipeline-implementation stack (as /multi-tenancy/proofs/:proofRecordId/
 * decline-request/:tenantId and /multi-tenancy/credentialsForRequest/:tenantId/:proofRecordId) but
 * had no equivalent anywhere on this repo's /didcomm/proofs family. Both APIs are still present on
 * this repo's installed Credo 0.6.2 (@credo-ts/didcomm), and both have live production consumers
 * via cloud-wallet-service's /proofs/decline-request and /credentialsForRequest/:proofRecordId —
 * see the ngotag-platform #71 review's port-completeness sweep.
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

const makeAgent = (overrides: { declineRequestImpl?: jest.Mock; getCredentialsForRequestImpl?: jest.Mock } = {}) => ({
  modules: {
    didcomm: {
      proofs: {
        declineRequest:
          overrides.declineRequestImpl ??
          (jest.fn(async () => ({ toJSON: () => ({ id: PROOF_RECORD_ID, state: 'declined' }) })) as jest.Mock),
        getCredentialsForRequest:
          overrides.getCredentialsForRequestImpl ??
          (jest.fn(async () => ({ proofFormats: { indy: [{ credentialId: 'cred-1' }] } })) as jest.Mock),
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
    const agent = makeAgent()
    const controller = new ProofController()

    await controller.getCredentialsForRequest(makeRequest(agent), PROOF_RECORD_ID)

    expect(agent.modules.didcomm.proofs.declineRequest).not.toHaveBeenCalled()
  })
})
