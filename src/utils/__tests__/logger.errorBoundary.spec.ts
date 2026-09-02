/**
 * Locks the logging error boundary in place. Three behaviours, all of them regressions waiting
 * to happen:
 *
 *   1. Secret disclosure — HTTP and SSI libraries hang request state off their errors as
 *      *enumerable own properties* (an Axios error keeps `config.headers` and `config.data`).
 *      tslog copies every enumerable own property into `details` and `errorString`, so handing
 *      one straight to the transport writes credentials to stdout. TsLogger must sanitise.
 *
 *   2. The original stack must survive that sanitisation, or the fix trades one debugging
 *      problem for another.
 *
 *   3. OpenTelemetry must receive the same sanitised contract as the console transport — it is
 *      a second egress for the same object.
 *
 * The tslog instance is captured through the module's own constructor rather than stubbed, so
 * these assertions run against the real serialiser.
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

/** Shaped like a real AxiosError: message/stack non-enumerable, request state enumerable. */
class FakeAxiosError extends Error {
  public code = 'ERR_BAD_REQUEST'
  public config = {
    url: 'https://agent.example/multi-tenancy/token',
    headers: { Authorization: 'Bearer SENTINEL_BEARER_TOKEN' },
    data: JSON.stringify({ clientSecret: 'SENTINEL_CLIENT_SECRET', seed: 'SENTINEL_WALLET_SEED' }),
  }
  public response = { status: 401, data: { token: 'SENTINEL_RESPONSE_TOKEN' } }

  public constructor(message: string) {
    super(message)
    this.name = 'AxiosError'
  }
}

const SENTINELS = ['SENTINEL_BEARER_TOKEN', 'SENTINEL_CLIENT_SECRET', 'SENTINEL_WALLET_SEED', 'SENTINEL_RESPONSE_TOKEN']

/** tslog writes error-level records to stderr, not stdout. */
function captureStderr(run: () => void): string {
  const original = process.stderr.write.bind(process.stderr)
  let captured = ''
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    captured += String(chunk)
    return true
  }) as typeof process.stderr.write
  try {
    run()
  } finally {
    process.stderr.write = original
  }
  return captured
}

function thrownAxiosError(): FakeAxiosError {
  function failingCallSite(): never {
    throw new FakeAxiosError('Request failed with status code 401')
  }
  try {
    failingCallSite()
  } catch (error) {
    return error as FakeAxiosError
  }
}

describe('TsLogger error boundary', () => {
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

  it('does not write any enumerable property of the error to the console transport', () => {
    const error = thrownAxiosError()
    const output = captureStderr(() => {
      new TsLogger(LogLevel.error, 'boundary-test').error('POST /token -> 500: upstream failed', { error })
    })

    expect(output).not.toBe('')
    for (const sentinel of SENTINELS) {
      expect(output).not.toContain(sentinel)
    }
  })

  it('keeps name, message and the original stack after sanitisation', () => {
    const error = thrownAxiosError()
    const output = captureStderr(() => {
      new TsLogger(LogLevel.error, 'boundary-test').error('POST /token -> 500: upstream failed', { error })
    })

    const record = JSON.parse(output) as { argumentsArray: [string, Record<string, unknown>] }
    const logged = record.argumentsArray[1]

    expect(logged.name).toBe('AxiosError')
    expect(logged.message).toBe('Request failed with status code 401')
    // The whole point of preserving `cause`: the throw site is still identifiable.
    expect(String(logged.errorString)).toContain('failingCallSite')
    // Empty `details` is what proves the enumerable properties were dropped.
    expect(logged.details).toEqual({})
  })

  it('emits named fields rather than one inspected blob', () => {
    const error = thrownAxiosError()
    const output = captureStderr(() => {
      new TsLogger(LogLevel.error, 'boundary-test').error('boom', { error })
    })

    const record = JSON.parse(output) as { argumentsArray: [string, unknown] }
    expect(typeof record.argumentsArray[1]).toBe('object')
  })

  it('gives OpenTelemetry the same sanitised error, never the raw object', () => {
    const error = thrownAxiosError()
    captureStderr(() => {
      new TsLogger(LogLevel.error, 'boundary-test').error('boom', { error, statusCode: 500 })
    })

    expect(emitted).toHaveLength(1)
    const attributes = emitted[0].attributes
    expect(attributes.statusCode).toBe(500)
    expect(attributes.error).toEqual({
      name: 'AxiosError',
      message: 'Request failed with status code 401',
      stack: expect.stringContaining('failingCallSite'),
    })
    expect(JSON.stringify(attributes)).not.toContain('SENTINEL_')
  })

  it('renders a thrown non-Error without emitting the object itself', () => {
    const rejection = { clientSecret: 'SENTINEL_CLIENT_SECRET' }
    const output = captureStderr(() => {
      new TsLogger(LogLevel.error, 'boundary-test').error('GET /x -> 500: non-Error rejection', {
        error: rejection,
      })
    })

    expect(output).not.toContain('SENTINEL_CLIENT_SECRET')
    expect(output).toContain('[object Object]')
  })
})
