import 'reflect-metadata'
import { jest } from '@jest/globals'
import { StringCodec } from 'nats'

import { PurgeRecordType } from '../PurgeTypes'
import { PurgeWorker } from '../PurgeWorker'
import { CronPurgeScheduler } from '../schedulers/CronPurgeScheduler'

const tenantRecord = (id: string, migrated: boolean) => ({
  id,
  getTag: (name: string) => (name === 'migrated' ? migrated : undefined),
})

describe('purge skips migrated tenants', () => {
  it('does not open a migrated tenant in the cron scan but still scans the others', async () => {
    const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
    const withTenantAgent = jest.fn<() => Promise<void>>().mockResolvedValue(undefined)
    const agent = {
      config: { logger },
      modules: {
        tenants: {
          getAllTenants: async () => [tenantRecord('moved', true), tenantRecord('live', false)],
          withTenantAgent,
        },
      },
    }

    await (new CronPurgeScheduler() as any).runScan(agent, { cronConfig: { dryRun: true } }, undefined)

    expect(withTenantAgent).toHaveBeenCalledTimes(1)
    expect(withTenantAgent).toHaveBeenCalledWith({ tenantId: 'live' }, expect.any(Function))
  })

  const workerFixture = (migrated: boolean) => {
    const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
    const withTenantAgent = jest.fn<() => Promise<void>>().mockResolvedValue(undefined)
    const getTenantById = jest.fn<() => Promise<unknown>>().mockResolvedValue(tenantRecord('tenant', migrated))
    const agent = { config: { logger }, modules: { tenants: { withTenantAgent, getTenantById } } }
    const msg = {
      data: StringCodec().encode(
        JSON.stringify({
          recordId: 'record',
          recordType: PurgeRecordType.DIDCOMM_PROOF,
          tenantId: 'tenant',
          agentMode: 'shared',
        }),
      ),
      info: { deliveryCount: 1 },
      ack: jest.fn(),
      nak: jest.fn(),
    }
    const worker = new PurgeWorker(PurgeRecordType.DIDCOMM_PROOF, 'test')
    return { msg, withTenantAgent, run: () => (worker as any).processMessage(msg, agent) }
  }

  it('acknowledges a NATS purge job for a migrated tenant without opening the tenant', async () => {
    const f = workerFixture(true)

    await f.run()

    expect(f.withTenantAgent).not.toHaveBeenCalled()
    expect(f.msg.ack).toHaveBeenCalledTimes(1)
  })

  it('still processes a NATS purge job for a live tenant', async () => {
    const f = workerFixture(false)

    await f.run()

    expect(f.withTenantAgent).toHaveBeenCalledTimes(1)
  })
})
