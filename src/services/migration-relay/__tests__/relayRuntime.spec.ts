import { jest } from '@jest/globals'

import { warnIfRelayEntriesExist } from '../relayRuntime'

import { silentLogger } from './testSupport'

describe('warnIfRelayEntriesExist', () => {
  const agentWith = (records: unknown[]) =>
    ({
      genericRecords: { findAllByQuery: jest.fn(async () => records) },
    }) as never

  it('says so when tenants have relay entries and the relay is off', async () => {
    const logger = silentLogger()
    const error = jest.spyOn(logger, 'error')

    await warnIfRelayEntriesExist(agentWith([{}, {}]), logger)

    expect(error).toHaveBeenCalledTimes(1)
    expect(String(error.mock.calls[0][0])).toContain('2 tenant(s) have relay entries')
  })

  it('stays quiet when there are none', async () => {
    const logger = silentLogger()
    const error = jest.spyOn(logger, 'error')

    await warnIfRelayEntriesExist(agentWith([]), logger)

    expect(error).not.toHaveBeenCalled()
  })
})
