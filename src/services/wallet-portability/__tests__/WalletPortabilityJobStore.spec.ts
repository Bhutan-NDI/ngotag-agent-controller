/**
 * Regression tests for WalletPortabilityJobStore's Redis/in-memory dual-store behavior. Locks in
 * two fixes from a second review pass on the #72/#73 hardening work:
 *
 *   1. get() must reconcile a Redis record against a newer in-memory one, not prefer Redis
 *      unconditionally. save() mirrors into the in-memory store whenever Redis was unready at
 *      write time, so the two can genuinely disagree for the same jobId — Redis holding a stale
 *      record from before an outage while memory holds the true latest state (or the reverse, if
 *      Redis recovered mid-job and a later write landed there instead). Without reconciliation, a
 *      client polling a job that actually completed during a Redis blip would see it stuck at
 *      `pending` forever (until the 24h TTL), with the completed job's s3Key/checksum never
 *      surfaced.
 *   2. tryReserveActiveJob/releaseActiveJob must not diverge across the two stores depending on
 *      Redis's readiness *at each call* — a portability job runs for seconds to minutes, plenty
 *      of time for Redis's connection state to change between reserving and releasing. A
 *      reservation made through Redis is now also mirrored into memory, and release attempts the
 *      Redis delete whenever a client exists (not gated on isRedisReady()) while unconditionally
 *      also clearing the memory-side entry. Without this, a reservation can survive in whichever
 *      store the *other* call didn't touch, wedging the tenant for up to the 24h Redis TTL — or
 *      permanently, for the memory store, which has none.
 *
 * Also covers two follow-up fixes to the same >= tie-break:
 *   1. The tie-break itself could resurface a stale memory entry in the *mirror* direction: once
 *      Redis takes over a jobId again (a write lands there successfully after an earlier write
 *      went to memory during an outage), the old memory entry was never cleared, so a later write
 *      sharing the same updatedAt millisecond could still lose the tie-break to it. save() now
 *      deletes the memory mirror on a successful Redis write for that jobId.
 *   2. The in-memory store had no TTL of its own (unlike the Redis side, which self-expires via
 *      `EX`), so a REDIS_URL-less deployment (or any write that landed in memory during an
 *      outage) retained every job record for the life of the process. Entries now carry an
 *      expiresAt, checked lazily on read and swept on every write.
 *
 * A minimal fake ioredis client (a real EventEmitter backing an in-memory key/value store, with
 * the same connect/ready/reconnecting event names WalletPortabilityJobStore listens for) drives
 * these — real ioredis would require a real Redis server, and the whole point here is to control
 * exactly when the client is "ready" versus not, which no real server lets a test do on demand.
 *
 * Runs under Jest ESM mode (see jest.config.base.ts).
 */
import { jest } from '@jest/globals'
import { EventEmitter } from 'events'
import 'reflect-metadata'

class FakeRedisClient extends EventEmitter {
  private readonly store = new Map<string, string>()

  public async set(key: string, value: string, ...args: unknown[]): Promise<string | null> {
    const nx = args.includes('NX')
    if (nx && this.store.has(key)) return null
    this.store.set(key, value)
    return 'OK'
  }

  public async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null
  }

  public async del(key: string): Promise<number> {
    return this.store.delete(key) ? 1 : 0
  }

  public async quit(): Promise<void> {
    // no-op — real ioredis's quit() closes the connection; nothing to close here.
  }
}

let lastRedisClient: FakeRedisClient | undefined
const RedisConstructorMock = jest.fn(() => {
  lastRedisClient = new FakeRedisClient()
  return lastRedisClient
})

jest.unstable_mockModule('ioredis', () => ({
  Redis: RedisConstructorMock,
}))

const { WalletPortabilityJobStore } = await import('../WalletPortabilityJobStore')
const { WalletPortabilityJobStatus, WalletPortabilityJobType } = await import('../WalletPortabilityTypes')

const makeLogger = () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
})

// Constructs a store and brings its (fake) Redis connection to the 'ready' state — mirrors what
// attachEventHandlers actually listens for, so isRedisReady() reports true afterward.
function makeReadyStore(): { store: InstanceType<typeof WalletPortabilityJobStore>; redis: FakeRedisClient } {
  const store = new WalletPortabilityJobStore(makeLogger() as never, 'redis://fake-host:6379')
  const redis = lastRedisClient as FakeRedisClient
  redis.emit('ready')
  return { store, redis }
}

