import { RelayStore } from '../RelayStore'
import { HOLD_BUFFER_CAP, HOLD_BUFFER_TTL_SECONDS, holdBufferCap, holdBufferTtlSeconds } from '../relayConfig'

import { FakeRedis } from './testSupport'

const TENANT = 'tenant-1'
const envelope = (n: number) => ({
  receivedAt: '2026-10-20T00:00:00.000Z',
  contentType: 'application/didcomm-envelope-enc',
  body: `{"n":${n}}`,
})

describe('RelayStore', () => {
  let redis: FakeRedis
  let store: RelayStore

  beforeEach(() => {
    redis = new FakeRedis()
    store = new RelayStore(redis)
  })

  it('finds the tenant that owns any of the given recipient keys, with one lookup', async () => {
    await store.indexKeys(TENANT, ['fp-a', 'fp-b'])
    redis.calls = []

    await expect(store.findTenantIdByFingerprints(['unknown', 'fp-b'])).resolves.toBe(TENANT)
    expect(redis.calls).toEqual(['mget'])
    await expect(store.findTenantIdByFingerprints(['unknown'])).resolves.toBeUndefined()
    await expect(store.findTenantIdByFingerprints([])).resolves.toBeUndefined()
  })

  it('indexes and removes keys in chunks larger than one pipeline', async () => {
    const fingerprints = Array.from({ length: 1234 }, (_, i) => `fp-${i}`)

    await store.indexKeys(TENANT, fingerprints)
    await expect(store.findTenantIdByFingerprints(['fp-1233'])).resolves.toBe(TENANT)

    await store.removeKeys(fingerprints)
    await expect(store.findTenantIdByFingerprints(['fp-0', 'fp-1233'])).resolves.toBeUndefined()
  })

  it('stores and deletes an entry', async () => {
    const entry = { tenantId: TENANT, mode: 'FORWARD' as const, target: 'https://a.example.org/', updatedAt: 'now' }

    await store.setEntry(entry)
    await expect(store.getEntry(TENANT)).resolves.toEqual(entry)

    await store.deleteEntry(TENANT)
    await expect(store.getEntry(TENANT)).resolves.toBeUndefined()
  })

  describe('hold buffer', () => {
    it('keeps envelopes in arrival order and refreshes the buffer lifetime', async () => {
      await store.holdPush(TENANT, envelope(1))
      await store.holdPush(TENANT, envelope(2))

      expect(await store.holdLength(TENANT)).toBe(2)
      expect((await store.holdPeek(TENANT))?.body).toBe('{"n":1}')
      await store.holdPop(TENANT)
      expect((await store.holdPeek(TENANT))?.body).toBe('{"n":2}')
      expect(redis.ttls.get(`relay:hold:${TENANT}`)).toBe(HOLD_BUFFER_TTL_SECONDS)
    })

    it('refuses an envelope once the buffer is full, and stores nothing', async () => {
      redis.lists.set(
        `relay:hold:${TENANT}`,
        Array.from({ length: HOLD_BUFFER_CAP }, () => JSON.stringify(envelope(0))),
      )

      await expect(store.holdPush(TENANT, envelope(1))).resolves.toBe(false)
      expect(await store.holdLength(TENANT)).toBe(HOLD_BUFFER_CAP)
    })

    it('drops an unreadable item instead of letting it block the buffer', async () => {
      redis.lists.set(`relay:hold:${TENANT}`, ['not json', JSON.stringify(envelope(7))])

      expect((await store.holdPeek(TENANT))?.body).toBe('{"n":7}')
      expect(await store.holdLength(TENANT)).toBe(1)
    })

    it('has nothing to peek in an empty buffer', async () => {
      await expect(store.holdPeek(TENANT)).resolves.toBeUndefined()
    })
  })

  describe('drain lock', () => {
    it('is exclusive, refreshable only by its holder, and released only by its holder', async () => {
      await expect(store.acquireDrainLock(TENANT, 'a')).resolves.toBe(true)
      await expect(store.acquireDrainLock(TENANT, 'b')).resolves.toBe(false)

      await expect(store.refreshDrainLock(TENANT, 'a')).resolves.toBe(true)
      await expect(store.refreshDrainLock(TENANT, 'b')).resolves.toBe(false)

      await store.releaseDrainLock(TENANT, 'b')
      await expect(store.acquireDrainLock(TENANT, 'c')).resolves.toBe(false)
      await store.releaseDrainLock(TENANT, 'a')
      await expect(store.acquireDrainLock(TENANT, 'c')).resolves.toBe(true)
    })
  })

  describe('counters', () => {
    it('counts messages per day and sums a rolling window', async () => {
      const now = new Date('2026-10-20T12:00:00Z')
      await store.recordMessage(TENANT, 'fp-a', now)
      await store.recordMessage(TENANT, 'fp-a', now)
      await store.recordMessage(TENANT, 'fp-b', new Date('2026-10-18T12:00:00Z'))
      await store.recordMessage(TENANT, 'fp-b', new Date('2026-08-01T12:00:00Z'))

      await expect(store.messagesInLastDays(TENANT, 30, now)).resolves.toBe(3)
      await expect(store.messagesInLastDays(TENANT, 1, now)).resolves.toBe(2)
      expect(redis.hashes.get('relay:seen:fp-a')?.get('count')).toBe('2')
      expect(redis.hashes.get('relay:seen:fp-a')?.get('last')).toBe(now.toISOString())
    })
  })

  it('reports readiness from a ping, and not ready when Redis is down', async () => {
    await expect(store.isReady()).resolves.toBe(true)
    redis.failing = true
    await expect(store.isReady()).resolves.toBe(false)
  })

  describe('the buffer limits', () => {
    afterEach(() => {
      delete process.env.MIGRATION_RELAY_HOLD_CAP
      delete process.env.MIGRATION_RELAY_HOLD_TTL_SECONDS
    })

    it('default to 10,000 messages and 24 hours', () => {
      expect(holdBufferCap({})).toBe(10_000)
      expect(holdBufferTtlSeconds({})).toBe(24 * 60 * 60)
    })

    it.each(['0', '-5', 'abc', '1.5', ''])('ignore %j and keep the default', (value) => {
      expect(holdBufferCap({ MIGRATION_RELAY_HOLD_CAP: value })).toBe(HOLD_BUFFER_CAP)
      expect(holdBufferTtlSeconds({ MIGRATION_RELAY_HOLD_TTL_SECONDS: value })).toBe(HOLD_BUFFER_TTL_SECONDS)
    })

    it('come from the environment when it sets them', async () => {
      process.env.MIGRATION_RELAY_HOLD_CAP = '2'
      process.env.MIGRATION_RELAY_HOLD_TTL_SECONDS = '60'

      await expect(store.holdPush(TENANT, envelope(1))).resolves.toBe(true)
      await expect(store.holdPush(TENANT, envelope(2))).resolves.toBe(true)
      await expect(store.holdPush(TENANT, envelope(3))).resolves.toBe(false)
      expect(await store.holdLength(TENANT)).toBe(2)
      expect(redis.ttls.get(`relay:hold:${TENANT}`)).toBe(60)
    })
  })
})
