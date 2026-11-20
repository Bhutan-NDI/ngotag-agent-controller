/**
 * The graceful shutdown has one overall bound, under ECS's 30s stop timeout, so a step that never returns
 * cannot hold the task until it is killed.
 */
import { jest } from '@jest/globals'

import { armShutdownDeadline, DEFAULT_SHUTDOWN_TIMEOUT_MS, shutdownTimeoutMs } from '../shutdownDeadline'

describe('shutdownTimeoutMs', () => {
  it('defaults to a bound under ECS’s 30s stop timeout', () => {
    expect(shutdownTimeoutMs({})).toBe(DEFAULT_SHUTDOWN_TIMEOUT_MS)
    expect(DEFAULT_SHUTDOWN_TIMEOUT_MS).toBeLessThan(30_000)
  })

  it('takes SHUTDOWN_TIMEOUT_MS when it is a positive number', () => {
    expect(shutdownTimeoutMs({ SHUTDOWN_TIMEOUT_MS: '12000' })).toBe(12_000)
  })

  it.each(['', '0', '-5', 'soon', 'NaN'])('ignores %p and falls back to the default', (value) => {
    expect(shutdownTimeoutMs({ SHUTDOWN_TIMEOUT_MS: value })).toBe(DEFAULT_SHUTDOWN_TIMEOUT_MS)
  })
})

describe('armShutdownDeadline', () => {
  beforeEach(() => jest.useFakeTimers())
  afterEach(() => jest.useRealTimers())

  it('calls back once the time has run out', () => {
    const onExpire = jest.fn()
    armShutdownDeadline(25_000, onExpire)

    jest.advanceTimersByTime(24_999)
    expect(onExpire).not.toHaveBeenCalled()
    jest.advanceTimersByTime(1)
    expect(onExpire).toHaveBeenCalledTimes(1)
  })

  it('does not call back once cancelled', () => {
    const onExpire = jest.fn()
    const cancel = armShutdownDeadline(25_000, onExpire)

    cancel()
    jest.advanceTimersByTime(60_000)

    expect(onExpire).not.toHaveBeenCalled()
  })
})
