import 'reflect-metadata'
import '@openwallet-foundation/askar-nodejs'

import type { DependencyManager } from '@credo-ts/core'

import { AskarStorageService } from '@credo-ts/askar'
import { CacheModuleConfig, GenericRecord, InjectionSymbols, RecordDuplicateError, Repository } from '@credo-ts/core'
import {
  DidCommConnectionRecord,
  DidCommConnectionRepository,
  DidCommDidExchangeRole,
  DidCommDidExchangeState,
} from '@credo-ts/didcomm'
import { jest } from '@jest/globals'
import { KdfMethod, Store, StoreKeyMethod } from '@openwallet-foundation/askar-shared'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { PlanStableAskarStorageModule, walletQueryPlanning } from '../PlanStableAskarStorageModule'
import { PlanStableAskarStorageService } from '../PlanStableAskarStorageService'

/* eslint-disable @typescript-eslint/no-explicit-any */

// Real native Askar on disposable SQLite files: the stock and the planned service read the same
// store, so every comparison is against what Credo's own AskarStorageService returns.
describe('PlanStableAskarStorageService with native Askar', () => {
  let directory: string
  let store: Store
  let stock: AskarStorageService<any>
  let planned: PlanStableAskarStorageService<any>
  let scans: Array<{ query: unknown; options: unknown }>
  const contexts = new Map<string, any>()
  const context = (profile = 'tenant-a') => {
    if (!contexts.has(profile)) {
      const cacheConfig = new CacheModuleConfig({ useCachedStorageService: false } as any)
      contexts.set(profile, {
        contextCorrelationId: profile,
        dependencyManager: { isRegistered: () => false, resolve: () => undefined },
        resolve: (token: unknown) => (token === CacheModuleConfig ? cacheConfig : undefined),
        config: { logger: { debug() {}, trace() {}, info() {}, warn() {}, error() {} } },
      })
    }
    return contexts.get(profile)
  }

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'plan-stable-storage-'))
    store = await Store.provision({
      uri: `sqlite://${join(directory, 'wallet.db')}`,
      keyMethod: new StoreKeyMethod(KdfMethod.Raw),
      passKey: Store.generateRawKey(),
      recreate: false,
      profile: 'tenant-a',
    })
    await store.createProfile('tenant-b')
    const manager: any = {
      async getInitializedStoreWithProfile(agentContext: any) {
        return { store, profile: agentContext.contextCorrelationId }
      },
      async withSession(agentContext: any, operation: (session: any) => Promise<unknown>) {
        const session = await store.session(agentContext.contextCorrelationId).open()
        try {
          return await operation(session)
        } finally {
          await session.close()
        }
      },
    }
    stock = new AskarStorageService(manager)
    planned = new PlanStableAskarStorageService(manager)
    scans = []
    const findByQuery = AskarStorageService.prototype.findByQuery
    jest.spyOn(AskarStorageService.prototype, 'findByQuery').mockImplementation(function (
      this: any,
      ...args: Parameters<typeof findByQuery>
    ) {
      if (this === planned) scans.push({ query: args[2], options: args[3] })
      return findByQuery.apply(this, args)
    })

    // Generic records with tag values drawn from a small vocabulary, so random queries hit,
    // miss and overlap. Two profiles carry identical tags to prove profile isolation.
    const values = ['a', 'b', 'c']
    let n = 0
    for (const profile of ['tenant-a', 'tenant-b']) {
      for (const x of values)
        for (const y of values)
          for (const role of ['sender', 'receiver']) {
            const record = new GenericRecord({ id: `${profile}-${n++}`, content: { n } })
            record.setTags({ x, y, role, keys: [x, `${y}2`], flag: x === 'a', ...(y === 'c' ? { z: x } : {}) })
            await stock.save(context(profile), record)
          }
    }
  })

  afterAll(async () => {
    jest.restoreAllMocks()
    await store?.close()
    if (directory) await rm(directory, { recursive: true, force: true })
  })

  beforeEach(() => {
    scans.length = 0
  })

  const ids = (records: any[]) => records.map((record) => record.id).sort()
  const both = async (query: any, options?: any, profile = 'tenant-a') => {
    const expected = ids(await stock.findByQuery(context(profile), GenericRecord, query, options))
    const actual = ids(await planned.findByQuery(context(profile), GenericRecord, query, options))
    return { expected, actual }
  }

  it.each([
    [
      'OR of AND pairs',
      {
        $or: [
          { x: 'a', y: 'b' },
          { x: 'b', role: 'sender' },
          { keys: ['c'], y: 'c' },
        ],
      },
    ],
    ['OR with sibling conditions', { role: 'receiver', $or: [{ x: 'a' }, { z: 'b' }] }],
    ['nested OR', { $and: [{ $or: [{ x: 'a' }, { x: 'c' }] }, { $or: [{ y: 'a' }, { keys: ['b2'] }] }] }],
    ['overlapping OR branches', { $or: [{ x: 'a' }, { y: 'a' }, { flag: true }] }],
    ['OR with $not', { $or: [{ x: 'a' }, { x: 'b' }], $not: { y: 'b' } }],
    ['AND led by an enumeration', { role: 'sender', x: 'b', y: undefined }],
    ['absent values', { role: 'sender', x: null, keys: [], $or: [] }],
    ['no match', { $or: [{ x: 'nope' }, { z: 'nope' }] }],
  ])('%s returns the records the stock service returns', async (_, query) => {
    for (const options of [undefined, { limit: 2 }, { limit: 1 }, { limit: 50 }]) {
      const { expected, actual } = await both(query, options)
      if (options?.limit === undefined || expected.length <= options.limit) expect(actual).toEqual(expected)
      else expect(actual).toHaveLength(options.limit)
    }
  })

  it('returns the same records on 400 random queries, with and without a limit', async () => {
    let seed = 7
    const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648
    const pick = <V>(values: V[]) => values[Math.floor(random() * values.length)]
    const condition = (): any =>
      pick([
        { x: pick(['a', 'b', 'c']) },
        { y: pick(['a', 'b', 'c']) },
        { z: pick(['a', 'b']) },
        { role: pick(['sender', 'receiver']) },
        { keys: [pick(['a', 'b', 'c2'])] },
        { flag: pick([true, false]) },
      ])
    const query = (depth: number): any => {
      const parts = Array.from({ length: 1 + Math.floor(random() * 2) }, condition)
      if (depth > 0 && random() < 0.6)
        parts.push({ $or: Array.from({ length: 2 + Math.floor(random() * 2) }, () => query(depth - 1)) })
      if (depth > 0 && random() < 0.15) parts.push({ $not: query(depth - 1) })
      return Object.assign({}, ...parts.filter((part) => !('$or' in part || '$not' in part)), {
        $and: parts.filter((part) => '$or' in part || '$not' in part),
      })
    }
    for (let i = 0; i < 400; i++) {
      const q = query(2)
      const { expected, actual } = await both(q)
      expect({ q, actual }).toEqual({ q, actual: expected })
      const limited = await both(q, { limit: 2 })
      if (limited.expected.length <= 2) expect(limited.actual).toEqual(limited.expected)
      else expect(limited.actual).toHaveLength(2)
    }
  })

  it('keeps profiles apart', async () => {
    const query = { $or: [{ x: 'a' }, { y: 'c' }] }
    const a = await both(query, undefined, 'tenant-a')
    const b = await both(query, undefined, 'tenant-b')
    expect(a.actual).toEqual(a.expected)
    expect(b.actual).toEqual(b.expected)
    expect(a.actual.every((id) => id.startsWith('tenant-a-'))).toBe(true)
    expect(b.actual.every((id) => id.startsWith('tenant-b-'))).toBe(true)
  })

  it('runs an OR as one indexed lookup per branch, each bounded by the limit', async () => {
    const query = {
      $or: [
        { x: 'a', y: 'a', role: 'sender' },
        { x: 'b', y: 'b', role: 'sender' },
      ],
    }
    const records = await planned.findByQuery(context(), GenericRecord, query as any, { limit: 2 })
    expect(records).toHaveLength(2)
    expect(scans).toEqual([
      { query: { $and: [{ x: 'a' }, { y: 'a' }, { role: 'sender' }] }, options: { limit: 2 } },
      { query: { $and: [{ x: 'b' }, { y: 'b' }, { role: 'sender' }] }, options: { limit: 2 } },
    ])
  })

  it('leads an AND with its selective tag', async () => {
    await planned.findByQuery(context(), GenericRecord, { threadId: 't', role: 'sender' } as any, { limit: 2 })
    expect(scans).toEqual([{ query: { $and: [{ threadId: 't' }, { role: 'sender' }] }, options: { limit: 2 } }])
  })

  it('runs a query it does not plan exactly as written', async () => {
    // `keys:a` sorts ahead of `role`, so Askar already leads with the selective tag.
    const query = { keys: ['a'], role: 'sender' }
    await planned.findByQuery(context(), GenericRecord, query as any, { limit: 2 })
    expect(scans).toEqual([{ query, options: { limit: 2 } }])
  })

  it('runs the original query for a page of an OR (offset or orderBy)', async () => {
    const query = { $or: [{ x: 'a' }, { x: 'b' }] }
    for (const options of [{ offset: 1, limit: 2 }, { orderBy: 'id' as const }, { orderBy: 'id' as const, limit: 3 }]) {
      scans.length = 0
      const { expected, actual } = await both(query, options)
      expect(actual).toEqual(expected)
      expect(scans).toEqual([{ query, options }])
    }
  })

  it('lets the original query choose the subset when the union exceeds the limit', async () => {
    const query = {
      $or: [
        { x: 'a', y: 'a' },
        { x: 'b', y: 'b' },
      ],
    }
    const expected = ids(await stock.findByQuery(context(), GenericRecord, query as any, { limit: 3 }))
    scans.length = 0
    const actual = ids(await planned.findByQuery(context(), GenericRecord, query as any, { limit: 3 }))
    expect(actual).toEqual(expected)
    // Two branches of two records each: the second branch passes the limit, the original runs.
    expect(scans.map((scan) => scan.query)).toEqual([
      { $and: [{ x: 'a' }, { y: 'a' }] },
      { $and: [{ x: 'b' }, { y: 'b' }] },
      query,
    ])
  })

  it('keeps findSingleByQuery duplicate detection through a repository', async () => {
    const repository = new Repository(GenericRecord, planned as any, { emit() {} } as any)
    await expect(
      repository.findSingleByQuery(context(), { $or: [{ x: 'a', y: 'a' }, { z: 'nope' }] } as any),
    ).rejects.toBeInstanceOf(RecordDuplicateError)
    expect(await repository.findSingleByQuery(context(), { $or: [{ x: 'zz' }, { z: 'nope' }] } as any)).toBeNull()
    const single = await repository.findSingleByQuery(context(), {
      $or: [{ x: 'a', y: 'a', role: 'sender' }, { z: 'nope' }],
    } as any)
    expect(single?.getTags()).toEqual(expect.objectContaining({ x: 'a', y: 'a', role: 'sender' }))
  })

  it("finds a connection by its DIDs through Credo's repository, after a DID rotation too", async () => {
    const connections = new DidCommConnectionRepository(planned as any, { emit() {} } as any)
    const stockConnections = new DidCommConnectionRepository(stock as any, { emit() {} } as any)
    const record = new DidCommConnectionRecord({
      role: DidCommDidExchangeRole.Responder,
      state: DidCommDidExchangeState.Completed,
      did: 'did:peer:1zours',
      theirDid: 'did:peer:1znew',
      previousTheirDids: ['did:peer:1zold'],
      previousDids: ['did:peer:1zpast'],
    })
    await stock.save(context(), record)
    for (const dids of [
      { ourDid: 'did:peer:1zours', theirDid: 'did:peer:1znew' },
      { ourDid: 'did:peer:1zours', theirDid: 'did:peer:1zold' },
      { ourDid: 'did:peer:1zpast', theirDid: 'did:peer:1znew' },
      { ourDid: 'did:peer:1zpast', theirDid: 'did:peer:1zold' },
    ]) {
      const expected = (await stockConnections.findByDids(context(), dids))?.id ?? null
      expect((await connections.findByDids(context(), dids))?.id ?? null).toBe(expected)
    }
    expect(
      (await connections.findByDids(context(), { ourDid: 'did:peer:1zours', theirDid: 'did:peer:1zold' }))?.id,
    ).toBe(record.id)
    expect(
      await connections.findByDids(context(), { ourDid: 'did:peer:1zpast', theirDid: 'did:peer:1zold' }),
    ).toBeNull()
  })
})

