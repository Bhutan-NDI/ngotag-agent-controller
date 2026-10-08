import 'reflect-metadata'
import '@openwallet-foundation/askar-nodejs'

import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { AskarStorageService } from '@credo-ts/askar'
import { CacheModuleConfig, GenericRecord, RecordDuplicateError, RecordNotFoundError, Repository } from '@credo-ts/core'
import { DidCommBasicMessage, DidCommMessageRepository, DidCommMessageRole } from '@credo-ts/didcomm'
import { askar } from '@openwallet-foundation/askar-nodejs'
import { Entry, KdfMethod, Scan, Store, StoreKeyMethod } from '@openwallet-foundation/askar-shared'

// Only disposable local SQLite files are used. No configured database, agent,
// environment file, cloud service, or production wallet is opened.
describe('bounded single-record query through the patched Credo repository and real Askar', () => {
  let directory
  let store
  let storage
  let repository
  let contexts
  let queries
  let cacheWrites

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'credo-single-query-'))
    store = await Store.provision({
      uri: `sqlite://${join(directory, 'wallet.db')}`,
      keyMethod: new StoreKeyMethod(KdfMethod.Raw),
      passKey: Store.generateRawKey(),
      recreate: false,
      profile: 'tenant-a',
    })
    await store.createProfile('tenant-b')
    queries = []
    cacheWrites = []
    contexts = new Map()

    storage = new AskarStorageService({
      async getInitializedStoreWithProfile(context) {
        return { store, profile: context.contextCorrelationId }
      },
      async withSession(context, callback) {
        const session = await store.session(context.contextCorrelationId).open()
        try {
          return await callback(session)
        } finally {
          await session.close()
        }
      },
    })
    const findByQuery = storage.findByQuery.bind(storage)
    storage.findByQuery = async (context, recordClass, query, options) => {
      const records = await findByQuery(context, recordClass, query, options)
      queries.push({ context, recordClass, query, options, returned: records.length })
      return records
    }
    repository = new Repository(GenericRecord, storage, { emit() {} })
  })

  afterEach(async () => {
    try {
      if (store) await store.close()
    } finally {
      if (directory) await rm(directory, { recursive: true, force: true })
      store = undefined
      directory = undefined
    }
  })

  function context(profile = 'tenant-a', useCachedStorageService = false) {
    if (contexts.has(profile)) return contexts.get(profile)
    const entries = new Map()
    const config = new CacheModuleConfig({
      useCachedStorageService,
      cache: {
        async get(_context, key) {
          return entries.get(key) ?? null
        },
        async set(_context, key, value) {
          entries.set(key, value)
          cacheWrites.push(key)
        },
      },
    })
    const result = {
      contextCorrelationId: profile,
      dependencyManager: { isRegistered: () => false },
      resolve(token) {
        assert.equal(token, CacheModuleConfig)
        return config
      },
    }
    contexts.set(profile, result)
    return result
  }

  async function insert(id, tags, target = context(), targetRepository = repository) {
    const record = new targetRepository.recordClass({ id, tags, content: { message: `fixture-${id}` } })
    await targetRepository.save(target, record)
    return record
  }

  it('preserves null and RecordNotFoundError for missing records', async () => {
    assert.equal(await repository.findSingleByQuery(context(), { threadId: 'absent' }), null)
    await assert.rejects(repository.getSingleByQuery(context(), { threadId: 'absent' }), RecordNotFoundError)
    assert.deepEqual(
      queries.map((q) => q.returned),
      [0, 0],
    )
    assert.ok(queries.every((q) => q.options.limit === 2))
  })

  it('returns the complete typed record, tags, dates and content for a unique match', async () => {
    const expected = await insert('unique', { threadId: 'thread', role: 'receiver' })
    const query = Object.freeze({ threadId: 'thread', role: 'receiver' })
    const result = await repository.findSingleByQuery(context(), query)
    assert.ok(result instanceof GenericRecord)
    assert.deepEqual(result.toJSON(), expected.toJSON())
    assert.equal(queries[0].query, query)
    assert.equal(queries[0].context, context())
    assert.deepEqual(queries[0].options, { limit: 2 })
    assert.equal((await repository.getSingleByQuery(context(), query)).id, expected.id)
  })

  for (const count of [2, 64]) {
    it(`still rejects ${count} duplicate matches, materializing only two`, async () => {
      for (let index = 0; index < count; index++) await insert(`duplicate-${index}`, { threadId: 'shared' })
      const query = { threadId: 'shared' }
      // This control proves the fixture really has more matches, not a mock that
      // merely claims a limit was passed. List queries must remain unbounded.
      assert.equal((await repository.findByQuery(context(), query)).length, count)
      queries.length = 0
      await assert.rejects(repository.findSingleByQuery(context(), query), RecordDuplicateError)
      await assert.rejects(repository.getSingleByQuery(context(), query), RecordDuplicateError)
      assert.deepEqual(
        queries.map((q) => q.returned),
        [2, 2],
      )
    })
  }

  it('retains profile and category isolation even with identical IDs and tags', async () => {
    const tags = { associatedRecordId: 'exchange', role: 'receiver' }
    await insert('same-id', tags)
    await insert('same-id', tags, context('tenant-b'))
    await insert('second-in-b', tags, context('tenant-b'))
    class OtherRecord extends GenericRecord {
      static type = 'OtherRecord'
      type = OtherRecord.type
    }
    const otherRepository = new Repository(OtherRecord, storage, { emit() {} })
    await insert('other-category', tags, context(), otherRepository)
    assert.equal((await repository.findSingleByQuery(context(), tags)).id, 'same-id')
    await assert.rejects(repository.findSingleByQuery(context('tenant-b'), tags), RecordDuplicateError)
    assert.equal((await otherRepository.findSingleByQuery(context(), tags)).id, 'other-category')
  })

  it('preserves compound tag predicates and detects duplicates for an empty query', async () => {
    await insert('request', { associatedRecordId: 'exchange', messageName: 'request', role: 'sender' })
    await insert('presentation', { associatedRecordId: 'exchange', messageName: 'presentation', role: 'receiver' })
    const query = {
      $and: [{ associatedRecordId: 'exchange' }, { $or: [{ messageName: 'request' }, { messageName: 'other' }] }],
    }
    assert.equal((await repository.findSingleByQuery(context(), query)).id, 'request')
    await assert.rejects(repository.findSingleByQuery(context(), {}), RecordDuplicateError)
  })

  it('does not truncate general list queries or change explicit pagination', async () => {
    for (let index = 0; index < 5; index++) await insert(`list-${index}`, { threadId: 'list' })
    assert.equal((await repository.findByQuery(context(), { threadId: 'list' })).length, 5)
    assert.equal((await repository.getAll(context())).length, 5)
    const options = { limit: 3, offset: 1 }
    assert.equal((await repository.findByQuery(context(), { threadId: 'list' }, options)).length, 3)
    assert.equal(queries.at(-1).options, options)
  })

  it('retains the opt-in cache miss/write/hit behavior without extra queries on a hit', async () => {
    const cachedContext = context('tenant-a', true)
    const expected = await insert('cached', { threadId: 'cached-thread' }, cachedContext)
    const query = { threadId: 'cached-thread' }
    const first = await repository.findSingleByQuery(cachedContext, query, { cacheKey: 'lookup' })
    const second = await repository.findSingleByQuery(cachedContext, query, { cacheKey: 'lookup' })
    assert.deepEqual(first.toJSON(), expected.toJSON())
    assert.deepEqual(second.toJSON(), expected.toJSON())
    assert.equal(queries.length, 1)
    assert.deepEqual(cacheWrites, ['lookup', expected.id])
  })

  it('does not cache missing or duplicate matches', async () => {
    const cachedContext = context('tenant-a', true)
    assert.equal(await repository.findSingleByQuery(cachedContext, {}, { cacheKey: 'missing' }), null)
    await insert('one', { threadId: 'duplicate' }, cachedContext)
    await insert('two', { threadId: 'duplicate' }, cachedContext)
    await assert.rejects(
      repository.findSingleByQuery(cachedContext, { threadId: 'duplicate' }, { cacheKey: 'duplicate' }),
      RecordDuplicateError,
    )
    assert.deepEqual(cacheWrites, [])
  })

  it('propagates storage failures instead of returning a missing record', async () => {
    const failure = new Error('synthetic storage failure')
    storage.findByQuery = async () => {
      throw failure
    }
    await assert.rejects(repository.findSingleByQuery(context(), {}), (error) => error === failure)
    await assert.rejects(repository.getSingleByQuery(context(), {}), (error) => error === failure)
  })

  it('preserves DIDComm message save, update, role filtering and reconstruction', async () => {
    const messages = new DidCommMessageRepository(storage, { emit() {} })
    const options = {
      associatedRecordId: 'exchange',
      role: DidCommMessageRole.Sender,
      agentMessage: new DidCommBasicMessage({ content: 'initial' }),
    }
    await messages.saveOrUpdateAgentMessage(context(), options)
    const updated = new DidCommBasicMessage({ content: 'updated' })
    await messages.saveOrUpdateAgentMessage(context(), { ...options, agentMessage: updated })
    const lookup = {
      associatedRecordId: options.associatedRecordId,
      messageClass: DidCommBasicMessage,
      role: options.role,
    }
    assert.deepEqual((await messages.getAgentMessage(context(), lookup)).toJSON(), updated.toJSON())
    assert.equal(await messages.findAgentMessage(context(), { ...lookup, role: DidCommMessageRole.Receiver }), null)
    assert.equal(await messages.findAgentMessage(context('tenant-b'), lookup), null)
    assert.ok(queries.every((q) => q.options.limit === 2))
    assert.equal((await messages.getAll(context())).length, 1)
  })

  it('rejects duplicate DIDComm messages instead of returning or updating an arbitrary match', async () => {
    const messages = new DidCommMessageRepository(storage, { emit() {} })
    const options = {
      associatedRecordId: 'exchange',
      role: DidCommMessageRole.Sender,
      agentMessage: new DidCommBasicMessage({ content: 'original' }),
    }
    for (let index = 0; index < 5; index++) await messages.saveAgentMessage(context(), options)
    const lookup = {
      associatedRecordId: options.associatedRecordId,
      messageClass: DidCommBasicMessage,
      role: options.role,
    }
    await assert.rejects(messages.findAgentMessage(context(), lookup), RecordDuplicateError)
    await assert.rejects(messages.getAgentMessage(context(), lookup), RecordDuplicateError)
    await assert.rejects(
      messages.saveOrUpdateAgentMessage(context(), {
        ...options,
        agentMessage: new DidCommBasicMessage({ content: 'must-not-be-written' }),
      }),
      RecordDuplicateError,
    )
    assert.deepEqual(
      queries.map((q) => q.returned),
      [2, 2, 2],
    )
    const records = await messages.getAll(context())
    assert.equal(records.length, 5)
    assert.ok(records.every((record) => record.getMessageInstance(DidCommBasicMessage).content === 'original'))
  })

  async function trackNativeLists(run) {
    const acquired = []
    const released = []
    let scansFreed = 0
    const scanNext = askar.scanNext
    const entryListFree = askar.entryListFree
    const scanFree = askar.scanFree
    askar.scanNext = async function (options) {
      const handle = await scanNext.call(this, options)
      if (handle) acquired.push(handle)
      return handle
    }
    askar.entryListFree = function (options) {
      released.push(options.entryListHandle)
      return entryListFree.call(this, options)
    }
    askar.scanFree = function (options) {
      scansFreed++
      return scanFree.call(this, options)
    }
    try {
      await run()
      assert.deepEqual(released, acquired, 'every acquired native result list must be released exactly once')
      assert.equal(scansFreed, 1)
      return acquired.length
    } finally {
      askar.scanNext = scanNext
      askar.entryListFree = entryListFree
      askar.scanFree = scanFree
    }
  }

  it('releases every batch of an unbounded scan without invalidating copied records', async () => {
    for (let index = 0; index < 300; index++) await insert(`batch-${index}`, { threadId: 'batches' })
    let records
    const batches = await trackNativeLists(async () => {
      records = await repository.findByQuery(context(), { threadId: 'batches' })
    })
    assert.ok(batches > 1, 'fixture must exercise multiple native batches')
    assert.equal(records.length, 300)
    assert.equal(new Set(records.map((record) => record.id)).size, 300)
    for (const record of records) {
      assert.deepEqual(record.content, { message: `fixture-${record.id}` })
      assert.deepEqual(record.getTags(), { threadId: 'batches' })
    }
  })

  it('releases the last result list when the two-record limit stops a scan early', async () => {
    for (let index = 0; index < 5; index++) await insert(`limited-${index}`, { threadId: 'limited' })
    const batches = await trackNativeLists(async () => {
      await assert.rejects(repository.findSingleByQuery(context(), { threadId: 'limited' }), RecordDuplicateError)
    })
    assert.equal(batches, 1)
  })

  it('frees an empty scan without attempting to release an absent result list', async () => {
    const batches = await trackNativeLists(async () => {
      assert.equal(await repository.findSingleByQuery(context(), {}), null)
    })
    assert.equal(batches, 0)
  })

  it('releases the current result list and scan when copying a record fails', async () => {
    await insert('unreadable', { threadId: 'copy-failure' })
    const toJson = Entry.prototype.toJson
    const failure = new Error('synthetic record conversion failure')
    Entry.prototype.toJson = () => {
      throw failure
    }
    try {
      const batches = await trackNativeLists(async () => {
        const scan = new Scan({ store, profile: context().contextCorrelationId, category: GenericRecord.type })
        await assert.rejects(scan.fetchAll(), (error) => error === failure)
      })
      assert.equal(batches, 1)
    } finally {
      Entry.prototype.toJson = toJson
    }
  })

  it('releases the native list even if constructing its entry-list wrapper fails', async () => {
    await insert('count-failure', {})
    const entryListCount = askar.entryListCount
    const failure = new Error('synthetic entry-list construction failure')
    askar.entryListCount = () => {
      throw failure
    }
    try {
      const batches = await trackNativeLists(async () => {
        const scan = new Scan({ store, profile: context().contextCorrelationId, category: GenericRecord.type })
        await assert.rejects(scan.fetchAll(), (error) => error === failure)
      })
      assert.equal(batches, 1)
    } finally {
      askar.entryListCount = entryListCount
    }
  })
})
