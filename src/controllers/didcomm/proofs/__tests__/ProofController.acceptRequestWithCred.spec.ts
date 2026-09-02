/**
 * Regression tests for ProofController.acceptRequestWithCred — porting the legacy
 * pipeline-implementation endpoint (/multi-tenancy/proofs/accept-request-with-cred/:tenantId,
 * MultiTenancyController.acceptRequestWithProofFormatInput) to this repo's /didcomm/proofs family,
 * which never had an equivalent. Confirmed via the cloud-wallet compatibility audit that this is a
 * live, wired frontend flow (ProofShareModal's credential-selection UI), not a dormant capability.
 *
 * The legacy version only forwarded the matched entry's bare `credentialRecord`; the currently
 * installed Credo (DifPexInputDescriptorToCredentials) expects the full `SubmissionEntryCredential`
 * (credentialRecord + claimFormat) in its place -- these tests lock in the corrected shape.
 *
 * #85 review findings, all fixed and covered here:
 *  - only requirement.submissionEntry[0] was read, silently dropping every entry beyond the first
 *    for a multi-entry ('all'/'pick' with needsCount > 1) requirement.
 *  - the presentationExchange proof format was hardcoded, throwing an opaque 500 (via Credo's own
 *    "No attachment found for service presentationExchange") for an indy/anoncreds-negotiated
 *    proof record instead of a clear rejection.
 *  - an unmatched/omitted descriptor was silently dropped and the presentation was still
 *    submitted successfully, missing a required credential with no error surfaced anywhere.
 *
 * Runs under Jest's ESM mode, mirroring ProofController.declineAndCredentialsForRequest.spec.ts.
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

const matchingCredential = { claimFormat: 'jwtvc', credentialRecord: { id: 'cred-a' } }
const otherCredential = { claimFormat: 'jwtvc', credentialRecord: { id: 'cred-b' } }
const secondMatchingCredential = { claimFormat: 'jwtvc', credentialRecord: { id: 'cred-c' } }

const singleEntryRequirement = {
  needsCount: 1,
  submissionEntry: [
    {
      inputDescriptorId: 'descriptor-1',
      verifiableCredentials: [matchingCredential, otherCredential],
    },
  ],
}

const makeAgent = (
  overrides: {
    getByIdImpl?: jest.Mock
    getCredentialsForRequestImpl?: jest.Mock
    acceptRequestImpl?: jest.Mock
  } = {},
) => ({
  modules: {
    didcomm: {
      proofs: {
        getById:
          overrides.getByIdImpl ??
          (jest.fn(async () => ({
            state: 'request-received',
            toJSON: () => ({ id: PROOF_RECORD_ID, state: 'request-received' }),
          })) as jest.Mock),
        getCredentialsForRequest:
          overrides.getCredentialsForRequestImpl ??
          (jest.fn(async () => ({
            proofFormats: {
              presentationExchange: {
                requirements: [singleEntryRequirement],
              },
            },
          })) as jest.Mock),
        acceptRequest:
          overrides.acceptRequestImpl ??
          (jest.fn(async () => ({ toJSON: () => ({ id: PROOF_RECORD_ID, state: 'presentation-sent' }) })) as jest.Mock),
      },
    },
  },
})

const makeRequest = (agent: unknown) => ({ agent }) as never

describe('ProofController.acceptRequestWithCred', () => {
  it('submits the caller-chosen credential, wrapping the full matched entry (not a bare credentialRecord)', async () => {
    const agent = makeAgent()
    const controller = new ProofController()

    const result = await controller.acceptRequestWithCred(makeRequest(agent), PROOF_RECORD_ID, {
      proofFormats: { presentationExchange: { credentials: { 'descriptor-1': 'cred-a' } } },
    })

    expect(agent.modules.didcomm.proofs.acceptRequest).toHaveBeenCalledWith({
      proofExchangeRecordId: PROOF_RECORD_ID,
      comment: undefined,
      proofFormats: { presentationExchange: { credentials: { 'descriptor-1': [matchingCredential] } } },
    })
    expect(result).toEqual({ id: PROOF_RECORD_ID, state: 'presentation-sent' })
  })

  it('forwards an optional comment', async () => {
    const agent = makeAgent()
    const controller = new ProofController()

    await controller.acceptRequestWithCred(makeRequest(agent), PROOF_RECORD_ID, {
      comment: 'here you go',
      proofFormats: { presentationExchange: { credentials: { 'descriptor-1': 'cred-a' } } },
    })

    expect(agent.modules.didcomm.proofs.acceptRequest).toHaveBeenCalledWith(
      expect.objectContaining({ comment: 'here you go' }),
    )
  })

  it('resolves every entry in a multi-entry requirement, not just the first', async () => {
    const agent = makeAgent({
      getCredentialsForRequestImpl: jest.fn(async () => ({
        proofFormats: {
          presentationExchange: {
            requirements: [
              {
                needsCount: 2,
                submissionEntry: [
                  { inputDescriptorId: 'descriptor-1', verifiableCredentials: [matchingCredential] },
                  { inputDescriptorId: 'descriptor-2', verifiableCredentials: [secondMatchingCredential] },
                ],
              },
            ],
          },
        },
      })) as jest.Mock,
    })
    const controller = new ProofController()

    await controller.acceptRequestWithCred(makeRequest(agent), PROOF_RECORD_ID, {
      proofFormats: {
        presentationExchange: { credentials: { 'descriptor-1': 'cred-a', 'descriptor-2': 'cred-c' } },
      },
    })

    expect(agent.modules.didcomm.proofs.acceptRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        proofFormats: {
          presentationExchange: {
            credentials: {
              'descriptor-1': [matchingCredential],
              'descriptor-2': [secondMatchingCredential],
            },
          },
        },
      }),
    )
  })

  it('rejects when the caller-chosen id matches none of the available credentials, instead of silently dropping the descriptor', async () => {
    const agent = makeAgent()
    const controller = new ProofController()

    await expect(
      controller.acceptRequestWithCred(makeRequest(agent), PROOF_RECORD_ID, {
        proofFormats: { presentationExchange: { credentials: { 'descriptor-1': 'cred-does-not-exist' } } },
      }),
    ).rejects.toThrow(/descriptor-1/)
    expect(agent.modules.didcomm.proofs.acceptRequest).not.toHaveBeenCalled()
  })

  it('rejects when a requirement needing 2 credentials only gets 1 matched, instead of submitting an incomplete presentation', async () => {
    const agent = makeAgent({
      getCredentialsForRequestImpl: jest.fn(async () => ({
        proofFormats: {
          presentationExchange: {
            requirements: [
              {
                needsCount: 2,
                submissionEntry: [
                  { inputDescriptorId: 'descriptor-1', verifiableCredentials: [matchingCredential] },
                  { inputDescriptorId: 'descriptor-2', verifiableCredentials: [secondMatchingCredential] },
                ],
              },
            ],
          },
        },
      })) as jest.Mock,
    })
    const controller = new ProofController()

    // Only descriptor-1 chosen -- descriptor-2 omitted entirely, an alternative Credo's
    // needsCount says isn't actually optional here.
    await expect(
      controller.acceptRequestWithCred(makeRequest(agent), PROOF_RECORD_ID, {
        proofFormats: { presentationExchange: { credentials: { 'descriptor-1': 'cred-a' } } },
      }),
    ).rejects.toThrow(/needing 2 credential\(s\), only 1 provided/)
    expect(agent.modules.didcomm.proofs.acceptRequest).not.toHaveBeenCalled()
  })

  it('rejects with a clear error when the proof was not negotiated using presentationExchange, instead of an opaque Credo 500', async () => {
    const agent = makeAgent({
      getCredentialsForRequestImpl: jest.fn(async () => ({
        proofFormats: { indy: [{ credentialId: 'cred-1' }] },
      })) as jest.Mock,
    })
    const controller = new ProofController()

    await expect(
      controller.acceptRequestWithCred(makeRequest(agent), PROOF_RECORD_ID, {
        proofFormats: { presentationExchange: { credentials: {} } },
      }),
    ).rejects.toThrow(/presentationExchange/)
    expect(agent.modules.didcomm.proofs.acceptRequest).not.toHaveBeenCalled()
  })

  it('rejects accepting a record that is not in request-received with a 4xx, not a raw 500 from Credo', async () => {
    const agent = makeAgent({
      getByIdImpl: jest.fn(async () => ({
        state: 'presentation-sent',
        toJSON: () => ({ id: PROOF_RECORD_ID, state: 'presentation-sent' }),
      })) as jest.Mock,
    })
    const controller = new ProofController()

    await expect(
      controller.acceptRequestWithCred(makeRequest(agent), PROOF_RECORD_ID, {
        proofFormats: { presentationExchange: { credentials: {} } },
      }),
    ).rejects.toThrow(/presentation-sent/)
    expect(agent.modules.didcomm.proofs.getCredentialsForRequest).not.toHaveBeenCalled()
    expect(agent.modules.didcomm.proofs.acceptRequest).not.toHaveBeenCalled()
  })

  it('routes a failure through ErrorHandlingService rather than throwing the raw Credo error', async () => {
    const agent = makeAgent({
      acceptRequestImpl: jest.fn(async () => {
        throw new Error('presentation submission failed')
      }) as jest.Mock,
    })
    const controller = new ProofController()

    await expect(
      controller.acceptRequestWithCred(makeRequest(agent), PROOF_RECORD_ID, {
        proofFormats: { presentationExchange: { credentials: { 'descriptor-1': 'cred-a' } } },
      }),
    ).rejects.toBeDefined()
  })
})
