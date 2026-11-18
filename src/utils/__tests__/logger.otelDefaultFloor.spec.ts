/**
 * With OTEL_LOGS_MIN_LEVEL unset, only info and above are exported over OTLP. The controllers run at debug
 * (AFJ_REST_LOG_LEVEL=2), so exporting everything the logger lets through would send every debug line to
 * Loki; the console keeps them. The floor is read once when the module loads, hence its own spec.
 */
import { jest } from '@jest/globals'

import { tracerMock, type EmittedRecord } from './loggerTestUtils'

const emitted: EmittedRecord[] = []
delete process.env.OTEL_LOGS_MIN_LEVEL

jest.unstable_mockModule('../../tracer', () => tracerMock(emitted))

const { TsLogger } = await import('../logger')
const { LogLevel } = await import('@credo-ts/core')

describe('default OTLP export floor', () => {
  const stdout = process.stdout.write.bind(process.stdout)
  const stderr = process.stderr.write.bind(process.stderr)
  let written = ''

  beforeAll(() => {
    process.stdout.write = ((chunk: string | Uint8Array) => {
      written += String(chunk)
      return true
    }) as typeof process.stdout.write
    process.stderr.write = (() => true) as typeof process.stderr.write
  })

  afterAll(() => {
    process.stdout.write = stdout
    process.stderr.write = stderr
  })

  it('exports info and above, and keeps debug on the console only, at a controller running in debug', () => {
    const logger = new TsLogger(LogLevel.debug, 'otel-default-floor-test')

    logger.trace('t-line')
    logger.debug('debug-line')
    logger.info('info-line')
    logger.warn('warn-line')

    expect(emitted.map((r) => r.body)).toEqual(['info-line', 'warn-line'])
    expect(written).toContain('debug-line')
  })
})
