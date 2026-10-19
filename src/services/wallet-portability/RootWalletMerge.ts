import type { WalletImportCounts } from './WalletPortabilityTypes'
import type { EntryObject, KeyEntryObject, Session, Store } from '@openwallet-foundation/askar-shared'

import { TargetNotPristineError } from './WalletPortabilityTypes'

const STORAGE_VERSION_CATEGORY = 'StorageVersionRecord'
const GENERIC_RECORD_CATEGORY = 'GenericRecord'
const SECRET_KEY_TAG = 'hasSecretKey'

export const DEFAULT_MERGE_BATCH_SIZE = 1000

// What a freshly started agent writes into its root profile. The target's own copy is kept on a merge, so the
// artifact's equivalents are skipped: its JWT secret must not be overwritten, nor its storage version rewound.
const isFreshAgentRecord = (category: string, tags: Record<string, unknown>): boolean =>
  STORAGE_VERSION_CATEGORY === category || (GENERIC_RECORD_CATEGORY === category && undefined !== tags[SECRET_KEY_TAG])

export async function assertPristine(session: Session): Promise<void> {
  const entries = await session.fetchAll({})
  if (entries.some((entry) => !isFreshAgentRecord(entry.category, entry.tags))) {
    throw new TargetNotPristineError()
  }

  const keys = await session.fetchAllKeys({})
  for (const key of keys) key.key.handle.free()
  if (0 < keys.length) {
    throw new TargetNotPristineError()
  }
}

type SourceBatch<T> = { items: T[]; id: (item: T) => string; remove: (session: Session, item: T) => Promise<void> }

// Reads the source in bounded batches by removing each batch once the caller has taken it: Askar can only page
// within a named category and the categories cannot be listed, but a limited fetch with no category works and
// returns the next unread records once the previous ones are gone. The source is the job's own temporary copy, so
// consuming it is safe. A batch is only removed after `handle` has accepted it, in one source transaction.
async function drainSource<T>(
  source: Store,
  sourceProfile: string,
  fetch: (session: Session, limit: number) => Promise<SourceBatch<T>>,
  batchSize: number,
  handle: (items: T[]) => Promise<void>,
): Promise<number> {
  let processed = 0
  let previousFirstId: string | undefined

  for (;;) {
    const session = await source.transaction(sourceProfile).open()
    let finished = false
    try {
      const { items, id, remove } = await fetch(session, batchSize)
      if (0 === items.length) {
        await session.rollback()
        finished = true
        return processed
      }

      // A batch that starts where the last one did means the removal did not take effect: stop rather than loop.
      const firstId = id(items[0])
      if (firstId === previousFirstId) {
        throw new Error('Source did not shrink after a batch was merged')
      }
      previousFirstId = firstId

      await handle(items)
      for (const item of items) await remove(session, item)
      await session.commit()
      finished = true
      processed += items.length
    } finally {
      if (!finished) await session.rollback().catch(() => undefined)
    }
  }
}

/**
 * Merges every record and key of `sourceProfile` into the target's root profile in one target transaction, so the
 * merge is all-or-nothing. The source is read in batches and consumed as it goes (see drainSource). `dryRun` does
 * all the work and then rolls the target transaction back.
 */
export async function mergeIntoRootProfile(params: {
  source: Store
  sourceProfile: string
  target: Store
  targetProfile?: string
  dryRun: boolean
  batchSize?: number
}): Promise<WalletImportCounts> {
  const { source, sourceProfile, target, targetProfile, dryRun, batchSize = DEFAULT_MERGE_BATCH_SIZE } = params
  if (!Number.isInteger(batchSize) || 1 > batchSize) {
    throw new Error('batchSize must be a positive integer')
  }

  const countSession = await source.session(sourceProfile).open()
  let expectedEntries: number
  try {
    expectedEntries = await countSession.count({})
  } finally {
    await countSession.close()
  }

  const transaction = await target.transaction(targetProfile).open()
  try {
    await assertPristine(transaction)
    const baselineEntries = await transaction.count({})

    let inserted = 0
    let skipped = 0
    const entriesRead = await drainSource<EntryObject>(
      source,
      sourceProfile,
      async (session, limit) => ({
        items: await session.fetchAll({ limit, forUpdate: true }),
        id: (entry) => `${entry.category}/${entry.name}`,
        remove: (session, entry) => session.remove({ category: entry.category, name: entry.name }),
      }),
      batchSize,
      async (entries) => {
        for (const entry of entries) {
          if (isFreshAgentRecord(entry.category, entry.tags)) {
            skipped += 1
            continue
          }
          await transaction.insert({ category: entry.category, name: entry.name, value: entry.value, tags: entry.tags })
          inserted += 1
        }
      },
    )
    if (entriesRead !== expectedEntries) {
      throw new Error(`Read ${entriesRead} of ${expectedEntries} records from the artifact`)
    }

    let keys = 0
    await drainSource<KeyEntryObject>(
      source,
      sourceProfile,
      async (session, limit) => ({
        items: await session.fetchAllKeys({ limit, forUpdate: true }),
        id: (entry) => entry.name,
        remove: (session, entry) => session.removeKey({ name: entry.name }),
      }),
      batchSize,
      async (entries) => {
        try {
          for (const entry of entries) {
            await transaction.insertKey({
              name: entry.name,
              key: entry.key,
              metadata: entry.metadata ?? undefined,
              tags: entry.tags,
            })
            keys += 1
          }
        } finally {
          for (const entry of entries) entry.key.handle.free()
        }
      },
    )

    if ((await transaction.count({})) !== baselineEntries + inserted) {
      throw new Error('Target record count does not match what was merged')
    }

    if (dryRun) {
      await transaction.rollback()
    } else {
      await transaction.commit()
    }
    return { entries: inserted, keys, skipped }
  } catch (error) {
    await transaction.rollback().catch(() => undefined)
    throw error
  }
}
