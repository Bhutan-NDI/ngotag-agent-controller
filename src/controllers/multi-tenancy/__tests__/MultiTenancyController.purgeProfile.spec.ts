import { RecordNotFoundError } from '@credo-ts/core'
import { jest } from '@jest/globals'

import { ConflictError, NotFoundError } from '../../../errors/errors'
import { WalletPortabilityJobConflictError } from '../../../services/wallet-portability/WalletPortabilityTypes'

const purge = jest.fn<(...args: unknown[]) => Promise<unknown>>()
const runExclusive = jest.fn<(tenantId: string, work: () => Promise<unknown>) => Promise<unknown>>()

jest.unstable_mockModule('../../../services/tenant-purge/TenantProfilePurgeService', () => ({
  purgeTenantProfile: purge,
}))
jest.unstable_mockModule('../../../services/wallet-portability/WalletPortabilityService', () => ({
  getWalletPortabilityService: () => ({ runExclusive }),
}))

const { MultiTenancyController } = await import('../MultiTenancyController')

describe('MultiTenancyController.purgeProfile', () => {
  const agent = {}
  const request = { agent } as never

  beforeEach(() => {
    purge.mockReset().mockResolvedValue({ tenantId: 't1', migrated: true, profileRemoved: true })
    runExclusive.mockReset().mockImplementation((_tenantId, work) => work())
  })

  it('purges the tenant while holding its portability slot', async () => {
    const result = await new MultiTenancyController().purgeProfile(request, 't1')

    expect(result).toEqual({ tenantId: 't1', migrated: true, profileRemoved: true })
    expect(runExclusive).toHaveBeenCalledWith('t1', expect.any(Function))
    expect(purge).toHaveBeenCalledWith(agent, 't1')
  })

  it('answers 409 and purges nothing while an export or import is running', async () => {
    runExclusive.mockRejectedValue(new WalletPortabilityJobConflictError('t1', 'job-1'))

    const error = await new MultiTenancyController().purgeProfile(request, 't1').catch((e: unknown) => e)

    expect(error).toBeInstanceOf(ConflictError)
    expect(purge).not.toHaveBeenCalled()
  })

  it('answers 404 for an unknown tenant', async () => {
    purge.mockRejectedValue(new RecordNotFoundError('no tenant', { recordType: 'TenantRecord' }))

    const error = await new MultiTenancyController().purgeProfile(request, 't1').catch((e: unknown) => e)

    expect(error).toBeInstanceOf(NotFoundError)
  })
})
