/**
 * What TsLogger hands to OpenTelemetry: every level carries the OTLP severity number Loki and
 * Grafana read the level from, not only the text.
 */
import { jest } from '@jest/globals'

import { tracerMock, type EmittedRecord } from './loggerTestUtils'

const emitted: (EmittedRecord & { severityNumber?: number; severityText?: string })[] = []

jest.unstable_mockModule('../../tracer', () => tracerMock(emitted))

const { TsLogger } = await import('../logger')
const { LogLevel } = await import('@credo-ts/core')

describe('TsLogger OTLP export', () => {
  const previousFormat = process.env.LOG_FORMAT
  const stdout = process.stdout.write.bind(process.stdout)
  const stderr = process.stderr.write.bind(process.stderr)

  beforeAll(() => {
    process.env.LOG_FORMAT = 'json'
    process.stdout.write = (() => true) as typeof process.stdout.write
    process.stderr.write = (() => true) as typeof process.stderr.write
  })

  afterAll(() => {
    process.stdout.write = stdout
    process.stderr.write = stderr
    if (previousFormat === undefined) delete process.env.LOG_FORMAT
    else process.env.LOG_FORMAT = previousFormat
  })

  beforeEach(() => {
    emitted.length = 0
  })

  it('sets the OTLP severity number alongside the text for every level', () => {
    const logger = new TsLogger(LogLevel.test, 'otel-export-test')

    logger.trace('t')
    logger.debug('d')
    logger.info('i')
    logger.warn('w')
    logger.error('e')
    logger.fatal('f')

    // 1 TRACE, 5 DEBUG, 9 INFO, 13 WARN, 17 ERROR, 21 FATAL in the OTLP data model.
    expect(emitted.map((r) => [r.severityText, r.severityNumber])).toEqual([
      ['TRACE', 1],
      ['DEBUG', 5],
      ['INFO', 9],
      ['WARN', 13],
      ['ERROR', 17],
      ['FATAL', 21],
    ])
  })
})
