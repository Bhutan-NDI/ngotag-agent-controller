import { EventEmitter, InjectionSymbols } from '@credo-ts/core'
import { DidCommEventTypes, DidCommRoutingEventTypes } from '@credo-ts/didcomm'
import { jest } from '@jest/globals'

import { RelayConflictError, RelayNotFoundError, RelayService } from '../RelayService'
import { RelayStore } from '../RelayStore'
import { InvalidRelayTargetError } from '../relayTarget'

import { FakeRedis, eventually, silentLogger } from './testSupport'

const TENANT = 'tenant-1'
const TARGET = 'https://agent.example.org/'

interface FakeRecord {
  id: string
  content: Record<string, unknown>
  tags: Record<string, string>
}

const buildHarness = (options: { forwardTimeoutMs?: number } = {}) => {
  const records = new Map<string, FakeRecord>()
  const routing = [
    { tenantId: TENANT, recipientKeyFingerprint: 'fp-1' },
    { tenantId: TENANT, recipientKeyFingerprint: 'fp-2' },
    { tenantId: 'someone-else', recipientKeyFingerprint: 'fp-other' },
  ]
  type Listener = (event: { payload: unknown; metadata?: { contextCorrelationId: string } }) => void
  const listeners = new Map<string, Listener[]>()
  const received: unknown[] = []
  let ignoreMessage: ((message: unknown) => boolean) | undefined

  const fire = (type: string, event: Parameters<Listener>[0]): void =>
    (listeners.get(type) ?? []).slice().forEach((l) => l(event))
  const eventEmitter = {
    on: (type: string, listener: Listener) => listeners.set(type, [...(listeners.get(type) ?? []), listener]),
    off: (type: string, listener: Listener) =>
      listeners.set(
        type,
        (listeners.get(type) ?? []).filter((existing) => existing !== listener),
      ),
    emit: (_context: unknown, event: { type: string; payload: { message: unknown } }) => {
      expect(event.type).toBe(DidCommEventTypes.DidCommMessageReceived)
      received.push(event.payload.message)
      if (ignoreMessage?.(event.payload.message)) return
      setTimeout(
        () => fire(DidCommEventTypes.DidCommMessageProcessed, { payload: { encryptedMessage: event.payload.message } }),
        0,
      )
    },
  }
  const storage = {
    findByQuery: async (_context: unknown, _recordClass: unknown, query: { tenantId: string }) =>
      routing.filter((record) => record.tenantId === query.tenantId),
  }
  const knownTenants = new Set([TENANT])
  const purgedTenants = new Set<string>()
  const agent = {
    context: { name: 'root' },
    genericRecords: {
      findById: async (id: string) => records.get(id) ?? null,
      save: async (record: FakeRecord) => void records.set(record.id, record),
      update: async (record: FakeRecord) => void records.set(record.id, record),
      delete: async (record: FakeRecord) => void records.delete(record.id),
      findAllByQuery: async (query: Record<string, string>) =>
        [...records.values()].filter((record) =>
          Object.entries(query).every(([key, value]) => record.tags[key] === value),
        ),
    },
    modules: {
      tenants: {
        getTenantById: jest.fn(async (id: string) => {
          if (!knownTenants.has(id)) throw new Error('tenant not found')
          return {
            id,
            getTag: (name: string) => ('migrated' === name ? purgedTenants.has(id) || undefined : undefined),
          }
        }),
      },
    },
    dependencyManager: {
      resolve: (token: unknown) =>
        InjectionSymbols.StorageService === token ? storage : token === EventEmitter ? eventEmitter : undefined,
    },
  }

  const redis = new FakeRedis()
  const store = new RelayStore(redis)
  const drainer = { ensureDraining: jest.fn() }
  let probeFetch: typeof fetch = async () => new Response(null, { status: 404 })
  const service = new RelayService(store, drainer as never, silentLogger(), {
    probeFetch: ((...args: Parameters<typeof fetch>) => probeFetch(...args)) as typeof fetch,
    probeTimeoutMs: 50,
    reinjectTimeoutMs: 50,
    forwardTimeoutMs: options.forwardTimeoutMs ?? 0,
  })

  return {
    service,
    agent: agent as never,
    rawAgent: agent,
    records,
    purgeTenant: (id: string) => purgedTenants.add(id),
    redis,
    store,
    drainer,
    received,
    fire,
    listeners,
    setProbeFetch: (fn: typeof fetch) => {
      probeFetch = fn
    },
    ignoreMessages: (predicate: (message: unknown) => boolean) => {
      ignoreMessage = predicate
    },
  }
}

