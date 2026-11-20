/**
 * OTEL_LOGS_MIN_LEVEL floors what is exported over OTLP without touching the console output, so
 * debug logging can stay local. The level is read once when the module loads, hence its own spec.
 */
import { jest } from '@jest/globals'

import { tracerMock, type EmittedRecord } from './loggerTestUtils'

const emitted: EmittedRecord[] = []
process.env.OTEL_LOGS_MIN_LEVEL = 'warn'

jest.unstable_mockModule('../../tracer', () => tracerMock(emitted))

const { TsLogger } = await import('../logger')
const { LogLevel } = await import('@credo-ts/core')

describe('OTEL_LOGS_MIN_LEVEL', () => {
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
    delete process.env.OTEL_LOGS_MIN_LEVEL
  })

  it('exports only warn and above, while the console still gets everything the logger allows', () => {
    const logger = new TsLogger(LogLevel.debug, 'otel-min-level-test')

    logger.debug('quiet debug line')
    logger.info('quiet info line')
    logger.warn('loud warn line')
    logger.error('loud error line')

    expect(emitted.map((r) => r.body)).toEqual(['loud warn line', 'loud error line'])
    expect(written).toContain('quiet debug line')
    expect(written).toContain('quiet info line')
  })
})
