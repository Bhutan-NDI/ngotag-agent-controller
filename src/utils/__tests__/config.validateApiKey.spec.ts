/**
 * Tests for the agent API key boot guard.
 *
 * An unset or empty API_KEY leaves dynamicApiKey '' (server.ts), which makes POST /agent/token - the
 * only apiKey-secured route, and the only way to mint an agent token - permanently unreachable on an
 * agent that otherwise boots clean and reports healthy. yargs invokes `coerce` with `null` when the
 * option is absent, so the guard has to reject falsy input as well as short input; `demandOption`
 * alone would still accept API_KEY=''.
 *
 * setupServer calls this too, so the library entry point (startServer) is covered by the same guard
 * rather than only the CLI - ServerConfig.apiKey is optional on the type because the event emitters
 * share that shape, so the runtime check is what actually closes that path.
 *
 * Runs under Jest ESM mode (see jest.config.base.ts).
 */
import yargs from 'yargs'

import { toSerializableConfig } from '../ServerConfig'
import { apiKeyOptionDefinition, validateApiKey } from '../config'

describe('validateApiKey', () => {
  const required = 'API key is required: set API_KEY to at least 16 characters'
  const tooShort = 'API key must be at least 16 characters long'

  it.each([
    ['null (yargs passes this when the option is absent)', null],
    ['undefined', undefined],
    ['empty string', ''],
    ['whitespace only', '   '],
  ])('rejects %s', (_label, input) => {
    expect(() => validateApiKey(input)).toThrow(required)
  })

  it('rejects a key below the 16 character minimum', () => {
    expect(() => validateApiKey('x'.repeat(15))).toThrow(tooShort)
  })

  it('accepts a key at the 16 character minimum', () => {
    expect(validateApiKey('x'.repeat(16))).toBe('x'.repeat(16))
  })

  it('trims before measuring, so padding cannot satisfy the minimum', () => {
    expect(() => validateApiKey(`  ${'x'.repeat(15)}  `)).toThrow(tooShort)
    expect(validateApiKey(`  ${'x'.repeat(16)}  `)).toBe('x'.repeat(16))
  })
})

describe('apiKey option, parsed by the real yargs', () => {
  // validateApiKey passing in isolation proves nothing if coerce is detached from the option, so
  // parse through the actual definition cli.ts uses.
  const parse = (argv: string[], envValue?: string): { apiKey?: string } => {
    const previous = process.env.API_KEY
    if (undefined === envValue) {
      delete process.env.API_KEY
    } else {
      process.env.API_KEY = envValue
    }
    try {
      return yargs(argv)
        .option('apiKey', apiKeyOptionDefinition())
        .exitProcess(false)
        .fail((message, error) => {
          throw new Error(message || error.message)
        })
        .parseSync() as { apiKey?: string }
    } finally {
      if (undefined === previous) {
        delete process.env.API_KEY
      } else {
        process.env.API_KEY = previous
      }
    }
  }

  it.each([
    ['absent (no flag, no env)', [] as string[], undefined],
    ['empty env value', [] as string[], ''],
    ['whitespace-only env value', [] as string[], '   '],
  ])('rejects %s', (_label, argv, envValue) => {
    expect(() => parse(argv, envValue)).toThrow('API key is required')
  })

  it('rejects a short value given on the command line', () => {
    expect(() => parse(['--apiKey', 'x'.repeat(15)])).toThrow('at least 16 characters')
  })

  it('accepts a valid value from the command line', () => {
    expect(parse(['--apiKey', 'x'.repeat(16)]).apiKey).toBe('x'.repeat(16))
  })

  it('accepts a valid value from API_KEY', () => {
    expect(parse([], 'y'.repeat(20)).apiKey).toBe('y'.repeat(20))
  })
})

describe('toSerializableConfig', () => {
  // setupServer writes its config to config.json; the key must not reach disk.
  it('drops apiKey', () => {
    const serialized = toSerializableConfig({ port: 3000, apiKey: 'x'.repeat(16) })

    expect(serialized).not.toHaveProperty('apiKey')
    expect(JSON.stringify(serialized)).not.toContain('x'.repeat(16))
  })

  it('keeps every other field', () => {
    const serialized = toSerializableConfig({
      port: 3000,
      cors: true,
      webhookUrl: 'http://localhost:5000/agent-events',
      schemaFileServerURL: 'https://schema.example.com',
      apiKey: 'x'.repeat(16),
    })

    expect(serialized).toEqual({
      port: 3000,
      cors: true,
      webhookUrl: 'http://localhost:5000/agent-events',
      schemaFileServerURL: 'https://schema.example.com',
    })
  })
})
