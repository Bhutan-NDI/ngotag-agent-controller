/**
 * Tests for the agent API key boot guard.
 *
 * An unset or empty API_KEY leaves dynamicApiKey '' (server.ts), which makes POST /agent/token - the
 * only apiKey-secured route, and the only way to mint an agent token - permanently unreachable on an
 * agent that otherwise boots clean and reports healthy. yargs invokes `coerce` with `null` when the
 * option is absent, so the guard has to reject falsy input as well as short input; `demandOption`
 * alone would still accept API_KEY=''.
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
