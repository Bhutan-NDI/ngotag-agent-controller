/**
 * The optional file sink is a second egress for the same log object, so it has to carry the same
 * sanitisation guarantee as stdout. It is opt-in via LOG_FILE_PATH and unset in every deployed
 * environment today, which is exactly why it is worth a test — nothing else would notice if it
 * started emitting raw errors.
 *
 * LOG_FILE_PATH is read at module scope, so this spec sets it before importing the logger and
 * lives in its own file rather than sharing a module registry with the stdout tests.
 */
import { jest } from '@jest/globals'
import { mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const logDir = mkdtempSync(join(tmpdir(), 'credo-logger-'))
const logFile = join(logDir, 'logs.txt')

process.env.LOG_FILE_PATH = logFile
process.env.LOG_FORMAT = 'json'

jest.unstable_mockModule('../../tracer', () => ({
  otelLogger: { emit: () => {} },
  otelLoggerProviderInstance: {},
  otelSDK: {},
}))

const { TsLogger } = await import('../logger')
const { LogLevel } = await import('@credo-ts/core')

class FakeAxiosError extends Error {
  public config = {
    headers: { Authorization: 'Bearer SENTINEL_BEARER_TOKEN' },
    data: JSON.stringify({ seed: 'SENTINEL_WALLET_SEED' }),
  }

  public constructor(message: string) {
    super(message)
    this.name = 'AxiosError'
  }
}

/**
 * The transport writes through a promise queue, so wait for this test's own line to land. The
 * file is truncated before each case, so "non-empty" unambiguously means the write completed --
 * otherwise a later case could assert against an earlier case's content and pass vacuously.
 */
async function flushOneLine(): Promise<string> {
  for (let attempt = 0; attempt < 40; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 25))
    try {
      const contents = readFileSync(logFile, 'utf8')
      if ('' !== contents.trim()) {
        return contents
      }
    } catch {
      // Not created yet.
    }
  }
  throw new Error('file transport never wrote a line')
}

describe('TsLogger file transport', () => {
  // Same three shapes as the console/OTel matrix -- the file sink is fed by the same log object.
  const SHAPES: [string, () => Record<string, unknown>][] = [
    ['error', () => ({ error: new FakeAxiosError('Request failed with status code 401') })],
    ['cause', () => ({ cause: new FakeAxiosError('Request failed with status code 401') })],
    [
      'the Error itself as the data argument',
      () => new FakeAxiosError('Request failed with status code 401') as unknown as Record<string, unknown>,
    ],
  ]

  beforeEach(() => {
    writeFileSync(logFile, '')
  })

  for (const [shapeName, buildPayload] of SHAPES) {
    it(`writes the sanitised error, never the raw one, via ${shapeName}`, async () => {
      const suppress = jest.spyOn(process.stderr, 'write').mockImplementation(() => true)
      try {
        new TsLogger(LogLevel.error, 'file-transport-test').error('POST /token -> 500: upstream failed', buildPayload())
      } finally {
        suppress.mockRestore()
      }

      const written = await flushOneLine()

      // Exactly this test's record, so the assertions below cannot pass on stale content.
      expect(written.trim().split('\n')).toHaveLength(1)
      expect(written).not.toContain('SENTINEL_BEARER_TOKEN')
      expect(written).not.toContain('SENTINEL_WALLET_SEED')
      // Still useful: the error is identifiable in the file.
      expect(written).toContain('Request failed with status code 401')
    })
  }
})
