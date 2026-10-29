/**
 * Batched merge into a root profile, against real Askar stores (no mocks).
 */
import '@openwallet-foundation/askar-nodejs'
import { Key, KeyAlgorithm, KdfMethod, Store, StoreKeyMethod } from '@openwallet-foundation/askar-shared'
import { promises as fs } from 'fs'
import * as os from 'os'
import * as path from 'path'

import { mergeIntoRootProfile } from '../RootWalletMerge'
import { TargetNotPristineError } from '../WalletPortabilityTypes'

const SOURCE_PROFILE = 'tenant-source'
const TARGET_PROFILE = 'root-target'

describe('mergeIntoRootProfile', () => {
  let workDir: string
  const stores: Store[] = []

  const createStore = async (name: string, profile: string): Promise<Store> => {
    const store = await Store.provision({
      uri: `sqlite://${path.join(workDir, `${name}-${stores.length}.db`)}`,
      keyMethod: new StoreKeyMethod(KdfMethod.Raw),
      passKey: Store.generateRawKey(),
      recreate: true,
      profile,
    })
    stores.push(store)
    return store
  }

  // The artifact: `entries` records over three categories, a fresh-agent pair that must be skipped, and `keys` keys.
  const buildSource = async (entries: number, keys: number): Promise<Store> => {
    const store = await createStore('source', SOURCE_PROFILE)
    const session = await store.transaction(SOURCE_PROFILE).open()
    for (let i = 0; i < entries; i += 1) {
      await session.insert({
        category: `Category${i % 3}`,
        name: `record-${i}`,
        value: JSON.stringify({ i }),
        tags: { index: String(i), parity: 0 === i % 2 ? 'even' : 'odd' },
      })
    }
    await session.insert({ category: 'StorageVersionRecord', name: 'STORAGE_VERSION_RECORD_ID', value: '{}', tags: {} })
    await session.insert({
      category: 'GenericRecord',
      name: 'secret',
      value: JSON.stringify({ content: { secretKey: 'from-artifact' } }),
      tags: { hasSecretKey: 'true' },
    })
    for (let i = 0; i < keys; i += 1) {
      await session.insertKey({
        name: `key-${i}`,
        key: Key.generate(KeyAlgorithm.Ed25519),
        metadata: `meta-${i}`,
        tags: { slot: String(i) },
      })
    }
    await session.commit()
    return store
  }

  const buildTarget = async (...extras: { category: string; name: string }[]): Promise<Store> => {
    const store = await createStore('target', TARGET_PROFILE)
    const session = await store.transaction(TARGET_PROFILE).open()
    await session.insert({ category: 'StorageVersionRecord', name: 'STORAGE_VERSION_RECORD_ID', value: '{}', tags: {} })
    await session.insert({
      category: 'GenericRecord',
      name: 'secret',
      value: JSON.stringify({ content: { secretKey: 'target-secret' } }),
      tags: { hasSecretKey: 'true' },
    })
    for (const extra of extras) {
      await session.insert({ category: extra.category, name: extra.name, value: '{}', tags: {} })
    }
    await session.commit()
    return store
  }

  const read = async (store: Store, profile: string) => {
    const session = await store.session(profile).open()
    try {
      const entries = await session.fetchAll({})
      const keys = await session.fetchAllKeys({})
      const result = {
        entries: entries.map((entry) => ({ ...entry })),
        keys: keys.map((entry) => ({ name: entry.name, metadata: entry.metadata, tags: entry.tags })),
      }
      keys.forEach((entry) => entry.key.handle.free())
      return result
    } finally {
      await session.close()
    }
  }

  beforeEach(async () => {
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'root-merge-'))
  })

  afterEach(async () => {
    for (const store of stores.splice(0)) await store.close().catch(() => undefined)
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => undefined)
  })

  it.each([1, 2, 4, 1000])('merges every record and key with batch size %i', async (batchSize) => {
    const source = await buildSource(9, 5)
    const target = await buildTarget()

    const counts = await mergeIntoRootProfile({
      source,
      sourceProfile: SOURCE_PROFILE,
      target,
      targetProfile: TARGET_PROFILE,
      dryRun: false,
      batchSize,
    })

    expect(counts).toEqual({ entries: 9, keys: 5, skipped: 2 })
    const merged = await read(target, TARGET_PROFILE)
    expect(merged.entries).toHaveLength(9 + 2)
    const record4 = merged.entries.find((entry) => 'Category1' === entry.category && 'record-4' === entry.name)
    expect(record4).toMatchObject({ value: JSON.stringify({ i: 4 }), tags: { index: '4', parity: 'even' } })
    expect(merged.keys.map((entry) => entry.name).sort()).toEqual(['key-0', 'key-1', 'key-2', 'key-3', 'key-4'])
    expect(merged.keys.find((entry) => 'key-3' === entry.name)).toMatchObject({
      metadata: 'meta-3',
      tags: { slot: '3' },
    })
    const secret = merged.entries.find((entry) => 'GenericRecord' === entry.category)
    expect(JSON.parse(secret?.value as string).content.secretKey).toBe('target-secret')
  })

  it('merges an artifact that holds nothing but the fresh-agent records', async () => {
    const source = await buildSource(0, 0)
    const target = await buildTarget()

    await expect(
      mergeIntoRootProfile({
        source,
        sourceProfile: SOURCE_PROFILE,
        target,
        targetProfile: TARGET_PROFILE,
        dryRun: false,
      }),
    ).resolves.toEqual({ entries: 0, keys: 0, skipped: 2 })
  })

  it('dry run reports the counts but leaves the target untouched', async () => {
    const source = await buildSource(7, 3)
    const target = await buildTarget()
    const before = await read(target, TARGET_PROFILE)

    const counts = await mergeIntoRootProfile({
      source,
      sourceProfile: SOURCE_PROFILE,
      target,
      targetProfile: TARGET_PROFILE,
      dryRun: true,
      batchSize: 2,
    })

    expect(counts).toEqual({ entries: 7, keys: 3, skipped: 2 })
    expect(await read(target, TARGET_PROFILE)).toEqual(before)
  })

  it('rolls the whole target back when a write fails part-way through', async () => {
    const source = await buildSource(9, 4)
    const target = await buildTarget()
    const before = await read(target, TARGET_PROFILE)

    let inserts = 0
    const failingTarget = {
      transaction: (profile?: string) => ({
        open: async () => {
          const session = await target.transaction(profile).open()
          const insert = session.insert.bind(session)
          session.insert = async (options) => {
            inserts += 1
            if (5 === inserts) throw new Error('simulated write failure')
            return insert(options)
          }
          return session
        },
      }),
    } as unknown as Store

    await expect(
      mergeIntoRootProfile({
        source,
        sourceProfile: SOURCE_PROFILE,
        target: failingTarget,
        targetProfile: TARGET_PROFILE,
        dryRun: false,
        batchSize: 2,
      }),
    ).rejects.toThrow('simulated write failure')

    expect(await read(target, TARGET_PROFILE)).toEqual(before)
  })

  it('refuses a target that already holds data, without consuming the source', async () => {
    const source = await buildSource(5, 2)
    const target = await buildTarget({ category: 'ConnectionRecord', name: 'existing' })

    await expect(
      mergeIntoRootProfile({
        source,
        sourceProfile: SOURCE_PROFILE,
        target,
        targetProfile: TARGET_PROFILE,
        dryRun: false,
      }),
    ).rejects.toThrow(TargetNotPristineError)

    const remaining = await read(source, SOURCE_PROFILE)
    expect(remaining.entries).toHaveLength(5 + 2)
    expect(remaining.keys).toHaveLength(2)
  })

  it('names the kinds of record, and the number of keys, that stood in the way, and never their content', async () => {
    const source = await buildSource(1, 0)
    const target = await buildTarget(
      { category: 'ConnectionRecord', name: 'existing' },
      { category: 'DidRecord', name: 'did-1' },
    )

    const error = await mergeIntoRootProfile({
      source,
      sourceProfile: SOURCE_PROFILE,
      target,
      targetProfile: TARGET_PROFILE,
      dryRun: false,
    }).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(TargetNotPristineError)
    expect((error as TargetNotPristineError).categories).toEqual(['ConnectionRecord', 'DidRecord'])
    expect((error as TargetNotPristineError).keyCount).toBe(0)
    expect((error as TargetNotPristineError).message).toBe('TARGET_NOT_PRISTINE')
  })

  it('merges a few thousand records across many batches', async () => {
    const source = await buildSource(3000, 20)
    const target = await buildTarget()

    const counts = await mergeIntoRootProfile({
      source,
      sourceProfile: SOURCE_PROFILE,
      target,
      targetProfile: TARGET_PROFILE,
      dryRun: false,
      batchSize: 250,
    })

    expect(counts).toEqual({ entries: 3000, keys: 20, skipped: 2 })
    const merged = await read(target, TARGET_PROFILE)
    expect(merged.entries).toHaveLength(3000 + 2)
    expect(new Set(merged.entries.map((entry) => `${entry.category}/${entry.name}`)).size).toBe(3000 + 2)
    expect(merged.keys).toHaveLength(20)
  }, 120000)

  it('stops instead of looping when the source does not shrink after a batch', async () => {
    const source = await buildSource(6, 0)
    const target = await buildTarget()
    const stuckSource = {
      session: (profile?: string) => source.session(profile),
      transaction: (profile?: string) => ({
        open: async () => {
          const session = await source.transaction(profile).open()
          session.remove = async () => undefined
          return session
        },
      }),
    } as unknown as Store

    await expect(
      mergeIntoRootProfile({
        source: stuckSource,
        sourceProfile: SOURCE_PROFILE,
        target,
        targetProfile: TARGET_PROFILE,
        dryRun: false,
        batchSize: 2,
      }),
    ).rejects.toThrow('Source did not shrink')
    expect((await read(target, TARGET_PROFILE)).entries).toHaveLength(2)
  })

  it.each([0, -1, 1.5, Number.NaN])('rejects an invalid batch size (%p)', async (batchSize) => {
    const source = await buildSource(1, 0)
    const target = await buildTarget()

    await expect(
      mergeIntoRootProfile({
        source,
        sourceProfile: SOURCE_PROFILE,
        target,
        targetProfile: TARGET_PROFILE,
        dryRun: false,
        batchSize,
      }),
    ).rejects.toThrow('batchSize must be a positive integer')
  })
})