describe('WalletPortabilityJobStore — get() reconciliation', () => {
  it('returns the in-memory record when it is newer than a stale Redis one', async () => {
    const { store, redis } = makeReadyStore()
    const jobId = 'job-1'
    const staleRecord = {
      jobId,
      tenantId: 'tenant-1',
      type: WalletPortabilityJobType.Export,
      status: WalletPortabilityJobStatus.Pending,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }
    await store.save(staleRecord) // lands in "Redis" — ready at this point

    // Redis blips — save() must fall back to the in-memory mirror for this write.
    redis.emit('reconnecting')
    const newerRecord = {
      ...staleRecord,
      status: WalletPortabilityJobStatus.Completed,
      updatedAt: '2026-01-01T00:05:00.000Z',
      s3Key: 'wallet-exports/tenant-1/job-1.db.gz',
      checksum: 'deadbeef',
    }
    await store.save(newerRecord)

    // Redis recovers, but its own copy is still the stale one saved before the blip — get() must
    // not just prefer it because Redis is ready again.
    redis.emit('ready')

    const result = await store.get(jobId)
    expect(result).toEqual(newerRecord)
  })

  it('prefers the in-memory record on an updatedAt tie, not the Redis one', async () => {
    // updatedAt is millisecond-resolution, and consecutive writes for one job routinely share a
    // millisecond (e.g. exportWallet's initial Pending save and runExport's very next
    // setJobStatus(InProgress) call, only a couple of microtasks apart). A memoryStore entry only
    // exists because Redis was unavailable for *that* write, so on a tie it is the later of the
    // two, not whichever store get() would otherwise default to.
    const store = new WalletPortabilityJobStore(makeLogger() as never, 'redis://fake-host:6379')
    const redis = lastRedisClient as FakeRedisClient
    redis.emit('ready')

    const jobId = 'job-3'
    const tiedUpdatedAt = '2026-01-01T00:00:00.123Z'
    const pendingRecord = {
      jobId,
      tenantId: 'tenant-3',
      type: WalletPortabilityJobType.Export,
      status: WalletPortabilityJobStatus.Pending,
      createdAt: tiedUpdatedAt,
      updatedAt: tiedUpdatedAt,
    }
    await store.save(pendingRecord) // lands in Redis — ready at this point

    // Redis blips before the very next write, which lands in the same millisecond.
    redis.emit('reconnecting')
    const inProgressRecord = {
      ...pendingRecord,
      status: WalletPortabilityJobStatus.InProgress,
      updatedAt: tiedUpdatedAt,
    }
    await store.save(inProgressRecord)

    redis.emit('ready')
    expect(await store.get(jobId)).toEqual(inProgressRecord)
  })

  it('returns the Redis record when no in-memory record exists for the jobId', async () => {
    const { store } = makeReadyStore()
    const jobId = 'job-2'
    const record = {
      jobId,
      tenantId: 'tenant-2',
      type: WalletPortabilityJobType.Import,
      status: WalletPortabilityJobStatus.Completed,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }
    await store.save(record)

    expect(await store.get(jobId)).toEqual(record)
  })

  it('does not resurface a stale memory mirror once Redis has taken over the same jobId — the mirror-direction tie', async () => {
    // The reverse of the very first test above: Redis is unavailable for the *earlier* write
    // (lands in memory), then recovers before the *next* write for the same job, which lands in
    // Redis instead — sharing the same updatedAt millisecond (Pending -> InProgress is only a
    // couple of microtasks apart, the same collision the >= tie-break was written for). Without
    // clearing the memory mirror on a successful Redis write, get()'s >= tie-break would still
    // find the stale Pending entry in memory and incorrectly prefer it over the correct,
    // newer InProgress record Redis actually holds.
    const store = new WalletPortabilityJobStore(makeLogger() as never, 'redis://fake-host:6379')
    const redis = lastRedisClient as FakeRedisClient
    // Starts unready — the constructor leaves connectionState at 'connecting', not 'ready'.

    const jobId = 'job-4'
    const tiedUpdatedAt = '2026-01-01T00:00:00.456Z'
    const pendingRecord = {
      jobId,
      tenantId: 'tenant-4',
      type: WalletPortabilityJobType.Export,
      status: WalletPortabilityJobStatus.Pending,
      createdAt: tiedUpdatedAt,
      updatedAt: tiedUpdatedAt,
    }
    await store.save(pendingRecord) // Redis unready — lands in memory only.

    redis.emit('ready')
    const inProgressRecord = {
      ...pendingRecord,
      status: WalletPortabilityJobStatus.InProgress,
      updatedAt: tiedUpdatedAt,
    }
    await store.save(inProgressRecord) // Redis ready now — lands in Redis, memory mirror cleared.

    expect(await store.get(jobId)).toEqual(inProgressRecord)
  })

  it('reclaims an expired in-memory entry instead of returning it forever — no Redis, no TTL of its own otherwise', async () => {
    const nowSpy = jest.spyOn(Date, 'now')
    const startedAt = 1_000_000
    nowSpy.mockReturnValue(startedAt)

    const store = new WalletPortabilityJobStore(makeLogger() as never, undefined)
    const jobId = 'job-5'
    const record = {
      jobId,
      tenantId: 'tenant-5',
      type: WalletPortabilityJobType.Export,
      status: WalletPortabilityJobStatus.Completed,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }
    await store.save(record)
    expect(await store.get(jobId)).toEqual(record)

    // Well past the 24h TTL (JOB_TTL_SECONDS) applied in application code to the memory mirror.
    nowSpy.mockReturnValue(startedAt + 25 * 60 * 60 * 1000)
    expect(await store.get(jobId)).toBeUndefined()

    nowSpy.mockRestore()
  })
})

