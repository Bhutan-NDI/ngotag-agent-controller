/**
 * Locks the level gate in TsLogger.log: a disabled level is dropped before sanitising, rendering or
 * emitting, LogLevel.off is silent, and an invalid level falls back to info. Runs against the real
 * tslog; only OpenTelemetry is mocked.
 */
import { jest } from '@jest/globals'

import { captureOutput, tracerMock, type EmittedRecord } from './loggerTestUtils'

const emitted: EmittedRecord[] = []

jest.unstable_mockModule('../../tracer', () => tracerMock(emitted))

const { TsLogger } = await import('../logger')
const { LogLevel } = await import('@credo-ts/core')

type Level = 'test' | 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal'
const LEVELS: Level[] = ['test', 'trace', 'debug', 'info', 'warn', 'error', 'fatal']

/** A payload that records whether anything walked it (the sanitiser reads every own key). */
function observedPayload() {
  const reads = { count: 0 }
  const payload = Object.defineProperty({}, 'record', {
    enumerable: true,
    get() {
      reads.count++
      return { id: 'record-1' }
    },
  })
  return { payload, reads }
}

describe('TsLogger level gate', () => {
  const previousFormat = process.env.LOG_FORMAT

  beforeAll(() => {
    process.env.LOG_FORMAT = 'json'
  })

  afterAll(() => {
    if (previousFormat === undefined) delete process.env.LOG_FORMAT
    else process.env.LOG_FORMAT = previousFormat
  })

  beforeEach(() => {
    emitted.length = 0
  })

  it('drops levels below the configured one before sanitising, rendering or emitting', () => {
    const logger = new TsLogger(LogLevel.error, 'gate-test')
    const { payload, reads } = observedPayload()

    const output = captureOutput(() => {
      for (const level of ['test', 'trace', 'debug', 'info', 'warn'] as const) {
        logger[level](`dropped ${level}`, payload)
      }
    })

    expect(output).toBe('')
    expect(emitted).toHaveLength(0)
    expect(reads.count).toBe(0)
  })

  it('still renders and emits the configured level and above, with the payload', () => {
    const logger = new TsLogger(LogLevel.error, 'gate-test')
    const { payload, reads } = observedPayload()

    const output = captureOutput(() => {
      logger.error('kept error', payload)
      logger.fatal('kept fatal', payload)
    })

    expect(output).toContain('kept error')
    expect(output).toContain('kept fatal')
    expect(output).toContain('record-1')
    expect(emitted.map((record) => record.body)).toEqual(['kept error', 'kept fatal'])
    expect(reads.count).toBeGreaterThan(0)
  })

  it('treats the configured level as inclusive', () => {
    const logger = new TsLogger(LogLevel.warn, 'gate-test')

    const output = captureOutput(() => {
      logger.info('dropped info')
      logger.warn('kept warn')
    })

    expect(output).not.toContain('dropped info')
    expect(output).toContain('kept warn')
    expect(emitted.map((record) => record.body)).toEqual(['kept warn'])
  })

  it('is silent at every level when LogLevel.off is configured', () => {
    const logger = new TsLogger(LogLevel.off, 'gate-test')

    const output = captureOutput(() => {
      for (const level of LEVELS) {
        logger[level](`off ${level}`, { detail: 'x' })
      }
    })

    expect(output).toBe('')
    expect(emitted).toHaveLength(0)
  })

  it.each([9, -1, NaN])('falls back to info with a warning for an invalid level (%p)', (level) => {
    const output = captureOutput(() => {
      const logger = new TsLogger(level as ConstructorParameters<typeof TsLogger>[0], 'gate-test')
      logger.debug('dropped debug')
      logger.info('kept info')
      logger.error('kept error')
    })

    expect(output).toContain(`Invalid log level ${String(level)}; falling back to info`)
    expect(output).not.toContain('dropped debug')
    expect(output).toContain('kept info')
    expect(output).toContain('kept error')
  })
})
