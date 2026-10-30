import 'reflect-metadata'
import '@openwallet-foundation/askar-nodejs'
import type { Leasing } from '../../services/did-rotation/RotationLease'

import { jest } from '@jest/globals'
import { KdfMethod, Store, StoreKeyMethod } from '@openwallet-foundation/askar-shared'

import { RotationLease } from '../../services/did-rotation/RotationLease'
import { CronPurgeScheduler, PURGE_LEASE_RENEW_MS } from '../schedulers/CronPurgeScheduler'

const PROFILE = 'purge-lease-test'
const config = { cronConfig: { dryRun: true } } as any

const tenant = (id: string) => ({ id, getTag: () => undefined })

const sharedAgent = (withTenantAgent: (...args: unknown[]) => Promise<void>, tenantIds = ['t1']) => {
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
  const agent = {
    config: { logger },
    modules: { tenants: { getAllTenants: async () => tenantIds.map(tenant), withTenantAgent } },
  } as any
  return { agent, logger }
}

describe('CronPurgeScheduler lease (real Askar store)', () => {
  let store: Store
  let lease: RotationLease

  beforeEach(async () => {
    store = await Store.provision({
      uri: 'sqlite://:memory:',
      keyMethod: new StoreKeyMethod(KdfMethod.Raw),
      passKey: Store.generateRawKey(),
      recreate: true,
      profile: PROFILE,
    })
    lease = new RotationLease(async () => ({ store, profile: PROFILE }), 'PurgeCronLease')
  })

  afterEach(async () => {
    await store.close().catch(() => undefined)
  })

  it('lets only one of two tasks scan when both fire the same tick, and the other scan the next one', async () => {
    let finishScan!: () => void
    const scanning = new Promise<void>((resolve) => (finishScan = resolve))
    const withTenantAgent = jest.fn(() => scanning)
    const oldTask = sharedAgent(withTenantAgent)
    const newTask = sharedAgent(withTenantAgent)
    const oldScheduler = new CronPurgeScheduler(() => lease)
    const newScheduler = new CronPurgeScheduler(() => lease)

    const ticks = [
      oldScheduler.tick(oldTask.agent, config, undefined),
      newScheduler.tick(newTask.agent, config, undefined),
    ]
    // The skipped tick returns at once; the bound only stops a regression (both scanning) hanging the test.
    await Promise.race([...ticks, new Promise((resolve) => setTimeout(resolve, 2000))])
    finishScan()
    await Promise.all(ticks)

    expect(withTenantAgent).toHaveBeenCalledTimes(1)
    const skipped = [oldTask, newTask].filter(({ logger }) =>
      logger.info.mock.calls.some(([message]) => String(message).includes('Another task is running the cron scan')),
    )
    expect(skipped).toHaveLength(1)

    await newScheduler.tick(newTask.agent, config, undefined)
    await oldScheduler.tick(oldTask.agent, config, undefined)
    expect(withTenantAgent).toHaveBeenCalledTimes(3)
  })
})

describe('CronPurgeScheduler lease failures', () => {
  afterEach(() => {
    jest.useRealTimers()
  })

  it('skips the tick when the lease cannot be read, and scans on the next one', async () => {
    const withTenantAgent = jest.fn(async () => undefined)
    const { agent, logger } = sharedAgent(withTenantAgent)
    const failing: Leasing = {
      acquire: jest
        .fn<Leasing['acquire']>()
        .mockRejectedValueOnce(new Error('database is down'))
        .mockResolvedValue(true),
      release: jest.fn<Leasing['release']>().mockResolvedValue(undefined),
    }
    const scheduler = new CronPurgeScheduler(() => failing)

    await scheduler.tick(agent, config, undefined)
    expect(withTenantAgent).not.toHaveBeenCalled()
    expect(logger.error).toHaveBeenCalledWith('[Purge] Cron scan error', { error: 'database is down' })

    await scheduler.tick(agent, config, undefined)
    expect(withTenantAgent).toHaveBeenCalledTimes(1)
  })

  it('stops a shared-agent scan before the next tenant once another task has taken the lease', async () => {
    jest.useFakeTimers()
    const withTenantAgent = jest.fn(async () => {
      // The scan of this tenant outlasts a renewal, which finds the lease taken.
      await jest.advanceTimersByTimeAsync(PURGE_LEASE_RENEW_MS)
    })
    const { agent, logger } = sharedAgent(withTenantAgent, ['t1', 't2'])
    const takenOver: Leasing = {
      acquire: jest.fn<Leasing['acquire']>().mockResolvedValueOnce(true).mockResolvedValue(false),
      release: jest.fn<Leasing['release']>().mockResolvedValue(undefined),
    }

    await new CronPurgeScheduler(() => takenOver).tick(agent, config, undefined)

    expect(withTenantAgent).toHaveBeenCalledTimes(1)
    expect(withTenantAgent).toHaveBeenCalledWith({ tenantId: 't1' }, expect.any(Function))
    expect(logger.warn).toHaveBeenCalledWith(
      '[Purge] Another task took over the cron scan lease — stopping this scan',
      expect.any(Object),
    )
    expect(takenOver.release).toHaveBeenCalledTimes(1)
  })
})
