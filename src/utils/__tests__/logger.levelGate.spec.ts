/**
 * Locks the level gate in TsLogger.log. Credo makes most of its logger calls at debug/trace;
 * a disabled level must be dropped before the payload is sanitised, before tslog builds a
 * record and before OpenTelemetry is given anything (which would otherwise export it whatever
 * the configured level). LogLevel.off must be silent: tslog reads the undefined minLevel it maps
 * to as "log everything".
 *
 * Runs against the real tslog instance; only the OpenTelemetry logger is replaced.
 */
import { jest } from '@jest/globals'

const emitted: { body: unknown; attributes: Record<string, unknown> }[] = []

jest.unstable_mockModule('../../tracer', () => ({
  otelLogger: {
    emit: (record: { body: unknown; attributes: Record<string, unknown> }) => {
      emitted.push(record)
    },
  },
  otelLoggerProviderInstance: {},
  otelSDK: {},
}))

const { TsLogger } = await import('../logger')
const { LogLevel } = await import('@credo-ts/core')

type Level = 'test' | 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal'
const LEVELS: Level[] = ['test', 'trace', 'debug', 'info', 'warn', 'error', 'fatal']

/** tslog writes debug/info to stdout and warn/error to stderr; capture both. */
function captureOutput(run: () => void): string {
  const stdout = process.stdout.write.bind(process.stdout)
  const stderr = process.stderr.write.bind(process.stderr)
  let captured = ''
  const sink = ((chunk: string | Uint8Array): boolean => {
    captured += String(chunk)
    return true
  }) as typeof process.stdout.write
  process.stdout.write = sink
  process.stderr.write = sink
  try {
    run()
  } finally {
    process.stdout.write = stdout
    process.stderr.write = stderr
  }
  return captured
}

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
    process.env.LOG_FORMAT = previousFormat
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
})