describe('WalletPortabilityJobStore — active-job reservation/release', () => {
  it('mirrors a Redis-side reservation into memory, and releasing while Redis looks unready still clears it', async () => {
    const { store, redis } = makeReadyStore()
    const tenantId = 'tenant-1'
    const jobId = 'job-1'

    expect(await store.tryReserveActiveJob(tenantId, jobId)).toBeUndefined()

    // Redis drops before the job finishes — release must not skip the Redis delete just because
    // isRedisReady() is currently false; the key is still sitting in Redis from the reservation
    // above and needs to actually be removed, not just the memory mirror.
    redis.emit('reconnecting')
    await store.releaseActiveJob(tenantId, jobId)

    // If either store still held the reservation, this would return the stale jobId instead of
    // undefined.
    redis.emit('ready')
    expect(await store.tryReserveActiveJob(tenantId, 'job-2')).toBeUndefined()
  })

  it('does not release a newer reservation for the same tenant', async () => {
    const { store, redis } = makeReadyStore()
    const tenantId = 'tenant-1'

    expect(await store.tryReserveActiveJob(tenantId, 'job-1')).toBeUndefined()
    // A second reservation attempt for the same tenant is rejected with the existing holder.
    expect(await store.tryReserveActiveJob(tenantId, 'job-2')).toBe('job-1')

    // Releasing the wrong (non-current) jobId must not clobber job-1's still-active reservation.
    await store.releaseActiveJob(tenantId, 'job-2')
    redis.emit('ready')
    expect(await store.tryReserveActiveJob(tenantId, 'job-3')).toBe('job-1')
  })

  it('falls back to memory-only reservation when Redis is unready at reserve time, and releases it correctly', async () => {
    const logger = makeLogger()
    const store = new WalletPortabilityJobStore(logger as never, 'redis://fake-host:6379')
    // Never emits 'ready' — isRedisReady() stays false throughout, exercising the pure in-memory
    // path on both ends.
    const tenantId = 'tenant-1'
    const jobId = 'job-1'

    expect(await store.tryReserveActiveJob(tenantId, jobId)).toBeUndefined()
    expect(await store.tryReserveActiveJob(tenantId, 'job-2')).toBe(jobId)

    await store.releaseActiveJob(tenantId, jobId)
    expect(await store.tryReserveActiveJob(tenantId, 'job-3')).toBeUndefined()
  })

  it('a memory-only reservation is still seen once Redis recovers — the divergence runs both directions', async () => {
    // Mirrors makeReadyStore's constructor but deliberately does NOT emit 'ready' yet, so the
    // first reservation is forced into the memory-only path (isRedisReady() is false at that
    // point) exactly like a real reservation made during a Redis outage.
    const store = new WalletPortabilityJobStore(makeLogger() as never, 'redis://fake-host:6379')
    const redis = lastRedisClient as FakeRedisClient
    const tenantId = 'tenant-1'

    expect(await store.tryReserveActiveJob(tenantId, 'job-A')).toBeUndefined()

    // Redis recovers mid-job — well within the "seconds to minutes" a real portability job runs.
    redis.emit('ready')

    // A second reservation attempt must still see job-A's memory-only reservation, not fall
    // through to the now-ready Redis branch (which has no key for this tenant at all, since the
    // first reservation never reached Redis) and wrongly admit a second concurrent job.
    expect(await store.tryReserveActiveJob(tenantId, 'job-B')).toBe('job-A')
  })
})
