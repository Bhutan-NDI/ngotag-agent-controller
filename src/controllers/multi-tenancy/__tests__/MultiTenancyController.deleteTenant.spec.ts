import { RecordNotFoundError } from '@credo-ts/core'
import { jest } from '@jest/globals'

import { ConflictError } from '../../../errors/errors'
import { TENANT_HAS_RELAY } from '../../../services/tenant-purge/relayGuard'

const assertNoRelay = jest.fn<(...args: unknown[]) => Promise<void>>()

jest.unstable_mockModule('../../../services/tenant-purge/relayGuard', () => ({
  assertNoRelay,
  assertRelayForwarding: jest.fn(),
}))

const { MultiTenancyController } = await import('../MultiTenancyController')

describe('MultiTenancyController.deleteTenantById', () => {
  const deleteTenantById = jest.fn<(tenantId: string) => Promise<unknown>>()
  const agent = {
    modules: { tenants: { deleteTenantById } },
    dependencyManager: { resolve: () => ({ cache: { remove: jest.fn() } }) },
    context: {},
    config: { logger: { warn: jest.fn() } },
  }
  const request = { agent } as never
  const notFound = jest.fn()
  const serverError = jest.fn()

  beforeEach(() => {
    assertNoRelay.mockReset().mockResolvedValue(undefined)
    deleteTenantById.mockReset().mockResolvedValue(undefined)
    notFound.mockReset()
    serverError.mockReset()
  })

  it('deletes a tenant that has no relay', async () => {
    await new MultiTenancyController().deleteTenantById(request, 't1', notFound as never, serverError as never)

    expect(assertNoRelay).toHaveBeenCalledWith(agent, 't1')
    expect(deleteTenantById).toHaveBeenCalledWith('t1')
  })

  it('answers 409 and deletes nothing while the tenant has a relay', async () => {
    assertNoRelay.mockRejectedValue(new ConflictError(TENANT_HAS_RELAY))

    const error = await new MultiTenancyController()
      .deleteTenantById(request, 't1', notFound as never, serverError as never)
      .catch((e: unknown) => e)

    expect(error).toBeInstanceOf(ConflictError)
    expect((error as ConflictError).message).toBe(TENANT_HAS_RELAY)
    expect(deleteTenantById).not.toHaveBeenCalled()
    expect(serverError).not.toHaveBeenCalled()
  })

  it('still answers 404 for an unknown tenant', async () => {
    deleteTenantById.mockRejectedValue(new RecordNotFoundError('no tenant', { recordType: 'TenantRecord' }))

    await new MultiTenancyController().deleteTenantById(request, 't1', notFound as never, serverError as never)

    expect(notFound).toHaveBeenCalledWith(404, { reason: 'Tenant with id: t1 not found.' })
  })
})
