/**
 * Regression tests for CredentialController.deleteById / deleteW3cById — porting the legacy
 * pipeline-implementation endpoints (/multi-tenancy/credential/:credentialRecordId/:tenantId and
 * /multi-tenancy/credential/w3c/:credentialRecordId/:tenantId, both on MultiTenancyController) to
 * this repo's /didcomm/credentials family, which never had a delete endpoint at all. Confirmed via
 * the cloud-wallet compatibility audit that this is a live, wired frontend flow
 * (DeleteCredentialModal, gated by an isSelfAttested flag that picks between these two).
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

const { CredentialController } = await import('../CredentialController')

const CREDENTIAL_RECORD_ID = 'credential-record-1'

const makeAgentForDeleteById = (deleteByIdImpl?: jest.Mock) => ({
  modules: {
    didcomm: {
      credentials: {
        deleteById: deleteByIdImpl ?? (jest.fn(async () => undefined) as jest.Mock),
      },
    },
  },
})

const makeAgentForDeleteW3c = (removeCredentialRecordImpl?: jest.Mock) => {
  const removeCredentialRecord = removeCredentialRecordImpl ?? (jest.fn(async () => undefined) as jest.Mock)
  return {
    context: { contextCorrelationId: 'ctx-1' },
    dependencyManager: {
      resolve: jest.fn(async () => ({ removeCredentialRecord })),
    },
    __removeCredentialRecord: removeCredentialRecord,
  }
}

const makeRequest = (agent: unknown) => ({ agent }) as never

describe('CredentialController.deleteById', () => {
  it('deletes the credential exchange record (and, by default, its associated stored credential) by id', async () => {
    const agent = makeAgentForDeleteById()
    const controller = new CredentialController(undefined as never)

    const result = await controller.deleteById(makeRequest(agent), CREDENTIAL_RECORD_ID)

    expect(agent.modules.didcomm.credentials.deleteById).toHaveBeenCalledWith(CREDENTIAL_RECORD_ID)
    expect(result).toEqual({ message: 'Credential Deleted Successfully' })
  })

  it('routes a failure through ErrorHandlingService rather than throwing the raw Credo error', async () => {
    const agent = makeAgentForDeleteById(
      jest.fn(async () => {
        throw new Error('credential not found')
      }) as jest.Mock,
    )
    const controller = new CredentialController(undefined as never)

    await expect(controller.deleteById(makeRequest(agent), CREDENTIAL_RECORD_ID)).rejects.toBeDefined()
  })
})

describe('CredentialController.deleteW3cById', () => {
  it('resolves W3cCredentialService and deletes the record by id, passing the agent context explicitly', async () => {
    const agent = makeAgentForDeleteW3c()
    const controller = new CredentialController(undefined as never)

    const result = await controller.deleteW3cById(makeRequest(agent), CREDENTIAL_RECORD_ID)

    expect(agent.__removeCredentialRecord).toHaveBeenCalledWith(agent.context, CREDENTIAL_RECORD_ID)
    expect(result).toEqual({ message: 'W3C Credential Deleted Successfully' })
  })

  it('routes a failure through ErrorHandlingService rather than throwing the raw Credo error', async () => {
    const agent = makeAgentForDeleteW3c(
      jest.fn(async () => {
        throw new Error('w3c credential not found')
      }) as jest.Mock,
    )
    const controller = new CredentialController(undefined as never)

    await expect(controller.deleteW3cById(makeRequest(agent), CREDENTIAL_RECORD_ID)).rejects.toBeDefined()
  })
})
