import { RecordNotFoundError } from '@credo-ts/core'
import { jest } from '@jest/globals'

import { NotFoundError } from '../../../errors/errors'

const collect = jest.fn<(...args: unknown[]) => Promise<unknown>>()
jest.unstable_mockModule('../../../services/endpoint-schemes/endpointSchemes', () => ({
  collectEndpointSchemes: collect,
}))

const { MultiTenancyController } = await import('../MultiTenancyController')

describe('MultiTenancyController.getEndpointSchemes', () => {
  const tenantAgent = { id: 'tenant-agent' }
  const buildRequest = (getTenantById = jest.fn<() => Promise<unknown>>().mockResolvedValue({})) => {
    const withTenantAgent = jest.fn(async (_options: unknown, work: (a: unknown) => Promise<unknown>) =>
      work(tenantAgent),
    )
    return {
      request: { agent: { modules: { tenants: { getTenantById, withTenantAgent } } } } as never,
      withTenantAgent,
    }
  }

  beforeEach(() => {
    collect.mockReset().mockResolvedValue({ tenantId: 't1', didsScanned: 1, unresolvedDids: 0, schemes: [] })
  })

  it('scans the DIDs of the tenant named in the path, opened as that tenant', async () => {
    const { request, withTenantAgent } = buildRequest()

    const result = await new MultiTenancyController().getEndpointSchemes(request, 't1')

    expect(withTenantAgent).toHaveBeenCalledWith({ tenantId: 't1' }, expect.any(Function))
    expect(collect).toHaveBeenCalledWith(tenantAgent, 't1')
    expect(result).toMatchObject({ tenantId: 't1' })
  })

  it('answers 404 for an unknown tenant without scanning anything', async () => {
    const { request } = buildRequest(
      jest
        .fn<() => Promise<unknown>>()
        .mockRejectedValue(new RecordNotFoundError('no tenant', { recordType: 'TenantRecord' })),
    )

    const error = await new MultiTenancyController().getEndpointSchemes(request, 't1').catch((e: unknown) => e)

    expect(error).toBeInstanceOf(NotFoundError)
    expect(collect).not.toHaveBeenCalled()
  })
})
