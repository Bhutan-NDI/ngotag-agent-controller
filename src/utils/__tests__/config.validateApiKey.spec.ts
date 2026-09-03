// yargs invokes coerce with null for an absent option, so falsy input has to be rejected too.
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

describe('toSerializableConfig', () => {
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
