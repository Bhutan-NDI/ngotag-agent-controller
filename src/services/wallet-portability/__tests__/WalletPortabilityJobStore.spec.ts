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
 *   3. The dead-job reclaim added for (2) had its own race: exportWallet/importWallet reserve the
 *      slot BEFORE writing the job's own Pending record, so a brand-new, perfectly live
 *      reservation genuinely has no backing record for the first few milliseconds. Reading "no
 *      record" as "the previous holder is dead" the instant it's checked let a second
 *      near-simultaneous request reclaim the slot and run a second concurrent job for the same
 *      tenant. A grace period (RESERVATION_GRACE_PERIOD_MS) now only treats a record-less
 *      reservation as dead once it has clearly outlived that window; a Redis read that errors
 *      entirely (e.g. a commandTimeout) is treated as "still active" rather than "not found",
 *      since a transient failure must never be mistaken for a dead job either; and the Redis-side
 *      reclaim itself is now a Lua compare-and-swap (RECLAIM_IF_UNCHANGED_SCRIPT), not a plain
 *      SET-after-GET, so two concurrent reclaimers racing the same stale holder can't both win.
 *
 * A second review pass on this same reservation logic (2026-08-17) found three more races, all
 * fixed here too:
 *   4. The "Redis read failed" fail-safe (point 3 above) only covered a *thrown* read — when
 *      Redis is merely unready (reconnecting/closed), the read is never attempted at all, so the
 *      fail-safe never tripped and a live job's slot could be reclaimed once the grace period
 *      elapsed, purely because this process couldn't currently see Redis. getWithReadStatus now
 *      reports unavailable (redisUnavailable) whenever Redis is configured but not ready, not just
 *      when a read throws — a REDIS_URL-less deployment is unaffected, since that's a legitimate
 *      memory-only mode, not an outage.
 *   5. tryReserveActiveJob's own catch block previously fell through to the unconditional
 *      in-memory grant at the bottom of the method even when Redis had already answered "the slot
 *      is taken" (SET ... NX refused) — a follow-up round trip (the holder GET, or the reclaim CAS
 *      eval) timing out afterward silently discarded that answer and admitted a second concurrent
 *      job. A flag now tracks whether Redis already refused the reservation before the try block's
 *      remaining round trips; if so, the catch reports the slot as held by an indeterminate holder
 *      (UNKNOWN_HOLDER_JOB_ID) instead of granting it.
 *   6. releaseActiveJob was a non-atomic GET-then-DEL: between the two round trips, a newer
 *      reservation could legitimately take over the slot, and the DEL would then remove that new
 *      owner's key even though the jobId being released was the owner when the GET ran. Replaced
 *      with RELEASE_IF_OWNED_SCRIPT, a single atomic compare-and-delete (matching the shape of the
 *      reclaim script's own compare-and-swap).
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
  // Test hook: makes the next get() call throw once, then auto-resets — models a transient Redis
  // read failure (e.g. a commandTimeout) without needing a real flaky connection.
  public failNextGet = false
  // Test hook: makes the Nth get() call for a specific key return null regardless of the store's
  // actual contents, then auto-resets — models the previous holder releasing (or its key
  // otherwise vanishing) in the exact window between an NX refusal/CAS loss and the immediately
  // following read that tries to identify who holds the slot now. Keyed per-key + call-number
  // (not just "the next get() overall") since isReservationStillActive makes its own get() calls
  // against a *different* key (the job record) in between the two active-job-key reads this
  // targets.
  public hideKeyOnCall: { key: string; callNumber: number } | undefined
  private getCallCountByKey = new Map<string, number>()
  // Test hook: makes the next eval() call report a CAS loss (0) regardless of whether the
  // key's value actually still matches — models a genuine race where a different process's own
  // reclaim/release already changed the key by the time this caller's compare-and-swap runs.
  public forceNextEvalMiss = false

  public async set(key: string, value: string, ...args: unknown[]): Promise<string | null> {
    const nx = args.includes('NX')
    if (nx && this.store.has(key)) return null
    this.store.set(key, value)
    return 'OK'
  }

  public async get(key: string): Promise<string | null> {
    if (this.failNextGet) {
      this.failNextGet = false
      throw new Error('simulated transient Redis read failure')
    }
    const callNumber = (this.getCallCountByKey.get(key) ?? 0) + 1
    this.getCallCountByKey.set(key, callNumber)
    if (this.hideKeyOnCall && this.hideKeyOnCall.key === key && this.hideKeyOnCall.callNumber === callNumber) {
      this.hideKeyOnCall = undefined
      return null
    }
    return this.store.get(key) ?? null
  }

  public async del(key: string): Promise<number> {
    return this.store.delete(key) ? 1 : 0
  }

  // Faithful-enough model of both Lua scripts' server-side-atomic semantics — real ioredis
  // executes them atomically on the server; this fake just runs the equivalent JS synchronously
  // (JS itself has no concurrent access to race against here). Branches on the script text since
  // both RECLAIM_IF_UNCHANGED_SCRIPT and RELEASE_IF_OWNED_SCRIPT go through this one method with
  // different arg shapes.
  public async eval(script: string, _numKeys: number, key: string, ...args: string[]): Promise<number> {
    if (this.forceNextEvalMiss) {
      this.forceNextEvalMiss = false
      return 0
    }
    if (script.includes('cjson')) {
      // RELEASE_IF_OWNED_SCRIPT: ARGV[1] is the plain jobId, not the full reservation JSON —
      // releaseActiveJob only ever has (tenantId, jobId) to compare with, not the reservedAt the
      // key was originally written with.
      const [jobId] = args
      const current = this.store.get(key)
      if (!current) return 0
      let parsed: { jobId?: string }
      try {
        parsed = JSON.parse(current) as { jobId?: string }
      } catch {
        return 0
      }
      if (parsed.jobId !== jobId) return 0
      this.store.delete(key)
      return 1
    }
    // RECLAIM_IF_UNCHANGED_SCRIPT: ARGV is [expectedOld, newVal, ttlSeconds].
    const [expectedOld, newVal] = args
    if (this.store.get(key) === expectedOld) {
      this.store.set(key, newVal)
      return 1
    }
    return 0
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

// Real callers (exportWallet/importWallet) reserve the slot *before* saving the job's own Pending
// record, so a reservation genuinely can briefly outrun its own record — but by the time a test
// wants to assert a reservation is still correctly exclusive, the real job would already have one.
// Used to give a "still active" holder a backing record, so isJobStillActive() (dead-reservation
// reclaim) doesn't mistake "no record yet" for "definitely dead" and reclaim it out from under a
// test that's asserting the opposite.
function makePendingRecord(jobId: string, tenantId: string) {
  return {
    jobId,
    tenantId,
    type: WalletPortabilityJobType.Import,
    status: WalletPortabilityJobStatus.Pending,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }
}

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
    await store.save(makePendingRecord('job-1', tenantId))
    // A second reservation attempt for the same tenant is rejected with the existing holder.
    expect(await store.tryReserveActiveJob(tenantId, 'job-2')).toBe('job-1')

    // Releasing the wrong (non-current) jobId must not clobber job-1's still-active reservation.
    await store.releaseActiveJob(tenantId, 'job-2')
    redis.emit('ready')
    expect(await store.tryReserveActiveJob(tenantId, 'job-3')).toBe('job-1')
  })

  it('reclaims a Redis-side reservation whose job has already reached a terminal status — a crash-recovery path, not just the 24h TTL', async () => {
    const { store } = makeReadyStore()
    const tenantId = 'tenant-1'

    expect(await store.tryReserveActiveJob(tenantId, 'job-1')).toBeUndefined()
    // job-1's own record reached a terminal status (e.g. its finally ran, or a later poll found
    // it Completed) but, for whatever reason, releaseActiveJob was never called for it — the
    // process died between the two. Without reclaiming, this would 409 the tenant for up to the
    // full 24h TTL even though nothing is actually running.
    await store.save({ ...makePendingRecord('job-1', tenantId), status: WalletPortabilityJobStatus.Completed })

    expect(await store.tryReserveActiveJob(tenantId, 'job-2')).toBeUndefined()
    // job-2 is now the genuinely active holder — a third job must still be blocked by it.
    await store.save(makePendingRecord('job-2', tenantId))
    expect(await store.tryReserveActiveJob(tenantId, 'job-3')).toBe('job-2')
  })

  it('falls back to memory-only reservation when Redis is unready at reserve time, and releases it correctly', async () => {
    const logger = makeLogger()
    const store = new WalletPortabilityJobStore(logger as never, 'redis://fake-host:6379')
    // Never emits 'ready' — isRedisReady() stays false throughout, exercising the pure in-memory
    // path on both ends.
    const tenantId = 'tenant-1'
    const jobId = 'job-1'

    expect(await store.tryReserveActiveJob(tenantId, jobId)).toBeUndefined()
    await store.save(makePendingRecord(jobId, tenantId))
    expect(await store.tryReserveActiveJob(tenantId, 'job-2')).toBe(jobId)

    await store.releaseActiveJob(tenantId, jobId)
    expect(await store.tryReserveActiveJob(tenantId, 'job-3')).toBeUndefined()
  })

  it('reclaims a memory-only reservation whose job has already reached a terminal status — memory has no TTL at all, so this is the only way it ever clears', async () => {
    const store = new WalletPortabilityJobStore(makeLogger() as never, 'redis://fake-host:6379')
    // Never emits 'ready' — pure in-memory path throughout.
    const tenantId = 'tenant-1'

    expect(await store.tryReserveActiveJob(tenantId, 'job-1')).toBeUndefined()
    await store.save({ ...makePendingRecord('job-1', tenantId), status: WalletPortabilityJobStatus.Failed })

    expect(await store.tryReserveActiveJob(tenantId, 'job-2')).toBeUndefined()
  })

  it('a memory-only reservation is still seen once Redis recovers — the divergence runs both directions', async () => {
    // Mirrors makeReadyStore's constructor but deliberately does NOT emit 'ready' yet, so the
    // first reservation is forced into the memory-only path (isRedisReady() is false at that
    // point) exactly like a real reservation made during a Redis outage.
    const store = new WalletPortabilityJobStore(makeLogger() as never, 'redis://fake-host:6379')
    const redis = lastRedisClient as FakeRedisClient
    const tenantId = 'tenant-1'

    expect(await store.tryReserveActiveJob(tenantId, 'job-A')).toBeUndefined()
    await store.save(makePendingRecord('job-A', tenantId))

    // Redis recovers mid-job — well within the "seconds to minutes" a real portability job runs.
    redis.emit('ready')

    // A second reservation attempt must still see job-A's memory-only reservation, not fall
    // through to the now-ready Redis branch (which has no key for this tenant at all, since the
    // first reservation never reached Redis) and wrongly admit a second concurrent job.
    expect(await store.tryReserveActiveJob(tenantId, 'job-B')).toBe('job-A')
  })

  it('does not reclaim a still-fresh, record-less reservation — the near-simultaneous-request race the grace period exists for', async () => {
    // exportWallet/importWallet reserve the slot BEFORE writing the job's own Pending record (see
    // WalletPortabilityService), so a brand-new, perfectly live reservation genuinely has no
    // backing record for the first few milliseconds. Without a grace period, a second request
    // landing in that exact window would misread "no record" as "the holder is dead" and admit a
    // second concurrent job — this is the #73 review's dead-job-reclaim race.
    const { store } = makeReadyStore()
    const tenantId = 'tenant-1'

    expect(await store.tryReserveActiveJob(tenantId, 'job-A')).toBeUndefined()
    // job-A's own save() hasn't landed yet — still, job-B must be blocked, not admitted.
    expect(await store.tryReserveActiveJob(tenantId, 'job-B')).toBe('job-A')
  })

  it('reclaims a record-less reservation once the grace period has elapsed — a genuine crash before the first save()', async () => {
    const nowSpy = jest.spyOn(Date, 'now')
    const startedAt = 1_000_000
    nowSpy.mockReturnValue(startedAt)
    const { store } = makeReadyStore()
    const tenantId = 'tenant-1'

    expect(await store.tryReserveActiveJob(tenantId, 'job-A')).toBeUndefined()
    // job-A crashes before ever calling save() — no record ever appears for it. Well past any
    // reasonable grace period (15s in the real constant; 60s here to comfortably clear it):
    nowSpy.mockReturnValue(startedAt + 60_000)
    expect(await store.tryReserveActiveJob(tenantId, 'job-B')).toBeUndefined()

    nowSpy.mockRestore()
  })

  it('reclaims a Pending reservation once its grace period has elapsed — a crash/restart between the Pending save and the first InProgress write', async () => {
    // #73 review: the InProgress staleness check only closed half the 24h-wedge bug -- a
    // crash/restart between exportWallet/importWallet's initial Pending save and runExport/
    // runImport's first setJobStatus(InProgress) call left a Pending record that read as "still
    // running" unconditionally, for the whole 24h JOB_TTL_SECONDS.
    const nowSpy = jest.spyOn(Date, 'now')
    const startedAt = 1_000_000
    nowSpy.mockReturnValue(startedAt)
    const { store } = makeReadyStore()
    const tenantId = 'tenant-1'

    expect(await store.tryReserveActiveJob(tenantId, 'job-A')).toBeUndefined()
    // job-A's own record reaches Pending -- the very first write -- but the process dies before
    // ever reaching the first setJobStatus(InProgress) call.
    await store.save(makePendingRecord('job-A', tenantId))

    // Past RESERVATION_GRACE_PERIOD_MS (15s) -- comfortably past Pending's one-save()-round-trip
    // legitimate lifetime.
    nowSpy.mockReturnValue(startedAt + 60_000)
    expect(await store.tryReserveActiveJob(tenantId, 'job-B')).toBeUndefined()

    nowSpy.mockRestore()
  })

  it('does not reclaim a genuinely fresh Pending reservation — the near-simultaneous-request race this shares with the record-less case', async () => {
    const nowSpy = jest.spyOn(Date, 'now')
    const startedAt = 1_000_000
    nowSpy.mockReturnValue(startedAt)
    const { store } = makeReadyStore()
    const tenantId = 'tenant-1'

    expect(await store.tryReserveActiveJob(tenantId, 'job-A')).toBeUndefined()
    await store.save(makePendingRecord('job-A', tenantId))

    nowSpy.mockReturnValue(startedAt + 1_000) // well within the grace period
    expect(await store.tryReserveActiveJob(tenantId, 'job-B')).toBe('job-A')

    nowSpy.mockRestore()
  })

  it('treats a failed Redis read as "still active" — a transient timeout must never be mistaken for a dead job', async () => {
    const { store, redis } = makeReadyStore()
    const tenantId = 'tenant-1'

    expect(await store.tryReserveActiveJob(tenantId, 'job-A')).toBeUndefined()
    await store.save(makePendingRecord('job-A', tenantId))

    // Simulates a commandTimeout on the read used to decide whether job-A is still active — must
    // fail safe (treat as active) rather than reclaim the slot out from under a genuinely live job.
    redis.failNextGet = true
    expect(await store.tryReserveActiveJob(tenantId, 'job-B')).toBe('job-A')
  })

  it('two concurrent reclaimers racing the same stale holder do not both win — only one job is admitted', async () => {
    const { store, redis } = makeReadyStore()
    const tenantId = 'tenant-1'

    expect(await store.tryReserveActiveJob(tenantId, 'job-A')).toBeUndefined()
    await store.save({ ...makePendingRecord('job-A', tenantId), status: WalletPortabilityJobStatus.Completed })

    // Both reclaimers observe the same stale holder (job-A, terminal) before either one's atomic
    // swap lands — a plain SET-after-GET here would let both "win" and both get admitted.
    const [resultB, resultC] = await Promise.all([
      store.tryReserveActiveJob(tenantId, 'job-B'),
      store.tryReserveActiveJob(tenantId, 'job-C'),
    ])

    // Exactly one of the two must have been admitted (undefined); the other must have been told
    // the winner's jobId, never both undefined.
    const admitted = [resultB, resultC].filter((r) => r === undefined)
    expect(admitted).toHaveLength(1)

    // Whichever job won, it must now be the one blocking a further reservation attempt.
    const winnerJobId = resultB === undefined ? 'job-B' : 'job-C'
    await store.save(makePendingRecord(winnerJobId, tenantId))
    expect(await store.tryReserveActiveJob(tenantId, 'job-D')).toBe(winnerJobId)
  })

  it('treats Redis being merely unready (not just a failed read) as still active — a live job must not be reclaimed just because this process cannot currently see Redis', async () => {
    const nowSpy = jest.spyOn(Date, 'now')
    const startedAt = 1_000_000
    nowSpy.mockReturnValue(startedAt)

    const { store, redis } = makeReadyStore()
    const tenantId = 'tenant-1'

    expect(await store.tryReserveActiveJob(tenantId, 'job-A')).toBeUndefined()
    // job-A's Pending save lands in Redis (ready at this point) — its Redis-success branch clears
    // the memory mirror, so memory now holds nothing for job-A's own job record, only the
    // activeJobMemoryStore reservation entry mirrored at reserve time.
    await store.save(makePendingRecord('job-A', tenantId))

    // Redis drops. No read ever throws here — the fail-safe from a failed read alone would not
    // catch this; the connection is simply not ready, so getWithReadStatus's Redis branch is
    // skipped entirely.
    redis.emit('reconnecting')

    // Advanced well past RESERVATION_GRACE_PERIOD_MS (15s) — proves this isn't the grace period
    // saving us. The pre-fix code would treat "no record visible, past the grace period" as dead
    // and reclaim it; the fix must refuse to reclaim purely because Redis is unavailable, not
    // because the job might still be within its grace window.
    nowSpy.mockReturnValue(startedAt + 60_000)

    expect(await store.tryReserveActiveJob(tenantId, 'job-B')).toBe('job-A')

    nowSpy.mockRestore()
  })

  it('does not grant the slot when Redis already refused the reservation and a follow-up round trip then fails — fails closed, not open', async () => {
    const { store, redis } = makeReadyStore()
    const tenantId = 'tenant-1'
    // Seeded directly on the fake Redis store, bypassing tryReserveActiveJob entirely — models a
    // *different* process/instance holding the slot, so this store's own activeJobMemoryStore has
    // no entry for it. Without that, the existingInMemory fail-safe check at the very top of
    // tryReserveActiveJob would consume the injected Redis failure below on job-A's own record
    // lookup, never reaching the code path this test actually targets. Prefix matches
    // ACTIVE_JOB_KEY_PREFIX.
    await redis.set(
      `walletPortabilityActiveJob:${tenantId}`,
      JSON.stringify({ jobId: 'job-A', reservedAt: Date.now() }),
    )

    // SET ... NX is refused (the key already exists) — the follow-up holder lookup (the GET right
    // after NX is refused) then fails.
    redis.failNextGet = true
    const result = await store.tryReserveActiveJob(tenantId, 'job-B')

    // Must not be undefined (granted) — Redis already said the slot was taken before this round
    // trip failed; discarding that answer and granting anyway is the bug. The holder is genuinely
    // unknown (that's the round trip that just failed), but the slot must still be reported held.
    expect(typeof result).toBe('string')
  })

  it('reports the slot as held, not granted, when the follow-up holder lookup finds nothing — the previous holder released between NX refusal and this read', async () => {
    const { store, redis } = makeReadyStore()
    const tenantId = 'tenant-1'
    // Seeded directly on the fake Redis store, bypassing tryReserveActiveJob — same reasoning as
    // the test above: this store's own activeJobMemoryStore has no entry for it, so the
    // reservation must be resolved through Redis, not the in-memory fast path.
    await redis.set(
      `walletPortabilityActiveJob:${tenantId}`,
      JSON.stringify({ jobId: 'job-A', reservedAt: Date.now() }),
    )

    // SET ... NX is refused (the key exists) — but job-A releases (or its key otherwise
    // vanishes) in the exact window before the follow-up GET that tries to identify the holder.
    // The old code returned `holder?.jobId` here — undefined, since holder ends up genuinely
    // undefined — which the caller reads as "I own the slot", admitting a second concurrent job
    // even though this job's own SET NX never actually landed. See the #73 review.
    redis.hideKeyOnCall = { key: `walletPortabilityActiveJob:${tenantId}`, callNumber: 1 }
    const result = await store.tryReserveActiveJob(tenantId, 'job-B')

    expect(typeof result).toBe('string')
    expect(result).not.toBe('job-B')
  })

  it('reports the slot as held, not granted, when the reclaim CAS loses and the follow-up read then also finds nothing', async () => {
    const { store, redis } = makeReadyStore()
    const tenantId = 'tenant-1'
    await redis.set(
      `walletPortabilityActiveJob:${tenantId}`,
      JSON.stringify({ jobId: 'job-A', reservedAt: Date.now() }),
    )
    // job-A's own record has reached a terminal status, making the CAS-reclaim branch eligible.
    await store.save({ ...makePendingRecord('job-A', tenantId), status: WalletPortabilityJobStatus.Completed })

    // The reclaim CAS itself loses (another process's own reclaim/release already changed the
    // key by the time this caller's eval runs), and by the time the follow-up GET tries to
    // identify the new holder, that key has *also* already vanished. The old code returned
    // `current?.jobId` here — undefined, since current ends up genuinely undefined — which the
    // caller reads as "I own the slot", admitting a concurrent job even though this caller's own
    // CAS never actually landed. See the #73 review.
    redis.forceNextEvalMiss = true
    redis.hideKeyOnCall = { key: `walletPortabilityActiveJob:${tenantId}`, callNumber: 2 }
    const result = await store.tryReserveActiveJob(tenantId, 'job-B')

    expect(typeof result).toBe('string')
    expect(result).not.toBe('job-B')
  })

  it('reclaims an InProgress reservation whose record has gone stale — a crash/restart after the first status write, not just a terminal-status reclaim', async () => {
    const { store } = makeReadyStore()
    const tenantId = 'tenant-1'

    expect(await store.tryReserveActiveJob(tenantId, 'job-1')).toBeUndefined()
    // job-1 crashed mid-run: its own record reached InProgress (the very first write
    // runExport/runImport makes) and nothing ever marked it terminal afterward — the process
    // died. Before this fix, an InProgress record was treated as live regardless of age,
    // wedging the tenant out of both export and import for the rest of the 24h TTL.
    // makePendingRecord's fixed 2026-01-01 updatedAt is already far older than
    // MAX_IN_PROGRESS_DURATION_MS. See the #73 review.
    await store.save({ ...makePendingRecord('job-1', tenantId), status: WalletPortabilityJobStatus.InProgress })

    expect(await store.tryReserveActiveJob(tenantId, 'job-2')).toBeUndefined()
  })

  it('does not reclaim a genuinely fresh InProgress reservation — a real job mid-run must not be treated as dead', async () => {
    const { store } = makeReadyStore()
    const tenantId = 'tenant-1'

    expect(await store.tryReserveActiveJob(tenantId, 'job-1')).toBeUndefined()
    await store.save({
      ...makePendingRecord('job-1', tenantId),
      status: WalletPortabilityJobStatus.InProgress,
      updatedAt: new Date().toISOString(),
    })

    expect(await store.tryReserveActiveJob(tenantId, 'job-2')).toBe('job-1')
  })

  it('releaseActiveJob uses a single atomic compare-and-delete, not a separate GET then DEL', async () => {
    const { store, redis } = makeReadyStore()
    const tenantId = 'tenant-1'
    const jobId = 'job-1'
    await store.tryReserveActiveJob(tenantId, jobId)

    const delSpy = jest.spyOn(redis, 'del')
    const evalSpy = jest.spyOn(redis, 'eval')

    await store.releaseActiveJob(tenantId, jobId)

    // The ownership check and the delete must happen as one server-side operation (eval), not two
    // separate round trips (get then del) — a plain get-then-del leaves a window where a newer
    // reservation can take over the key in between, and the del would then remove that new
    // owner's key instead of the one actually being released.
    expect(evalSpy).toHaveBeenCalled()
    expect(delSpy).not.toHaveBeenCalled()
    expect(await store.tryReserveActiveJob(tenantId, 'job-2')).toBeUndefined()
  })
})
