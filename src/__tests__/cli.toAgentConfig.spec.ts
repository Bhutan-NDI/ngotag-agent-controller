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
