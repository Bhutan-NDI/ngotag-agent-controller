/**
 * Regression tests for MultiTenancyController.getCloudWallet — ported from
 * pipeline-implementation's checkCloudWalletExists endpoint.
 *
 * Locks in the one real change from the legacy version: it must resolve the agent from
 * request.agent (the current develop convention, used by every other method on this
 * controller), not the legacy this.agent field, which no longer exists on this class.
 *
 * Runs under Jest's ESM mode (see jest.config.base.ts) — tsyringe is mocked so constructing
 * the controller does not require a real DI container.
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

type MockAgent = { modules: { tenants: { getTenantById: jest.Mock } } }

const makeAgent = (getTenantByIdImpl: jest.Mock): MockAgent => ({
  modules: { tenants: { getTenantById: getTenantByIdImpl } },
})

const makeRequest = (agent: MockAgent) => ({ agent }) as never

describe('MultiTenancyController.getCloudWallet', () => {
  it('uses request.agent, not a this.agent field, to look up the tenant', async () => {
    const getTenantById = jest.fn(async () => ({ id: 'tenant-1' })) as jest.Mock
    const agent = makeAgent(getTenantById)
    const controller = new MultiTenancyController()

    const result = await controller.getCloudWallet(makeRequest(agent), 'tenant-1')

    expect(getTenantById).toHaveBeenCalledWith('tenant-1')
    expect(result).toBe('Tenant exists')
  })

  it('returns 404 "Tenant does not exist" when the tenant is not found (falsy, not thrown)', async () => {
    const getTenantById = jest.fn(async () => undefined) as jest.Mock
    const agent = makeAgent(getTenantById)
    const controller = new MultiTenancyController()
    const setStatusSpy = jest.spyOn(controller, 'setStatus')

    const result = await controller.getCloudWallet(makeRequest(agent), 'missing-tenant')

    expect(result).toBe('Tenant does not exist')
    expect(setStatusSpy).toHaveBeenCalledWith(404)
  })

  it('propagates a RecordNotFoundError through ErrorHandlingService (converted to NotFoundError)', async () => {
    const { RecordNotFoundError } = await import('@credo-ts/core')
    const { NotFoundError } = await import('../../../errors')
    const getTenantById = jest.fn(async () => {
      throw new RecordNotFoundError('not found', { recordType: 'TenantRecord' })
    }) as jest.Mock
    const agent = makeAgent(getTenantById)
    const controller = new MultiTenancyController()

    await expect(controller.getCloudWallet(makeRequest(agent), 'missing-tenant')).rejects.toThrow(NotFoundError)
  })
})
