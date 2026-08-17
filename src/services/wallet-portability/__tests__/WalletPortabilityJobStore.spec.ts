/**
 * Regression test for WalletPortabilityJobStore's get()/save() Redis-vs-in-memory reconciliation.
 *
 * save() mirrors into the in-memory store whenever Redis is configured but unreachable at write
 * time, so the two stores can genuinely disagree about which is the *latest* record for a jobId —
 * not just whether one exists. get() previously preferred Redis unconditionally whenever it was
 * currently reachable, which meant a client polling a job that actually completed during a brief
 * Redis outage could see it stuck at its pre-outage status (e.g. `pending`) forever, since Redis's
 * own copy was never updated during the outage and nothing ever reconciled it against the newer
 * in-memory record.
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
 * this — real ioredis would require a real Redis server, and the whole point here is to control
 * exactly when the client is "ready" versus not, which no real server lets a test do on demand.
 *
 * Runs under Jest ESM mode (see jest.config.base.ts).
 */
import { jest } from '@jest/globals'
import { EventEmitter } from 'events'
import 'reflect-metadata'

class FakeRedisClient extends EventEmitter {
  private readonly store = new Map<string, string>()

  public async set(key: string, value: string): Promise<string | null> {
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

describe('WalletPortabilityJobStore — get() reconciliation', () => {
  it('returns the in-memory record when it is newer than a stale Redis one', async () => {
    const store = new WalletPortabilityJobStore(makeLogger() as never, 'redis://fake-host:6379')
    const redis = lastRedisClient as FakeRedisClient
    redis.emit('ready')

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
    const store = new WalletPortabilityJobStore(makeLogger() as never, 'redis://fake-host:6379')
    const redis = lastRedisClient as FakeRedisClient
    redis.emit('ready')

    const jobId = 'job-2'
    const record = {
      jobId,
      tenantId: 'tenant-2',
      type: WalletPortabilityJobType.Export,
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
