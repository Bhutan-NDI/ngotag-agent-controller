// Guards the apiKey assignment in the mapping, which is one property among many and easy to lose.
import type { Parsed } from '../cli.parser'

import { toAgentConfig } from '../cli.parser'

const API_KEY = 'x'.repeat(16)

const parsed = {
  label: 'test',
  'wallet-id': 'wallet-id',
  'wallet-key': 'wallet-key',
  'wallet-type': 'postgres',
  'wallet-url': 'localhost:5432',
  'wallet-account': 'account',
  'wallet-password': 'password',
  'wallet-admin-account': 'admin-account',
  'wallet-admin-password': 'admin-password',
  'admin-port': 3000,
  'webhook-url': 'http://localhost:5000/agent-events',
  tenancy: true,
  apiKey: API_KEY,
  updateJwtSecret: false,
} as unknown as Parsed

describe('toAgentConfig', () => {
  it('carries the API key through to the agent config', () => {
    expect(toAgentConfig(parsed).apiKey).toBe(API_KEY)
  })

  it('does not invent a key when none was parsed', () => {
    const withoutKey = toAgentConfig({ ...parsed, apiKey: undefined } as unknown as Parsed)

    expect(withoutKey.apiKey).toBeUndefined()
  })

  it('carries the other top-level settings through', () => {
    expect(toAgentConfig(parsed)).toMatchObject({
      label: 'test',
      adminPort: 3000,
      webhookUrl: 'http://localhost:5000/agent-events',
      tenancy: true,
      updateJwtSecret: false,
    })
  })

  it('maps the wallet credentials into the nested config the agent expects', () => {
    expect(toAgentConfig(parsed).walletConfig).toMatchObject({
      id: 'wallet-id',
      key: 'wallet-key',
      database: {
        type: 'postgres',
        config: { host: 'localhost:5432' },
        credentials: {
          account: 'account',
          password: 'password',
          adminAccount: 'admin-account',
          adminPassword: 'admin-password',
        },
      },
    })
  })
})

describe('PostgreSQL statement-cache mapping', () => {
  it.each([undefined, 0, 100, 10000])('preserves capacity %s', (capacity) => {
    expect(
      toAgentConfig({ ...parsed, 'wallet-postgres-statement-cache-capacity': capacity }).walletConfig,
    ).toMatchObject({
      database: { config: { statementCacheCapacity: capacity } },
    })
  })

  it.each([-1, 0.5, NaN, Infinity, 10001])('rejects invalid capacity %s', (capacity) => {
    expect(() => toAgentConfig({ ...parsed, 'wallet-postgres-statement-cache-capacity': capacity })).toThrow(
      'wallet-postgres-statement-cache-capacity must be an integer from 0 through 10000',
    )
  })
})

describe('PostgreSQL environment fallbacks', () => {
  const settings = [
    ['CONNECT_TIMEOUT', 'wallet-connect-timeout', 'connectTimeout'],
    ['MAX_CONNECTIONS', 'wallet-max-connections', 'maxConnections'],
    ['IDLE_TIMEOUT', 'wallet-idle-timeout', 'idleTimeout'],
  ] as const
  const original = Object.fromEntries(settings.map(([env]) => [env, process.env[env]]))

  afterEach(() => {
    for (const [env] of settings) {
      if (original[env] === undefined) delete process.env[env]
      else process.env[env] = original[env]
    }
  })

  it.each(settings)('omits unset or malformed %s instead of producing a NaN URI value', (env, _flag, property) => {
    for (const value of [undefined, '', '  ', 'not-a-number', 'NaN', 'Infinity', '-Infinity']) {
      if (value === undefined) delete process.env[env]
      else process.env[env] = value
      expect(toAgentConfig(parsed).walletConfig).toMatchObject({ database: { config: { [property]: undefined } } })
    }
  })

  it.each(settings)('uses numeric %s when the CLI option is absent', (env, _flag, property) => {
    for (const value of ['0', '12', ' 12 ']) {
      process.env[env] = value
      expect(toAgentConfig(parsed).walletConfig).toMatchObject({ database: { config: { [property]: Number(value) } } })
    }
  })

  it.each(settings)('gives explicit CLI values precedence over %s, including zero', (env, flag, property) => {
    process.env[env] = '12'
    for (const value of [0, 5]) {
      expect(toAgentConfig({ ...parsed, [flag]: value }).walletConfig).toMatchObject({
        database: { config: { [property]: value } },
      })
    }
  })
})