describe('RelayService', () => {
  describe('put', () => {
    it("starts a HOLD: persists the entry, indexes the tenant's recipient keys, and reports the status", async () => {
      const { service, agent, records, store, rawAgent } = buildHarness()

      const status = await service.put(agent, TENANT, { mode: 'HOLD' })

      expect(rawAgent.modules.tenants.getTenantById).toHaveBeenCalledWith(TENANT)
      expect(status).toMatchObject({
        tenantId: TENANT,
        mode: 'HOLD',
        holdCount: 0,
        recipientKeys: 2,
        forwardedLast30Days: 0,
      })
      expect(records.get(`migration-relay-${TENANT}`)).toMatchObject({
        content: { tenantId: TENANT, mode: 'HOLD' },
        tags: { migrationRelay: 'true', relayTenantId: TENANT },
      })
      expect(await store.getEntry(TENANT)).toMatchObject({ mode: 'HOLD' })
      await expect(store.findTenantIdByFingerprints(['fp-2'])).resolves.toBe(TENANT)
      await expect(store.findTenantIdByFingerprints(['fp-other'])).resolves.toBeUndefined()
    })

    it('rejects a tenant that does not exist, without leaving anything behind', async () => {
      const { service, agent, records, store } = buildHarness()

      await expect(service.put(agent, 'ghost', { mode: 'HOLD' })).rejects.toThrow('tenant not found')

      expect(records.size).toBe(0)
      expect(await store.getEntry('ghost')).toBeUndefined()
    })

    it('moves HOLD to FORWARD, starts draining the held messages, and stores the target', async () => {
      const { service, agent, store, drainer } = buildHarness()
      await service.put(agent, TENANT, { mode: 'HOLD' })
      await store.holdPush(TENANT, { receivedAt: 'now', contentType: 'x', body: '{}' })

      const status = await service.put(agent, TENANT, { mode: 'FORWARD', target: TARGET })

      expect(status).toMatchObject({ mode: 'FORWARD', target: TARGET, holdCount: 1 })
      expect(drainer.ensureDraining).toHaveBeenCalledWith(TENANT)
    })

    it('is idempotent for the same mode and refreshes the key index', async () => {
      const { service, agent, redis } = buildHarness()
      await service.put(agent, TENANT, { mode: 'HOLD' })
      redis.strings.delete('relay:kid:fp-1')

      await service.put(agent, TENANT, { mode: 'HOLD' })

      expect(redis.strings.get('relay:kid:fp-1')).toBe(TENANT)
    })

    it('never goes back from FORWARD to HOLD', async () => {
      const { service, agent } = buildHarness()
      await service.put(agent, TENANT, { mode: 'FORWARD', target: TARGET })

      await expect(service.put(agent, TENANT, { mode: 'HOLD' })).rejects.toThrow(RelayConflictError)
    })

    it.each([
      ['a FORWARD with no target', { mode: 'FORWARD' as const }],
      ['a FORWARD to plain http', { mode: 'FORWARD' as const, target: 'http://agent.example.org' }],
      ['a FORWARD to a private address', { mode: 'FORWARD' as const, target: 'https://10.1.2.3' }],
    ])('rejects %s', async (_name, request) => {
      const { service, agent, records } = buildHarness()

      await expect(service.put(agent, TENANT, request)).rejects.toThrow(InvalidRelayTargetError)
      expect(records.size).toBe(0)
    })

    it('rejects a HOLD that names a target', async () => {
      const { service, agent } = buildHarness()

      await expect(service.put(agent, TENANT, { mode: 'HOLD', target: TARGET })).rejects.toThrow(RelayConflictError)
    })
  })

  describe('put ordering', () => {
    it('indexes a recipient key created while the relay was being set', async () => {
      const { service, agent, fire } = buildHarness()
      service.watchRoutingKeys(agent)

      await service.put(agent, TENANT, { mode: 'HOLD' })
      fire(DidCommRoutingEventTypes.RoutingCreatedEvent, {
        payload: { routing: { recipientKey: { fingerprint: 'fp-new' } } },
        metadata: { contextCorrelationId: `tenant-${TENANT}` },
      })

      expect(service.mirror.find(['fp-new'])?.tenantId).toBe(TENANT)
    })
  })

  describe('get', () => {
    it('reports the persisted entry with its live counts', async () => {
      const { service, agent, store } = buildHarness()
      await service.put(agent, TENANT, { mode: 'HOLD' })
      await store.holdPush(TENANT, { receivedAt: 'now', contentType: 'x', body: '{}' })
      await store.recordMessage(TENANT, 'fp-1')

      await expect(service.get(agent, TENANT)).resolves.toMatchObject({
        mode: 'HOLD',
        holdCount: 1,
        forwardedLast30Days: 1,
      })
    })

    it('says so when there is no relay', async () => {
      const { service, agent } = buildHarness()

      await expect(service.get(agent, TENANT)).rejects.toThrow(RelayNotFoundError)
    })
  })

  describe('remove', () => {
    it('removes an empty HOLD relay completely', async () => {
      const { service, agent, records, store } = buildHarness()
      await service.put(agent, TENANT, { mode: 'HOLD' })

      await service.remove(agent, TENANT)

      expect(records.size).toBe(0)
      expect(await store.getEntry(TENANT)).toBeUndefined()
      await expect(store.findTenantIdByFingerprints(['fp-1', 'fp-2'])).resolves.toBeUndefined()
    })

    it('refuses to remove a FORWARD relay: it is permanent', async () => {
      const { service, agent, records } = buildHarness()
      await service.put(agent, TENANT, { mode: 'FORWARD', target: TARGET })

      await expect(service.remove(agent, TENANT)).rejects.toMatchObject({ code: 'RELAY_NOT_REMOVABLE' })
      expect(records.size).toBe(1)
    })

    it('refuses to remove a relay that is still holding messages', async () => {
      const { service, agent, store } = buildHarness()
      await service.put(agent, TENANT, { mode: 'HOLD' })
      await store.holdPush(TENANT, { receivedAt: 'now', contentType: 'x', body: '{}' })

      await expect(service.remove(agent, TENANT)).rejects.toMatchObject({ code: 'RELAY_BUFFER_NOT_EMPTY' })
    })

    it('tells other tasks the relay is gone, and a new relay for the tenant clears that', async () => {
      const { service, agent, store } = buildHarness()
      await service.put(agent, TENANT, { mode: 'HOLD' })

      await service.remove(agent, TENANT)
      expect(await store.isRemoved(TENANT)).toBe(true)

      await service.put(agent, TENANT, { mode: 'HOLD' })
      expect(await store.isRemoved(TENANT)).toBe(false)
    })

    it('finishes clearing Redis when an earlier call deleted the record and then failed', async () => {
      const { service, agent, records, store } = buildHarness()
      await service.put(agent, TENANT, { mode: 'HOLD' })
      records.clear()

      await expect(service.remove(agent, TENANT)).resolves.toBeUndefined()

      expect(await store.getEntry(TENANT)).toBeUndefined()
      await expect(store.findTenantIdByFingerprints(['fp-1'])).resolves.toBeUndefined()
      await expect(service.remove(agent, TENANT)).rejects.toThrow(RelayNotFoundError)
    })

    it('does not drop a buffer on the retry path when the record is already gone', async () => {
      const { service, agent, records, store } = buildHarness()
      await service.put(agent, TENANT, { mode: 'HOLD' })
      await store.holdPush(TENANT, { receivedAt: 'now', contentType: 'x', body: '{}' })
      records.clear()

      await expect(service.remove(agent, TENANT)).rejects.toMatchObject({ code: 'RELAY_BUFFER_NOT_EMPTY' })

      expect(await store.getEntry(TENANT)).toBeDefined()
      expect(await store.holdLength(TENANT)).toBe(1)
    })

    it('says so when there is nothing to remove', async () => {
      const { service, agent } = buildHarness()

      await expect(service.remove(agent, TENANT)).rejects.toThrow(RelayNotFoundError)
    })
  })

  describe('reinject', () => {
    const envelope = (n: number) => ({
      receivedAt: 'now',
      contentType: 'x',
      body: JSON.stringify({ protected: `p${n}` }),
    })

    it('hands every held message back to the agent in order and empties the buffer', async () => {
      const { service, agent, store, received } = buildHarness()
      await service.put(agent, TENANT, { mode: 'HOLD' })
      for (const n of [1, 2, 3]) await store.holdPush(TENANT, envelope(n))

      await expect(service.reinject(agent, TENANT)).resolves.toEqual({ injected: 3, failed: 0 })

      expect(received).toEqual([{ protected: 'p1' }, { protected: 'p2' }, { protected: 'p3' }])
      expect(await store.holdLength(TENANT)).toBe(0)
      await expect(service.remove(agent, TENANT)).resolves.toBeUndefined()
    })

    it('counts a message that was not processed in time, and carries on with the rest', async () => {
      const { service, agent, store, ignoreMessages } = buildHarness()
      await service.put(agent, TENANT, { mode: 'HOLD' })
      for (const n of [1, 2, 3]) await store.holdPush(TENANT, envelope(n))
      ignoreMessages((message) => 'p2' === (message as { protected: string }).protected)

      await expect(service.reinject(agent, TENANT)).resolves.toEqual({ injected: 2, failed: 1 })
      expect(await store.holdLength(TENANT)).toBe(0)
    })

    it('counts an unreadable held message as failed instead of stalling', async () => {
      const { service, agent, store } = buildHarness()
      await service.put(agent, TENANT, { mode: 'HOLD' })
      await store.holdPush(TENANT, { receivedAt: 'now', contentType: 'x', body: 'not json' })

      await expect(service.reinject(agent, TENANT)).resolves.toEqual({ injected: 0, failed: 1 })
    })

    it('refuses while another re-inject holds the lock, and releases the lock when it is done', async () => {
      const { service, agent, store } = buildHarness()
      await service.put(agent, TENANT, { mode: 'HOLD' })
      await store.holdPush(TENANT, envelope(1))
      await store.acquireDrainLock(TENANT, 'someone-else')

      await expect(service.reinject(agent, TENANT)).rejects.toMatchObject({ code: 'RELAY_BUSY' })
      expect(await store.holdLength(TENANT)).toBe(1)

      await store.releaseDrainLock(TENANT, 'someone-else')
      await expect(service.reinject(agent, TENANT)).resolves.toEqual({ injected: 1, failed: 0 })
      await expect(store.acquireDrainLock(TENANT, 'next')).resolves.toBe(true)
    })

    it('stops when it has lost the lock, so a second loop never pops what it has not injected', async () => {
      const { service, agent, store } = buildHarness()
      await service.put(agent, TENANT, { mode: 'HOLD' })
      for (const n of [1, 2]) await store.holdPush(TENANT, envelope(n))
      const refresh = jest.spyOn(store, 'refreshDrainLock').mockResolvedValue(false)

      await expect(service.reinject(agent, TENANT)).rejects.toMatchObject({ code: 'RELAY_BUSY' })

      expect(await store.holdLength(TENANT)).toBe(1)
      refresh.mockRestore()
    })

    it('only works on a relay that is holding', async () => {
      const { service, agent } = buildHarness()
      await service.put(agent, TENANT, { mode: 'FORWARD', target: TARGET })

      await expect(service.reinject(agent, TENANT)).rejects.toMatchObject({ code: 'RELAY_NOT_HOLDING' })
      await expect(service.reinject(agent, 'ghost')).rejects.toThrow(RelayNotFoundError)
    })
  })

  describe('restore', () => {
    const envelope = (n: number) => ({
      receivedAt: 'now',
      contentType: 'x',
      body: JSON.stringify({ protected: `p${n}` }),
    })

    it('takes a FORWARD relay off for good and hands the messages queued for the lost target back to the agent', async () => {
      const { service, agent, store, records, received } = buildHarness()
      await service.put(agent, TENANT, { mode: 'FORWARD', target: TARGET })
      for (const n of [1, 2]) await store.holdPush(TENANT, envelope(n))

      await expect(service.restore(agent, TENANT)).resolves.toEqual({ injected: 2, failed: 0 })

      expect(received).toEqual([{ protected: 'p1' }, { protected: 'p2' }])
      expect(records.size).toBe(0)
      expect(await store.getEntry(TENANT)).toBeUndefined()
      expect(await store.holdLength(TENANT)).toBe(0)
      await expect(store.findTenantIdByFingerprints(['fp-1', 'fp-2'])).resolves.toBeUndefined()
    })

    it('waits out the forward timeout after the flip, so a forward still in flight can push its message first', async () => {
      const { service, agent, store, received } = buildHarness({ forwardTimeoutMs: 150 })
      await service.put(agent, TENANT, { mode: 'FORWARD', target: TARGET })
      const startedAt = Date.now()
      const held = service as unknown as { injectHeld: RelayService['reinject'] }
      const injectHeld = held.injectHeld.bind(service)
      let startedInjectingAfterMs = 0
      jest.spyOn(held, 'injectHeld').mockImplementation(async (...args) => {
        startedInjectingAfterMs = Date.now() - startedAt
        return injectHeld(...args)
      })
      setTimeout(() => void store.holdPush(TENANT, envelope(7)), 40)

      await expect(service.restore(agent, TENANT)).resolves.toEqual({ injected: 1, failed: 0 })

      expect(startedInjectingAfterMs).toBeGreaterThanOrEqual(140)
      expect(received).toEqual([{ protected: 'p7' }])
    })

    it('does not wait again on a retry, since the flip was long ago', async () => {
      const { service, agent, store } = buildHarness({ forwardTimeoutMs: 150 })
      await service.put(agent, TENANT, { mode: 'FORWARD', target: TARGET })
      await store.setEntry({ tenantId: TENANT, mode: 'HOLD', updatedAt: new Date(Date.now() - 60_000).toISOString() })
      const startedAt = Date.now()

      await service.restore(agent, TENANT)

      expect(Date.now() - startedAt).toBeLessThan(100)
    })

    it('stops forwarding before it hands anything back, so no message goes to the lost agent in between', async () => {
      const { service, agent, store, records } = buildHarness()
      await service.put(agent, TENANT, { mode: 'FORWARD', target: TARGET })
      await store.holdPush(TENANT, envelope(1))
      const modes: unknown[] = []
      const held = service as unknown as { injectHeld: RelayService['reinject'] }
      const injectHeld = held.injectHeld.bind(service)
      jest.spyOn(held, 'injectHeld').mockImplementation(async (...args) => {
        modes.push((await store.getEntry(TENANT))?.mode, records.get(`migration-relay-${TENANT}`)?.content.mode)
        return injectHeld(...args)
      })

      await service.restore(agent, TENANT)

      expect(modes).toEqual(['HOLD', 'HOLD'])
    })

    it('stops the mirror forwarding too, and forgets the tenant once the relay is gone', async () => {
      const { service, agent, store } = buildHarness()
      await service.put(agent, TENANT, { mode: 'FORWARD', target: TARGET })
      await store.holdPush(TENANT, envelope(1))
      const seen: unknown[] = []
      const held = service as unknown as { injectHeld: RelayService['reinject'] }
      const injectHeld = held.injectHeld.bind(service)
      jest.spyOn(held, 'injectHeld').mockImplementation(async (...args) => {
        seen.push(service.mirror.find(['fp-1'])?.mode)
        return injectHeld(...args)
      })

      await service.restore(agent, TENANT)

      expect(seen).toEqual(['HOLD'])
      expect(service.mirror.find(['fp-1', 'fp-2'])).toBeUndefined()
    })

    it('does not ask the drainer to forward anything', async () => {
      const { service, agent, drainer } = buildHarness()
      await service.put(agent, TENANT, { mode: 'FORWARD', target: TARGET })
      drainer.ensureDraining.mockClear()

      await service.restore(agent, TENANT)

      expect(drainer.ensureDraining).not.toHaveBeenCalled()
    })

    it('works on a relay that is only holding, which is how a restore that stopped half way is finished', async () => {
      const { service, agent, store, records } = buildHarness()
      await service.put(agent, TENANT, { mode: 'HOLD' })
      for (const n of [1, 2, 3]) await store.holdPush(TENANT, envelope(n))

      await expect(service.restore(agent, TENANT)).resolves.toEqual({ injected: 3, failed: 0 })

      expect(records.size).toBe(0)
    })

    it('finishes a restore that stopped half way through the held messages', async () => {
      const { service, agent, store, received } = buildHarness()
      await service.put(agent, TENANT, { mode: 'FORWARD', target: TARGET })
      for (const n of [1, 2, 3]) await store.holdPush(TENANT, envelope(n))
      jest.spyOn(service, 'remove').mockRejectedValueOnce(new Error('crashed before the entry was removed'))
      await expect(service.restore(agent, TENANT)).rejects.toThrow('crashed')
      jest.restoreAllMocks()
      await store.holdPush(TENANT, envelope(4))

      await expect(service.restore(agent, TENANT)).resolves.toEqual({ injected: 1, failed: 0 })

      expect(received.map((message) => (message as { protected: string }).protected)).toEqual(['p1', 'p2', 'p3', 'p4'])
    })

    it('counts a message that could not be processed, but still removes the relay', async () => {
      const { service, agent, store, records, ignoreMessages } = buildHarness()
      await service.put(agent, TENANT, { mode: 'FORWARD', target: TARGET })
      for (const n of [1, 2]) await store.holdPush(TENANT, envelope(n))
      ignoreMessages((message) => 'p1' === (message as { protected: string }).protected)

      await expect(service.restore(agent, TENANT)).resolves.toEqual({ injected: 1, failed: 1 })

      expect(records.size).toBe(0)
    })

    it('leaves the relay holding, and says so, when new messages arrived while it was handing back', async () => {
      const { service, agent, store, records } = buildHarness()
      await service.put(agent, TENANT, { mode: 'FORWARD', target: TARGET })
      jest.spyOn(store, 'holdLength').mockResolvedValueOnce(1)

      await expect(service.restore(agent, TENANT)).rejects.toMatchObject({ code: 'RELAY_BUFFER_NOT_EMPTY' })

      expect((await store.getEntry(TENANT))?.mode).toBe('HOLD')
      expect(records.size).toBe(1)
    })

    it('refuses a tenant whose wallet was purged, and changes nothing', async () => {
      const { service, agent, store, records, purgeTenant } = buildHarness()
      await service.put(agent, TENANT, { mode: 'FORWARD', target: TARGET })
      await store.holdPush(TENANT, envelope(1))
      purgeTenant(TENANT)

      await expect(service.restore(agent, TENANT)).rejects.toMatchObject({ code: 'TENANT_PURGED' })

      expect((await store.getEntry(TENANT))?.mode).toBe('FORWARD')
      expect(records.get(`migration-relay-${TENANT}`)?.content.mode).toBe('FORWARD')
      expect(await store.holdLength(TENANT)).toBe(1)
    })

    it('says so when the tenant has no relay', async () => {
      const { service, agent } = buildHarness()

      await expect(service.restore(agent, TENANT)).rejects.toThrow(RelayNotFoundError)
    })

    it('finishes a remove that deleted the record and then failed, instead of answering 404', async () => {
      const { service, agent, store, records, received } = buildHarness()
      await service.put(agent, TENANT, { mode: 'HOLD' })
      for (const n of [1, 2]) await store.holdPush(TENANT, envelope(n))
      records.clear()

      await expect(service.restore(agent, TENANT)).resolves.toEqual({ injected: 2, failed: 0 })

      expect(received).toEqual([{ protected: 'p1' }, { protected: 'p2' }])
      expect(await store.getEntry(TENANT)).toBeUndefined()
      await expect(store.findTenantIdByFingerprints(['fp-1'])).resolves.toBeUndefined()
    })

    it('puts Redis on HOLD when an earlier attempt saved the record as HOLD and then failed', async () => {
      const { service, agent, store, records, received } = buildHarness()
      await service.put(agent, TENANT, { mode: 'FORWARD', target: TARGET })
      await store.holdPush(TENANT, envelope(1))
      const saved = records.get(`migration-relay-${TENANT}`)!
      saved.content = { ...saved.content, mode: 'HOLD', target: undefined }

      await expect(service.restore(agent, TENANT)).resolves.toEqual({ injected: 1, failed: 0 })

      expect(received).toEqual([{ protected: 'p1' }])
      expect(await store.getEntry(TENANT)).toBeUndefined()
    })

    it('waits for a drainer that is mid-forward to let go of the buffer before it re-injects', async () => {
      const { service, agent, store, received } = buildHarness()
      await service.put(agent, TENANT, { mode: 'FORWARD', target: TARGET })
      await store.holdPush(TENANT, envelope(1))
      await store.acquireDrainLock(TENANT, 'drainer')
      setTimeout(() => void store.releaseDrainLock(TENANT, 'drainer'), 300)

      await expect(service.restore(agent, TENANT)).resolves.toEqual({ injected: 1, failed: 0 })

      expect(received).toEqual([{ protected: 'p1' }])
    })

    it('leaves other tenants relays alone', async () => {
      const { service, agent, records, rawAgent } = buildHarness()
      await service.put(agent, TENANT, { mode: 'FORWARD', target: TARGET })
      rawAgent.genericRecords.save({
        id: 'migration-relay-someone-else',
        content: { tenantId: 'someone-else', mode: 'FORWARD', target: TARGET },
        tags: {},
      })

      await service.restore(agent, TENANT)

      expect([...records.keys()]).toEqual(['migration-relay-someone-else'])
    })
  })

  describe('probe', () => {
    it('reports a reachable address with the status it answered', async () => {
      const { service } = buildHarness()

      await expect(service.probe(TARGET)).resolves.toEqual({ reachable: true, status: 404 })
    })

    it('drops the answer body without reading it', async () => {
      const { service, setProbeFetch } = buildHarness()
      let cancelled = false
      const body = new ReadableStream({
        pull: (controller) => controller.enqueue(new Uint8Array(1024)),
        cancel: () => {
          cancelled = true
        },
      })
      setProbeFetch(async () => new Response(body, { status: 200 }))

      await expect(service.probe(TARGET)).resolves.toEqual({ reachable: true, status: 200 })
      expect(cancelled).toBe(true)
    })

    it.each([
      ['a refused connection', 'ECONNREFUSED', 'UNREACHABLE'],
      ['an unknown host', 'ENOTFOUND', 'DNS'],
      ['an expired certificate', 'CERT_HAS_EXPIRED', 'TLS'],
      ['a self-signed certificate', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'TLS'],
      ['anything else', 'EPIPE', 'UNREACHABLE'],
    ])('classifies %s as %s', async (_name, code, reason) => {
      const { service, setProbeFetch } = buildHarness()
      setProbeFetch(async () => {
        throw Object.assign(new TypeError('fetch failed'), { cause: { code } })
      })

      await expect(service.probe(TARGET)).resolves.toEqual({ reachable: false, reason })
    })

    it('reports a timeout', async () => {
      const { service, setProbeFetch } = buildHarness()
      setProbeFetch(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
          }),
      )

      await expect(service.probe(TARGET)).resolves.toEqual({ reachable: false, reason: 'TIMEOUT' })
    })

    it('will not probe an address it would not forward to', async () => {
      const { service } = buildHarness()

      await expect(service.probe('https://169.254.169.254/')).rejects.toThrow(InvalidRelayTargetError)
    })
  })

  describe('watchRoutingKeys', () => {
    const routingCreated = (contextCorrelationId: string, fingerprint: string) => ({
      metadata: { contextCorrelationId },
      payload: { routing: { recipientKey: { fingerprint } } },
    })

    it('indexes a key created for a tenant that has a relay, so its messages are relayed too', async () => {
      const { service, agent, store, fire } = buildHarness()
      await service.put(agent, TENANT, { mode: 'HOLD' })
      service.watchRoutingKeys(agent)

      fire(DidCommRoutingEventTypes.RoutingCreatedEvent, routingCreated(`tenant-${TENANT}`, 'fp-new'))

      await eventually(async () => TENANT === (await store.findTenantIdByFingerprints(['fp-new'])))
    })

    it.each([
      ['a tenant with no relay', 'tenant-no-relay'],
      ['the base wallet', 'default'],
    ])('ignores a key created for %s', async (_name, contextCorrelationId) => {
      const { service, agent, store, fire } = buildHarness()
      service.watchRoutingKeys(agent)

      fire(DidCommRoutingEventTypes.RoutingCreatedEvent, routingCreated(contextCorrelationId, 'fp-new'))
      await new Promise((resolve) => setTimeout(resolve, 20))

      await expect(store.findTenantIdByFingerprints(['fp-new'])).resolves.toBeUndefined()
    })

    it('survives a Redis failure while indexing, and stops when told to', async () => {
      const { service, agent, store, redis, fire, listeners } = buildHarness()
      await service.put(agent, TENANT, { mode: 'HOLD' })
      const stop = service.watchRoutingKeys(agent)

      redis.failing = true
      fire(DidCommRoutingEventTypes.RoutingCreatedEvent, routingCreated(`tenant-${TENANT}`, 'fp-new'))
      await new Promise((resolve) => setTimeout(resolve, 20))
      redis.failing = false
      await expect(store.findTenantIdByFingerprints(['fp-new'])).resolves.toBeUndefined()

      stop()
      expect(listeners.get(DidCommRoutingEventTypes.RoutingCreatedEvent)).toEqual([])
    })
  })

  describe('rehydrate', () => {
    it('rebuilds the Redis state from the persisted entries and resumes a pending drain', async () => {
      const { service, agent, redis, store, drainer } = buildHarness()
      await service.put(agent, TENANT, { mode: 'HOLD' })
      await store.holdPush(TENANT, { receivedAt: 'now', contentType: 'x', body: '{}' })
      await service.put(agent, TENANT, { mode: 'FORWARD', target: TARGET })
      drainer.ensureDraining.mockClear()
      redis.strings.clear()

      await expect(service.rehydrate(agent)).resolves.toBe(1)

      expect(await store.getEntry(TENANT)).toMatchObject({ mode: 'FORWARD', target: TARGET })
      await expect(store.findTenantIdByFingerprints(['fp-1'])).resolves.toBe(TENANT)
      expect(drainer.ensureDraining).toHaveBeenCalledWith(TENANT)
    })

    it('does not overwrite an entry Redis already has, and still resumes its drain', async () => {
      const { service, agent, store, drainer } = buildHarness()
      await service.put(agent, TENANT, { mode: 'HOLD' })
      const newer = { tenantId: TENANT, mode: 'FORWARD' as const, target: TARGET, updatedAt: 'later' }
      await store.setEntry(newer)
      await store.holdPush(TENANT, { receivedAt: 'now', contentType: 'x', body: '{}' })
      drainer.ensureDraining.mockClear()

      await service.rehydrate(agent)

      expect(await store.getEntry(TENANT)).toEqual(newer)
      expect(drainer.ensureDraining).toHaveBeenCalledWith(TENANT)
    })

    it('backs out of an entry whose record was removed while it was being restored', async () => {
      const { service, agent, records, redis, store } = buildHarness()
      await service.put(agent, TENANT, { mode: 'HOLD' })
      redis.strings.clear()
      ;(service as unknown as { loadRelays: () => Promise<unknown> }).loadRelays = async () => {
        const snapshot = [{ entry: { tenantId: TENANT, mode: 'HOLD', updatedAt: 'now' }, fingerprints: ['fp-1'] }]
        records.clear()
        return snapshot
      }

      await service.rehydrate(agent)

      expect(await store.getEntry(TENANT)).toBeUndefined()
      await expect(store.findTenantIdByFingerprints(['fp-1'])).resolves.toBeUndefined()
    })

    it('does nothing when there are no relays', async () => {
      const { service, agent } = buildHarness()

      await expect(service.rehydrate(agent)).resolves.toBe(0)
    })
  })

  describe('the mirror', () => {
    it('knows a relay as soon as it is set, and forgets it when it is removed', async () => {
      const { service, agent } = buildHarness()

      await service.put(agent, TENANT, { mode: 'HOLD' })
      expect(service.mirror.find(['fp-2'])).toMatchObject({ tenantId: TENANT, mode: 'HOLD' })

      await service.remove(agent, TENANT)
      expect(service.mirror.find(['fp-2'])).toBeUndefined()
    })

    it('learns a recipient key Credo creates for a tenant it knows', async () => {
      const { service, agent, fire } = buildHarness()
      await service.put(agent, TENANT, { mode: 'HOLD' })
      service.watchRoutingKeys(agent)

      fire(DidCommRoutingEventTypes.RoutingCreatedEvent, {
        payload: { routing: { recipientKey: { fingerprint: 'fp-new' } } },
        metadata: { contextCorrelationId: `tenant-${TENANT}` },
      })

      expect(service.mirror.find(['fp-new'])?.tenantId).toBe(TENANT)
    })

    it('is filled by rehydrate', async () => {
      const first = buildHarness()
      await first.service.put(first.agent, TENANT, { mode: 'FORWARD', target: TARGET })
      const { service, agent, records } = buildHarness()
      for (const [id, record] of first.records) records.set(id, record)

      await service.rehydrate(agent)

      expect(service.mirror.find(['fp-1'])).toMatchObject({ mode: 'FORWARD', target: TARGET })
    })

    it('puts back an entry Redis has lost, and drains a buffer that was waiting', async () => {
      const { service, agent, redis, store, drainer } = buildHarness()
      await service.put(agent, TENANT, { mode: 'HOLD' })
      await store.holdPush(TENANT, { receivedAt: 'now', contentType: 'x', body: '{}' })
      await service.put(agent, TENANT, { mode: 'FORWARD', target: TARGET })
      drainer.ensureDraining.mockClear()
      redis.strings.clear()

      await service.refreshMirror(agent)

      expect(await store.getEntry(TENANT)).toMatchObject({ mode: 'FORWARD', target: TARGET })
      await expect(store.findTenantIdByFingerprints(['fp-1'])).resolves.toBe(TENANT)
      expect(drainer.ensureDraining).toHaveBeenCalledWith(TENANT)
    })

    it('does not overwrite an entry Redis still has with an older record', async () => {
      const { service, agent, store } = buildHarness()
      await service.put(agent, TENANT, { mode: 'HOLD' })
      const newer = { tenantId: TENANT, mode: 'FORWARD' as const, target: TARGET, updatedAt: 'later' }
      await store.setEntry(newer)

      await service.refreshMirror(agent)

      expect(await store.getEntry(TENANT)).toEqual(newer)
    })

    it('still reads the base wallet into the mirror when Redis is down', async () => {
      const { service, agent, redis, records } = buildHarness()
      await service.put(agent, TENANT, { mode: 'HOLD' })
      service.mirror.remove(TENANT)
      redis.failing = true

      await service.refreshMirror(agent)

      expect(service.mirror.find(['fp-1'])).toMatchObject({ tenantId: TENANT })
      expect(records.size).toBe(1)
    })

    it('refreshes on a timer until it is stopped', async () => {
      const { service, agent } = buildHarness()
      const refresh = jest.spyOn(service, 'refreshMirror')

      service.startMirror(agent, 10)
      await eventually(() => 2 <= refresh.mock.calls.length)
      service.stop()
      const calls = refresh.mock.calls.length
      await new Promise((resolve) => setTimeout(resolve, 40))

      expect(refresh.mock.calls.length).toBe(calls)
    })
  })

  it('reports whether Redis is reachable', async () => {
    const { service, redis } = buildHarness()

    await expect(service.health()).resolves.toEqual({ enabled: true, redisReady: true })
    redis.failing = true
    await expect(service.health()).resolves.toEqual({ enabled: true, redisReady: false })
  })
})
