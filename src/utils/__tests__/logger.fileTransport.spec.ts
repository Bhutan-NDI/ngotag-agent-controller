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
import { mkdtempSync, readFileSync } from 'fs'
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

/** The transport writes through a promise queue, so give it a turn to drain. */
async function flush(): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 25))
    try {
      if ('' !== readFileSync(logFile, 'utf8')) {
        return
      }
    } catch {
      // Not created yet.
    }
  }
}

describe('TsLogger file transport', () => {
  it('writes the sanitised error, never the raw one', async () => {
    const suppress = jest.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      new TsLogger(LogLevel.error, 'file-transport-test').error('POST /token -> 500: upstream failed', {
        error: new FakeAxiosError('Request failed with status code 401'),
      })
    } finally {
      suppress.mockRestore()
    }

    await flush()
    const written = readFileSync(logFile, 'utf8')

    expect(written).not.toBe('')
    expect(written).not.toContain('SENTINEL_BEARER_TOKEN')
    expect(written).not.toContain('SENTINEL_WALLET_SEED')
    // Still useful: the error is identifiable in the file.
    expect(written).toContain('Request failed with status code 401')
  })
})
