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
import { validateApiKey } from '../config'

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