describe('PlanStableAskarStorageModule', () => {
  it('registers the planned service, or the stock one when planning is off', () => {
    for (const [planning, expected] of [
      [true, PlanStableAskarStorageService],
      [false, AskarStorageService],
    ] as const) {
      const registered: unknown[] = []
      const dependencyManager = {
        isRegistered: () => false,
        registerSingleton: (token: unknown, implementation: unknown) => registered.push([token, implementation]),
      } as unknown as DependencyManager
      new PlanStableAskarStorageModule(planning).register(dependencyManager)
      expect(registered).toEqual([[InjectionSymbols.StorageService, expected]])
    }
  })

  it('refuses to replace a StorageService that is already registered', () => {
    const dependencyManager = { isRegistered: () => true, registerSingleton: jest.fn() } as unknown as DependencyManager
    expect(() => new PlanStableAskarStorageModule(true).register(dependencyManager)).toThrow(/enableStorage: false/)
  })

  it.each([
    [undefined, true],
    ['', true],
    ['on', true],
    ['off', false],
  ])('WALLET_QUERY_PLANNING=%s -> %s', (value, expected) => {
    expect(walletQueryPlanning({ WALLET_QUERY_PLANNING: value } as NodeJS.ProcessEnv)).toBe(expected)
  })

  it.each(['true', 'false', 'OFF', '0', 'yes'])('rejects WALLET_QUERY_PLANNING=%s', (value) => {
    expect(() => walletQueryPlanning({ WALLET_QUERY_PLANNING: value } as NodeJS.ProcessEnv)).toThrow(/"on" or "off"/)
  })
})
