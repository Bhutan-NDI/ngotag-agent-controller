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
})
