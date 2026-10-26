import { jest } from '@jest/globals'

import { warnIfRelayEntriesExist } from '../relayRuntime'

describe('warnIfRelayEntriesExist', () => {
  const agentWith = (records: unknown[]) =>
    ({
      genericRecords: { findAllByQuery: jest.fn(async () => records) },
    }) as never

  it('says so when tenants have relay entries and the relay is off', async () => {
    const error = jest.fn<(message: string) => void>()

    await warnIfRelayEntriesExist(agentWith([{}, {}]), { error } as never)

    expect(error).toHaveBeenCalledTimes(1)
    expect(String(error.mock.calls[0][0])).toContain('2 tenant(s) have relay entries')
  })

  it('stays quiet when there are none', async () => {
    const error = jest.fn<(message: string) => void>()

    await warnIfRelayEntriesExist(agentWith([]), { error } as never)

    expect(error).not.toHaveBeenCalled()
  })
})
