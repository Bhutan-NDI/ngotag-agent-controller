import 'reflect-metadata'
import '@openwallet-foundation/askar-nodejs'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AskarStorageService } from '@credo-ts/askar'
import { CacheModuleConfig } from '@credo-ts/core'
import {
  DidCommProofExchangeRepository,
  DidCommProofExchangeRecord,
  DidCommProofState,
  DidCommProofRole,
  DidCommOutOfBandRepository,
  DidCommOutOfBandRecord,
  DidCommOutOfBandInvitation,
  DidCommOutOfBandState,
  DidCommOutOfBandRole,
} from '@credo-ts/didcomm'
import { KdfMethod, Store, StoreKeyMethod } from '@openwallet-foundation/askar-shared'

// Only synthetic, isolated local stores. No connection string or production credentials accepted.
export async function fixture(postgresPort) {
  if (postgresPort !== undefined && (!Number.isInteger(postgresPort) || postgresPort < 1 || postgresPort > 65535))
    throw new Error('Invalid local fixture port')
  const directory = await mkdtemp(join(tmpdir(), 'record-pages-'))
  const databaseName = `pages_fixture_${randomUUID().replaceAll('-', '')}`
  let store
  try {
    store = await Store.provision({
      uri:
        postgresPort === undefined
          ? `sqlite://${join(directory, 'wallet.db')}`
          : `postgres://fixture:fixture@127.0.0.1:${postgresPort}/${databaseName}?max_connections=8`,
      keyMethod: new StoreKeyMethod(KdfMethod.Raw),
      passKey: Store.generateRawKey(),
      recreate: false,
      profile: 'tenant-a',
    })
    await store.createProfile('tenant-b')
    const storage = new AskarStorageService({
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
    })
    const repositories = {
      proofs: new DidCommProofExchangeRepository(storage, { emit() {} }),
      oob: new DidCommOutOfBandRepository(storage, { emit() {} }),
    }
    function context(profile = 'tenant-a') {
      return {
        contextCorrelationId: profile,
        dependencyManager: { isRegistered: () => false },
        resolve: () => new CacheModuleConfig({ useCachedStorageService: false }),
      }
    }
    function record(kind, index) {
      return kind === 'proofs'
        ? new DidCommProofExchangeRecord({
            id: `proof-${index}`,
            threadId: `thread-${index % 2}`,
            state: DidCommProofState.Done,
            role: DidCommProofRole.Verifier,
            protocolVersion: 'v2',
          })
        : new DidCommOutOfBandRecord({
            id: `oob-${index}`,
            outOfBandInvitation: new DidCommOutOfBandInvitation({
              id: `invitation-${index % 2}`,
              label: 'synthetic',
              services: [],
            }),
            role: DidCommOutOfBandRole.Sender,
            state: DidCommOutOfBandState.Done,
          })
    }
    return {
      databaseName,
      store,
      repositories,
      context,
      async save(kind, index, profile) {
        const value = record(kind, index)
        await repositories[kind].save(context(profile), value)
        return value
      },
      async close() {
        try {
          await store.close()
        } finally {
          await rm(directory, { recursive: true, force: true })
        }
      },
    }
  } catch (error) {
    try {
      if (store) await store.close()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
    throw error
  }
}
