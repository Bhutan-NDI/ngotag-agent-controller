import 'reflect-metadata'
import { CredoError } from '@credo-ts/core'
import { jest } from '@jest/globals'
import { StringCodec } from 'nats'

import { PURGE_CONSUMER_MAX_DELIVER } from '../PurgeConstants'
import { PurgeRecordType } from '../PurgeTypes'
import { PurgeWorker } from '../PurgeWorker'
import { CronPurgeScheduler } from '../schedulers/CronPurgeScheduler'

function fixture(error: Error, deliveryCount: number) {
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
  const withTenantAgent = jest.fn<() => Promise<void>>().mockRejectedValue(error)
  const agent = { config: { logger }, modules: { tenants: { withTenantAgent } } }
  const msg = {
    data: StringCodec().encode(
      JSON.stringify({
        recordId: 'record',
        recordType: PurgeRecordType.DIDCOMM_PROOF,
        tenantId: 'tenant',
        agentMode: 'shared',
      }),
    ),
    info: { deliveryCount },
    ack: jest.fn(),
    nak: jest.fn(),
  }
  const worker = new PurgeWorker(PurgeRecordType.DIDCOMM_PROOF, 'test')
  return { msg, logger, run: () => (worker as any).processMessage(msg, agent) }
}

const capacityError = () => Object.assign(new CredoError('capacity'), { code: 'TENANT_SESSION_CAPACITY_UNAVAILABLE' })

it.each([
  [1, 5000],
  [2, 30000],
])('backs off admission rejection on delivery %s', async (delivery, delay) => {
  const f = fixture(capacityError(), delivery)
  await f.run()
  expect(f.msg.nak).toHaveBeenCalledWith(delay)
  expect(f.msg.ack).not.toHaveBeenCalled()
})

it('does not acknowledge an unprocessed job when capacity retries are exhausted', async () => {
  const f = fixture(capacityError(), PURGE_CONSUMER_MAX_DELIVER)
  await f.run()
  expect(f.msg.ack).not.toHaveBeenCalled()
  expect(f.msg.nak).not.toHaveBeenCalled()
  expect(f.logger.error).toHaveBeenCalledWith(expect.stringContaining('operator recovery'), expect.any(Object))
})

it('retains the existing terminal policy for ordinary failures', async () => {
  const f = fixture(new Error('ordinary failure'), PURGE_CONSUMER_MAX_DELIVER)
  await f.run()
  expect(f.msg.ack).toHaveBeenCalledTimes(1)
})

it('defers saturated cron tenants separately and continues scanning other tenants', async () => {
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
  const withTenantAgent = jest
    .fn<() => Promise<void>>()
    .mockRejectedValueOnce(capacityError())
    .mockRejectedValueOnce(new Error('wallet failure'))
  const agent = {
    config: { logger },
    modules: {
      tenants: {
        getAllTenants: async () => [{ id: 'busy' }, { id: 'broken' }],
        withTenantAgent,
      },
    },
  }
  await (new CronPurgeScheduler() as any).runScan(agent, { cronConfig: { dryRun: true } }, undefined)
  expect(withTenantAgent).toHaveBeenCalledTimes(2)
  expect(logger.info).toHaveBeenLastCalledWith(
    '[Purge] Cron scan completed',
    expect.objectContaining({
      tenantsDeferred: 1,
      tenantsFailed: 1,
      tenantsProcessed: 0,
    }),
  )
})
