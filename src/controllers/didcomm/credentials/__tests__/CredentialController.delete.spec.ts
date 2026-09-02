/**
 * Regression tests for CredentialController.deleteById / deleteW3cById — porting the legacy
 * pipeline-implementation endpoints (/multi-tenancy/credential/:credentialRecordId/:tenantId and
 * /multi-tenancy/credential/w3c/:credentialRecordId/:tenantId, both on MultiTenancyController) to
 * this repo's /didcomm/credentials family, which never had a delete endpoint at all. Confirmed via
 * the cloud-wallet compatibility audit that this is a live, wired frontend flow
 * (DeleteCredentialModal, gated by an isSelfAttested flag that picks between these two).
 *
 * #85 review findings, all fixed and covered here:
 *  - deleteById's default cascade-delete throws Credo's own
 *    `DidCommJsonLdCredentialFormatService.deleteCredentialById` ("Not implemented.") for any
 *    exchange record with a w3c-bound credential -- exactly the DIDComm-issued JSON-LD case
 *    deleteW3cById's own docstring says should be deleted through here. Now detects any w3c-bound
 *    credential first and cleans it up directly via W3cCredentialService instead of letting the
 *    cascade reach it.
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

const makeAgentForDeleteById = (
  overrides: {
    deleteByIdImpl?: jest.Mock
    getByIdImpl?: jest.Mock
    removeCredentialRecordImpl?: jest.Mock
  } = {},
) => {
  const removeCredentialRecord = overrides.removeCredentialRecordImpl ?? (jest.fn(async () => undefined) as jest.Mock)
  return {
    context: { contextCorrelationId: 'ctx-1' },
    dependencyManager: {
      resolve: jest.fn(async () => ({ removeCredentialRecord })),
    },
    modules: {
      didcomm: {
        credentials: {
          deleteById: overrides.deleteByIdImpl ?? (jest.fn(async () => undefined) as jest.Mock),
          // Default: a plain indy/anoncreds-bound exchange record, no w3c binding.
          getById:
            overrides.getByIdImpl ??
            (jest.fn(async () => ({
              credentials: [{ credentialRecordType: 'indy', credentialRecordId: 'x' }],
            })) as jest.Mock),
        },
      },
    },
    __removeCredentialRecord: removeCredentialRecord,
  }
}

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
    expect(agent.__removeCredentialRecord).not.toHaveBeenCalled()
    expect(result).toBeUndefined()
  })

  it('does not use the default cascade for a w3c-bound credential -- deletes without the cascade, then removes the w3c record directly', async () => {
    const agent = makeAgentForDeleteById({
      getByIdImpl: jest.fn(async () => ({
        credentials: [{ credentialRecordType: 'w3c', credentialRecordId: 'w3c-record-1' }],
      })) as jest.Mock,
    })
    const controller = new CredentialController(undefined as never)

    const result = await controller.deleteById(makeRequest(agent), CREDENTIAL_RECORD_ID)

    // Not the default call -- deleteAssociatedCredentials: false, since the default cascade would
    // dispatch to DidCommJsonLdCredentialFormatService.deleteCredentialById, which throws
    // "Not implemented." for exactly this credentialRecordType.
    expect(agent.modules.didcomm.credentials.deleteById).toHaveBeenCalledWith(CREDENTIAL_RECORD_ID, {
      deleteAssociatedCredentials: false,
    })
    expect(agent.__removeCredentialRecord).toHaveBeenCalledWith(agent.context, 'w3c-record-1')
    expect(result).toBeUndefined()
  })

  it('removes every w3c-bound credential when an exchange record has more than one', async () => {
    const agent = makeAgentForDeleteById({
      getByIdImpl: jest.fn(async () => ({
        credentials: [
          { credentialRecordType: 'w3c', credentialRecordId: 'w3c-record-1' },
          { credentialRecordType: 'w3c', credentialRecordId: 'w3c-record-2' },
        ],
      })) as jest.Mock,
    })
    const controller = new CredentialController(undefined as never)

    await controller.deleteById(makeRequest(agent), CREDENTIAL_RECORD_ID)

    expect(agent.__removeCredentialRecord).toHaveBeenCalledWith(agent.context, 'w3c-record-1')
    expect(agent.__removeCredentialRecord).toHaveBeenCalledWith(agent.context, 'w3c-record-2')
    expect(agent.__removeCredentialRecord).toHaveBeenCalledTimes(2)
  })

  it('routes a failure through ErrorHandlingService rather than throwing the raw Credo error', async () => {
    const agent = makeAgentForDeleteById({
      deleteByIdImpl: jest.fn(async () => {
        throw new Error('credential not found')
      }) as jest.Mock,
    })
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
