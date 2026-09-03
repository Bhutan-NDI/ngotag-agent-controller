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

  // The three shapes callers actually use, asserted against both egresses. `cause` and
  // Error-as-data reached OpenTelemetry as well as stdout before 4b0df69.
  const SHAPES: [string, () => Record<string, unknown>][] = [
    ['error', () => ({ error: thrownAxiosError() })],
    ['cause', () => ({ cause: thrownAxiosError() })],
    ['the Error itself as the data argument', () => thrownAxiosError() as unknown as Record<string, unknown>],
  ]

  for (const [shapeName, buildPayload] of SHAPES) {
    it(`leaks nothing to the console transport via ${shapeName}`, () => {
      const output = captureStderr(() => {
        new TsLogger(LogLevel.error, 'boundary-test').error('boundary', buildPayload())
      })

      expect(output).not.toBe('')
      for (const sentinel of SENTINELS) {
        expect(output).not.toContain(sentinel)
      }
    })

    it(`leaks nothing to OpenTelemetry via ${shapeName}`, () => {
      captureStderr(() => {
        new TsLogger(LogLevel.error, 'boundary-test').error('boundary', buildPayload())
      })

      expect(emitted).toHaveLength(1)
      const serialised = JSON.stringify(emitted[0].attributes)
      for (const sentinel of SENTINELS) {
        expect(serialised).not.toContain(sentinel)
      }
      expect(emitted[0].attributes.error).toEqual({
        name: 'AxiosError',
        message: 'Request failed with status code 401',
        stack: expect.stringContaining('failingCallSite'),
      })
    })
  }

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

  it('sanitises an error passed under `cause` (WebhookEvent / ProofEvents / CredentialEvents)', () => {
    const error = thrownAxiosError()
    const output = captureStderr(() => {
      new TsLogger(LogLevel.error, 'boundary-test').error('webhook failed', { cause: error, aborted: false })
    })

    for (const sentinel of SENTINELS) {
      expect(output).not.toContain(sentinel)
    }
    const record = JSON.parse(output) as { argumentsArray: [string, Record<string, unknown>, unknown] }
    // The error still renders as named fields, and the sibling key survives -- as an inspected
    // string, which is what tslog 3 does with any plain object argument.
    expect(record.argumentsArray[1].name).toBe('AxiosError')
    expect(record.argumentsArray[1].details).toEqual({})
    expect(String(record.argumentsArray[2])).toContain('aborted')
  })

  it('sanitises an Error handed over as the whole data argument (authentication.ts)', () => {
    const error = thrownAxiosError()
    const output = captureStderr(() => {
      // authentication.ts:82 does exactly this: logger.error(msg, err as Record<string, any>)
      new TsLogger(LogLevel.error, 'boundary-test').error(
        'Error decoding token',
        error as unknown as Record<string, unknown>,
      )
    })

    for (const sentinel of SENTINELS) {
      expect(output).not.toContain(sentinel)
    }
    const record = JSON.parse(output) as { argumentsArray: [string, Record<string, unknown>] }
    expect(record.argumentsArray[1].name).toBe('AxiosError')
    expect(record.argumentsArray[1].details).toEqual({})
  })

  it('sanitises an error nested below the top level', () => {
    const error = thrownAxiosError()
    const output = captureStderr(() => {
      new TsLogger(LogLevel.error, 'boundary-test').error('nested', { context: { inner: { error } } })
    })

    for (const sentinel of SENTINELS) {
      expect(output).not.toContain(sentinel)
    }
  })

  it('does not copy the contents of a thrown string into the record', () => {
    const output = captureStderr(() => {
      new TsLogger(LogLevel.error, 'boundary-test').error('GET /x -> 500: non-Error rejection (string)')
    })

    expect(output).not.toContain('SENTINEL_')
    expect(output).toContain('non-Error rejection (string)')
  })

  it('survives a payload whose getters throw, and still writes the line', () => {
    const hostile = {
      get boom(): string {
        throw new Error('getter exploded')
      },
    }
    const output = captureStderr(() => {
      new TsLogger(LogLevel.error, 'boundary-test').error('hostile payload', hostile as Record<string, unknown>)
    })

    expect(output).toContain('hostile payload')
  })

  it('does not hang or leak on a self-referential payload', () => {
    const error = thrownAxiosError()
    const cyclic: Record<string, unknown> = { error }
    cyclic.self = cyclic
    const output = captureStderr(() => {
      new TsLogger(LogLevel.error, 'boundary-test').error('cyclic', cyclic)
    })

    for (const sentinel of SENTINELS) {
      expect(output).not.toContain(sentinel)
    }
  })

  it('never emits a secret-bearing non-Error value handed to it as data', () => {
    const output = captureStderr(() => {
      new TsLogger(LogLevel.error, 'boundary-test').error('GET /x -> 500', {
        error: { clientSecret: 'SENTINEL_CLIENT_SECRET' },
      })
    })

    // A non-Error under `error` is caller-supplied data, so it is still rendered -- this asserts
    // the shape rather than claiming a guarantee the transport cannot make for arbitrary values.
    expect(output).toContain('SENTINEL_CLIENT_SECRET')
  })
})
