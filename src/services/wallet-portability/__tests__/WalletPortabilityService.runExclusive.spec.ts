import { LogLevel } from '@credo-ts/core'
import { jest } from '@jest/globals'

import { TsLogger } from '../../../utils/logger'
import { WalletPortabilityJobStore } from '../WalletPortabilityJobStore'
import { WalletPortabilityService } from '../WalletPortabilityService'
import { WalletPortabilityJobConflictError } from '../WalletPortabilityTypes'

describe('WalletPortabilityService.runExclusive', () => {
  const logger = new TsLogger(LogLevel.error, 'test')
  let jobStore: WalletPortabilityJobStore
  let service: WalletPortabilityService

  beforeEach(() => {
    jobStore = new WalletPortabilityJobStore(logger)
    service = Object.create(WalletPortabilityService.prototype) as WalletPortabilityService
    ;(service as unknown as { jobStore: WalletPortabilityJobStore }).jobStore = jobStore
  })

  afterEach(async () => {
    await jobStore.disconnect()
  })

  it('returns the work result and frees the tenant slot afterwards', async () => {
    await expect(service.runExclusive('t1', async () => 'done')).resolves.toBe('done')
    await expect(jobStore.tryReserveActiveJob('t1', 'next')).resolves.toBeUndefined()
  })

  it('frees the slot when the work throws', async () => {
    await expect(
      service.runExclusive('t1', async () => {
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
    await expect(jobStore.tryReserveActiveJob('t1', 'next')).resolves.toBeUndefined()
  })

  it('refuses to run while another job holds the slot, and leaves that job in place', async () => {
    await jobStore.tryReserveActiveJob('t1', 'running-export')
    const work = jest.fn(async () => 'never')

    await expect(service.runExclusive('t1', work)).rejects.toBeInstanceOf(WalletPortabilityJobConflictError)

    expect(work).not.toHaveBeenCalled()
    await expect(jobStore.tryReserveActiveJob('t1', 'other')).resolves.toBe('running-export')
  })

  it('keeps tenants independent', async () => {
    await jobStore.tryReserveActiveJob('t1', 'running-export')

    await expect(service.runExclusive('t2', async () => 'ok')).resolves.toBe('ok')
  })
})
