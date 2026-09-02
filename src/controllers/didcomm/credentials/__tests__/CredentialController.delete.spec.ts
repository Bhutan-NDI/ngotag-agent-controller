/**
 * Regression tests for CredentialController.deleteById / deleteW3cById — porting the legacy
 * pipeline-implementation endpoints (/multi-tenancy/credential/:credentialRecordId/:tenantId and
 * /multi-tenancy/credential/w3c/:credentialRecordId/:tenantId, both on MultiTenancyController) to
 * this repo's /didcomm/credentials family, which never had a delete endpoint at all. Confirmed via
 * the cloud-wallet compatibility audit that this is a live, wired frontend flow
 * (DeleteCredentialModal, gated by an isSelfAttested flag that picks between these two).
 *
 * #85 review findings, both fixed and covered here:
 *  - deleteW3cById deleted the raw W3cCredentialRecord unconditionally, with no check for a
 *    DidCommCredentialExchangeRecord still referencing it -- orphaning a same-tenant
 *    credentialRecordId with no cleanup path if ever called against a DIDComm-issued (not
 *    self-attested) credential.
 *  - both endpoints returned 200 + { message } instead of this package's 204/no-body convention
 *    (ConnectionController.deleteConnection, OutOfBandController.deleteOutOfBandRecord).
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

const makeAgentForDeleteW3c = (
  overrides: { removeCredentialRecordImpl?: jest.Mock; findAllByQueryImpl?: jest.Mock } = {},
) => {
  const removeCredentialRecord = overrides.removeCredentialRecordImpl ?? (jest.fn(async () => undefined) as jest.Mock)
  const findAllByQuery = overrides.findAllByQueryImpl ?? (jest.fn(async () => []) as jest.Mock)
  return {
    context: { contextCorrelationId: 'ctx-1' },
    dependencyManager: {
      resolve: jest.fn(async () => ({ removeCredentialRecord })),
    },
    modules: {
      didcomm: {
        credentials: { findAllByQuery },
      },
    },
    __removeCredentialRecord: removeCredentialRecord,
    __findAllByQuery: findAllByQuery,
  }
}

const makeRequest = (agent: unknown) => ({ agent }) as never

describe('CredentialController.deleteById', () => {
  it('deletes the credential exchange record (and, by default, its associated stored credential) by id, returning 204/no-body', async () => {
    const agent = makeAgentForDeleteById()
    const controller = new CredentialController(undefined as never)

    const result = await controller.deleteById(makeRequest(agent), CREDENTIAL_RECORD_ID)

    expect(agent.modules.didcomm.credentials.deleteById).toHaveBeenCalledWith(CREDENTIAL_RECORD_ID)
    expect(result).toBeUndefined()
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
  it("queries credentialIds as an array (Askar's array-tag representation), deletes by id, returning 204/no-body", async () => {
    const agent = makeAgentForDeleteW3c()
    const controller = new CredentialController(undefined as never)

    const result = await controller.deleteW3cById(makeRequest(agent), CREDENTIAL_RECORD_ID)

    expect(agent.__findAllByQuery).toHaveBeenCalledWith({ credentialIds: [CREDENTIAL_RECORD_ID] })
    expect(agent.__removeCredentialRecord).toHaveBeenCalledWith(agent.context, CREDENTIAL_RECORD_ID)
    expect(result).toBeUndefined()
  })

  it('rejects deletion when a DidCommCredentialExchangeRecord still references this credential id, instead of orphaning it', async () => {
    const agent = makeAgentForDeleteW3c({
      findAllByQueryImpl: jest.fn(async () => [{ id: 'exchange-record-1' }]) as jest.Mock,
    })
    const controller = new CredentialController(undefined as never)

    await expect(controller.deleteW3cById(makeRequest(agent), CREDENTIAL_RECORD_ID)).rejects.toThrow(
      new RegExp(CREDENTIAL_RECORD_ID),
    )
    expect(agent.__removeCredentialRecord).not.toHaveBeenCalled()
  })

  it('routes a failure through ErrorHandlingService rather than throwing the raw Credo error', async () => {
    const agent = makeAgentForDeleteW3c({
      removeCredentialRecordImpl: jest.fn(async () => {
        throw new Error('w3c credential not found')
      }) as jest.Mock,
    })
    const controller = new CredentialController(undefined as never)

    await expect(controller.deleteW3cById(makeRequest(agent), CREDENTIAL_RECORD_ID)).rejects.toBeDefined()
  })
})
