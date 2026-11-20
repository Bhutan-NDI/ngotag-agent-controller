// Shared helpers for the wallet tag-query plan benchmark. Targets only a disposable local
// PostgreSQL container on 127.0.0.1; see docs/wallet-tag-query-plans.md.
import 'reflect-metadata'
import '@openwallet-foundation/askar-nodejs'
import { AskarStorageService } from '@credo-ts/askar'
import { CacheModuleConfig } from '@credo-ts/core'
import { KdfMethod, Store, StoreKeyMethod } from '@openwallet-foundation/askar-shared'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
// Credo does not export its tag encoder; load the exact installed implementation so seeded rows
// carry the same tag names and values Credo writes.
const askarUtils = await import(
  pathToFileURL(require.resolve('@credo-ts/askar').replace(/index\.mjs$/, 'storage/utils.mjs')).href
)
export const { transformFromRecordTagValues } = askarUtils

export const BIG_PROFILE = 'tenant-big'
export const ROOT_PROFILE = 'root'

export function postgresUri(port, database, { cacheCapacity, maxConnections = 8 } = {}) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid local fixture port')
  if (!/^[a-z0-9_]+$/.test(database)) throw new Error('Invalid fixture database name')
  const params = [`max_connections=${maxConnections}`]
  if (cacheCapacity !== undefined) params.push(`statement-cache-capacity=${cacheCapacity}`)
  return `postgres://fixture@127.0.0.1:${port}/${database}?${params.join('&')}`
}

export async function openStore(uri, passKey) {
  return Store.open({ uri, keyMethod: new StoreKeyMethod(KdfMethod.Raw), passKey })
}

export async function provisionStore(uri) {
  const passKey = Store.generateRawKey()
  const store = await Store.provision({
    uri,
    keyMethod: new StoreKeyMethod(KdfMethod.Raw),
    passKey,
    recreate: true,
    profile: ROOT_PROFILE,
  })
  return { store, passKey }
}

/** A storage service bound to one Askar store, with one profile per context, as ProfilePerWallet uses. */
export function storageFor(store) {
  return new AskarStorageService({
    async getInitializedStoreWithProfile(context) {
      return { store, profile: context.contextCorrelationId }
    },
    async withSession(context, operation) {
      const session = await store.session(context.contextCorrelationId).open()
      try {
        return await operation(session)
      } finally {
        await session.close()
      }
    },
    async withTransaction(context, operation) {
      const session = await store.transaction(context.contextCorrelationId).open()
      try {
        const result = await operation(session)
        await session.commit()
        return result
      } catch (error) {
        await session.rollback()
        throw error
      }
    },
  })
}

export function contextFor(profile, resolve = () => undefined) {
  const cacheConfig = new CacheModuleConfig({ useCachedStorageService: false })
  return {
    contextCorrelationId: profile,
    dependencyManager: { isRegistered: () => false, resolve },
    resolve: (token) => (token === CacheModuleConfig ? cacheConfig : resolve(token)),
    config: { logger: { debug() {}, trace() {}, info() {}, warn() {}, error() {} } },
  }
}
