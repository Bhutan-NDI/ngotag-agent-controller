/**
 * End-to-end regression for a non-`Error` rejection, exercised the way a controller actually
 * produces one: catch -> ErrorHandlingService.handle() -> createErrorHandler() -> real TsLogger.
 *
 * Testing the middleware branch in isolation missed this. The normal path converts first, and the
 * conversion used to interpolate the rejected value into `InternalServerError.message` and carry
 * the raw value forward as `cause` — so a secret-bearing thrown string reached the HTTP response,
 * the console record, the OpenTelemetry body and the file sink, none of which the direct-branch
 * test touched.
 *
 * LOG_FILE_PATH is read at module scope, so the file sink is enabled here before importing.
 */
import { jest } from '@jest/globals'
import { mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const logDir = mkdtempSync(join(tmpdir(), 'credo-e2e-'))
const logFile = join(logDir, 'logs.txt')
process.env.LOG_FILE_PATH = logFile
process.env.LOG_FORMAT = 'json'

const otelRecords: { body: unknown; attributes: Record<string, unknown> }[] = []

jest.unstable_mockModule('../tracer', () => ({
  otelLogger: {
    emit: (record: { body: unknown; attributes: Record<string, unknown> }) => {
      otelRecords.push(record)
    },
  },
  otelLoggerProviderInstance: {},
  otelSDK: {},
}))

const ErrorHandlingService = (await import('../errorHandlingService')).default
const { createErrorHandler } = await import('../errorHandler')
const { TsLogger } = await import('../utils/logger')
const { LogLevel } = await import('@credo-ts/core')

const SENTINEL = 'SENTINEL_UPSTREAM_BEARER_TOKEN'

function makeRes(): { res: unknown; captured: { status?: number; body?: unknown } } {
  const captured: { status?: number; body?: unknown } = {}
  const res = {
    status(code: number) {
      captured.status = code
      return this
    },
    json(body: unknown) {
      captured.body = body
      return this
    },
  }
  return { res, captured }
}

async function readFileSink(): Promise<string> {
  for (let attempt = 0; attempt < 40; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 25))
    const contents = readFileSync(logFile, 'utf8')
    if ('' !== contents.trim()) {
      return contents
    }
  }
  throw new Error('file transport never wrote a line')
}

describe('non-Error rejection, controller path end to end', () => {
  let consoleOutput: string
  let captured: { status?: number; body?: unknown }

  beforeAll(async () => {
    writeFileSync(logFile, '')
    otelRecords.length = 0

    // 1. A dependency rejects with a string carrying a credential.
    let converted: unknown
    try {
      try {
        throw `upstream refused: ${SENTINEL}`
      } catch (error) {
        ErrorHandlingService.handle(error)
      }
    } catch (error) {
      converted = error
    }

    // 2. The Express handler turns it into a response and one log line.
    const original = process.stderr.write.bind(process.stderr)
    let stderr = ''
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      stderr += String(chunk)
      return true
    }) as typeof process.stderr.write

    const target = makeRes()
    captured = target.captured
    try {
      const handler = createErrorHandler(new TsLogger(LogLevel.error, 'e2e') as never) as unknown as (
        error: unknown,
        request: unknown,
        response: unknown,
        next: unknown,
      ) => Promise<void>
      await handler(converted, { method: 'POST', path: '/credentials' }, target.res, () => {})
    } finally {
      process.stderr.write = original
    }
    consoleOutput = stderr
  })

  it('does not return the rejected value to the caller', () => {
    expect(captured.status).toBe(500)
    expect(JSON.stringify(captured.body)).not.toContain(SENTINEL)
  })

  it('does not write the rejected value to the console transport', () => {
    expect(consoleOutput).not.toBe('')
    expect(consoleOutput).not.toContain(SENTINEL)
  })

  it('does not write the rejected value to the file transport', async () => {
    const written = await readFileSink()
    expect(written).not.toContain(SENTINEL)
  })

  it('does not send the rejected value to OpenTelemetry', () => {
    expect(otelRecords.length).toBeGreaterThan(0)
    expect(JSON.stringify(otelRecords)).not.toContain(SENTINEL)
  })

  it('still records the type, so the bad throw site remains findable', () => {
    expect(consoleOutput).toContain('(string)')
    expect(consoleOutput).toContain('/credentials')
  })

  it('keeps carrying a real Error forward, so the stack is not lost', () => {
    function realFailure(): never {
      throw new Error('Askar: wallet not found')
    }
    let converted: { cause?: unknown } | undefined
    try {
      try {
        realFailure()
      } catch (error) {
        ErrorHandlingService.handle(error)
      }
    } catch (error) {
      converted = error as { cause?: unknown }
    }

    expect(converted?.cause).toBeInstanceOf(Error)
    expect((converted?.cause as Error).stack).toContain('realFailure')
  })
})
