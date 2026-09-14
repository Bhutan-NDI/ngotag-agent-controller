import assert from 'node:assert/strict'
import { test } from 'node:test'
import { uriFromStoreConfig } from '../../../node_modules/@credo-ts/askar/build/utils/askarStoreConfig.mjs'

const config = {
  id: 'synthetic-wallet',
  database: {
    type: 'postgres',
    config: { host: 'localhost:5432', maxConnections: 4, connectTimeout: 5 },
    credentials: { account: 'synthetic-user', password: 'synthetic-password' },
  },
}
const withCapacity = (statementCacheCapacity) => ({
  ...config,
  database: { ...config.database, config: { ...config.database.config, statementCacheCapacity } },
})

test('omission preserves the existing URI and native cache default', () => {
  const uri = uriFromStoreConfig(config, '/tmp/synthetic').uri
  assert.equal(
    uri,
    'postgres://synthetic-user:synthetic-password@localhost:5432/synthetic-wallet?connect_timeout=5&max_connections=4',
  )
})
test('zero survives URI conversion; pool and timeout options survive too', () => {
  const uri = new URL(uriFromStoreConfig(withCapacity(0), '/tmp/synthetic').uri)
  assert.equal(uri.searchParams.get('statement-cache-capacity'), '0')
  assert.equal(uri.searchParams.get('max_connections'), '4')
  assert.equal(uri.searchParams.get('connect_timeout'), '5')
})
test('positive capacity supports restoring statement caching', () => {
  assert.equal(
    new URL(uriFromStoreConfig(withCapacity(100), '/tmp/synthetic').uri).searchParams.get('statement-cache-capacity'),
    '100',
  )
})
test('invalid programmatic values fail without including credential or input values', () => {
  for (const value of [-1, 0.5, NaN, Infinity, 10001, null, '0', 'synthetic-secret']) {
    assert.throws(() => uriFromStoreConfig(withCapacity(value), '/tmp/synthetic'), {
      message: 'Postgres statementCacheCapacity must be an integer from 0 through 10000',
    })
  }
})
test('SQLite URI behavior is unchanged', () => {
  assert.equal(
    uriFromStoreConfig({ id: 'synthetic', database: { type: 'sqlite', config: { inMemory: true } } }, '/tmp/synthetic')
      .uri,
    'sqlite://:memory:',
  )
})
