import type { WalletPortabilityJobRecord } from './WalletPortabilityTypes'
import type { TsLogger } from '../../utils/logger'
import type { RedisOptions } from 'ioredis'

import { Redis } from 'ioredis'

import { WalletPortabilityJobStatus } from './WalletPortabilityTypes'

// Job records are small and short-lived (a single export/import run) — 24h is generous headroom
// for a client to poll status without leaking memory/Redis keys indefinitely.
const JOB_TTL_SECONDS = 24 * 60 * 60
const JOB_KEY_PREFIX = 'walletPortabilityJob:'
// Per-tenant "is a portability job already running" pointer — export and import both rename the
// tenant's profile away during their work, so they can never safely run concurrently with each
// other or with a second instance of themselves for the same tenant. Same TTL as job records:
// if a crash ever leaves this stuck, it self-clears within 24h rather than wedging the tenant
// forever (see the reservation logic in tryReserveActiveJob/releaseActiveJob below).
const ACTIVE_JOB_KEY_PREFIX = 'walletPortabilityActiveJob:'

const CONNECT_TIMEOUT_MS = 5000
const COMMAND_TIMEOUT_MS = 3000
const RECONNECT_BASE_DELAY_MS = 500
const RECONNECT_MAX_DELAY_MS = 30000

// exportWallet/importWallet reserve the tenant's slot BEFORE the job's own Pending record is
// written (see WalletPortabilityService), so there is a genuine window — normally milliseconds,
// the time for one more `save()` call — where a brand-new, perfectly live reservation has no
// backing record yet. Without this grace period, a second near-simultaneous request landing in
// that exact window reads "no record" and misreads it as "the previous holder is dead", reclaiming
// the slot and letting two portability jobs run concurrently for the same tenant. 15s is generous
// headroom over a single save() call while still being negligible next to a real job's seconds-
// to-minutes runtime, so a *genuinely* dead reservation (process crashed before ever saving) is
// still reclaimed promptly rather than waiting out the full 24h TTL.
const RESERVATION_GRACE_PERIOD_MS = 15 * 1000

// Placeholder "holder" returned when Redis has already told tryReserveActiveJob the slot is taken
// (SET ... NX refused) but a subsequent round trip to identify who holds it then fails. Denying
// the request either way is correct; this exists so the caller's WalletPortabilityJobConflictError
// message reads sensibly ("A wallet portability job (unknown) is already in progress...") instead
// of surfacing a raw undefined as if the reservation had succeeded.
const UNKNOWN_HOLDER_JOB_ID = 'unknown'

// Redis has no atomic "SET only if the current value equals X" primitive outside Lua/WATCH, and a
// plain SET after a separate GET-and-check is a classic TOCTOU: two concurrent callers can both
// observe the same stale holder and both "win" the reclaim, admitting two jobs. This script makes
// the compare-and-swap a single atomic operation server-side.
const RECLAIM_IF_UNCHANGED_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3])
  return 1
else
  return 0
end
`

// Same TOCTOU class as the reclaim script above, on the release path instead: a plain GET-then-DEL
// lets a newer reservation get created in the gap and then deleted by a release that believed it
// still owned the (now stale) value it read. Compares only jobId, not the full {jobId, reservedAt}
// value tryReserveActiveJob wrote — releaseActiveJob only ever receives (tenantId, jobId), and
// re-reading the value first to compare it in full would reintroduce the exact TOCTOU this script
// exists to remove. cjson is a standard part of Redis's Lua scripting environment, not an
// application dependency.
const RELEASE_IF_OWNED_SCRIPT = `
local current = redis.call('GET', KEYS[1])
if not current then
  return 0
end
local ok, parsed = pcall(cjson.decode, current)
if not ok or parsed.jobId ~= ARGV[1] then
  return 0
end
redis.call('DEL', KEYS[1])
return 1
`

interface ActiveJobReservation {
  jobId: string
  reservedAt: number
}

enum ConnectionState {
  Connecting = 'connecting',
  Ready = 'ready',
  Reconnecting = 'reconnecting',
  Closed = 'closed',
}

/**
 * Tracks async export/import job status.
 *
 * Mirrors RedisCache's hardened connection options (src/utils/RedisCache.ts) — not just its
 * fallback *philosophy* — since a plain `new Redis(url, { maxRetriesPerRequest: null })` leaves
 * `enableOfflineQueue` at its default `true` with unbounded retries: commands issued while
 * disconnected queue up and never settle, hanging `save`/`get` (and so the export/import HTTP
 * endpoints) indefinitely instead of failing fast. With `enableOfflineQueue: false` +
 * `commandTimeout`/`connectTimeout` + a readiness gate, a Redis outage degrades to "fall back to
 * the in-memory store" rather than "hang forever".
 */
interface MemoryStoreEntry {
  record: WalletPortabilityJobRecord
  // Mirrors JOB_TTL_SECONDS, applied in application code since a plain Map has no TTL of its
  // own — without this, a REDIS_URL-less deployment (or one where Redis is unready at write
  // time) retains every job record for the life of the process, unlike the Redis side which
  // self-expires. See the #72 review.
  expiresAt: number
}

export class WalletPortabilityJobStore {
  private readonly logger: TsLogger
  private readonly redisClient?: Redis
  private readonly memoryStore = new Map<string, MemoryStoreEntry>()
  private readonly activeJobMemoryStore = new Map<string, ActiveJobReservation>()
  private connectionState: ConnectionState = ConnectionState.Connecting

  public constructor(logger: TsLogger, redisUrl?: string) {
    this.logger = logger

    if (redisUrl) {
      const options: RedisOptions = {
        connectTimeout: CONNECT_TIMEOUT_MS,
        commandTimeout: COMMAND_TIMEOUT_MS,
        family: 4,
        enableOfflineQueue: false,
        maxRetriesPerRequest: null,
        lazyConnect: false,
        retryStrategy: (times: number): number => {
          const delay = Math.min(RECONNECT_BASE_DELAY_MS * Math.pow(2, times - 1), RECONNECT_MAX_DELAY_MS)
          return delay
        },
        reconnectOnError: (error: Error): boolean => {
          const targetErrors = ['READONLY', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT']
          return targetErrors.some((e) => error.message.includes(e))
        },
      }

      this.redisClient = new Redis(redisUrl, options)
      this.attachEventHandlers(this.redisClient)
      this.logger.info('[WalletPortabilityJobStore] Redis URL found — job status will be tracked in Redis')
    } else {
      this.logger.warn(
        '[WalletPortabilityJobStore] REDIS_URL not set — falling back to in-memory job status (not safe for multi-instance deployments)',
      )
    }
  }

  private attachEventHandlers(client: Redis): void {
    client.on('connect', () => {
      this.connectionState = ConnectionState.Connecting
    })
    client.on('ready', () => {
      this.connectionState = ConnectionState.Ready
    })
    client.on('reconnecting', () => {
      this.connectionState = ConnectionState.Reconnecting
      this.logger.warn(
        '[WalletPortabilityJobStore] Redis reconnecting — falling back to in-memory store until restored',
      )
    })
    client.on('error', (error) => {
      this.logger.error(`[WalletPortabilityJobStore] Redis error: ${error}`)
    })
    client.on('close', () => {
      if (this.connectionState !== ConnectionState.Reconnecting) {
        this.connectionState = ConnectionState.Closed
      }
    })
    client.on('end', () => {
      this.connectionState = ConnectionState.Closed
    })
  }

  private isRedisReady(): boolean {
    return this.connectionState === ConnectionState.Ready
  }

  public async save(job: WalletPortabilityJobRecord): Promise<void> {
    if (this.redisClient && this.isRedisReady()) {
      try {
        await this.redisClient.set(`${JOB_KEY_PREFIX}${job.jobId}`, JSON.stringify(job), 'EX', JOB_TTL_SECONDS)
        // Clears any stale mirror left by an earlier write that landed here during a Redis
        // outage. Without this, get()'s tie-break (>=, favoring memory) can pick that stale
        // memory entry back up if a later write for the same jobId happens to share its
        // updatedAt millisecond — the exact mirror-direction failure this fixes. Once Redis has
        // this job's latest write, memory has nothing useful left to contribute for it.
        this.memoryStore.delete(job.jobId)
        return
      } catch (error) {
        this.logger.error(`[WalletPortabilityJobStore] Redis set failed, falling back to in-memory store: ${error}`)
      }
    }
    // Also mirror into the in-memory store when Redis is configured but unreachable, so a job
    // started during an outage is still observable for the life of this process instead of
    // silently vanishing. Sweeps expired entries on every write rather than only lazily on read
    // — a job whose status is never polled again after this write would otherwise never be
    // looked up again either, and so would never get a chance to expire lazily.
    this.pruneExpiredMemoryEntries()
    this.memoryStore.set(job.jobId, { record: job, expiresAt: Date.now() + JOB_TTL_SECONDS * 1000 })
  }

  public async get(jobId: string): Promise<WalletPortabilityJobRecord | undefined> {
    return (await this.getWithReadStatus(jobId)).record
  }

  // Split out from get() so the reservation-reclaim logic below can tell "definitively no record
  // exists" apart from "we cannot currently see Redis's true state" — get()'s own callers don't
  // need that distinction (degrading to "not found" is the right behavior for them either way),
  // but a reclaim decision does: mistaking either a timed-out GET *or* an unready connection for
  // "the job is dead" would let a live job's active-job slot be reclaimed out from under it.
  //
  // redisUnavailable covers both cases that mean "a miss here might not be a real miss": a read
  // that threw, and — the gap the read-threw check alone missed — Redis being configured but not
  // currently ready, so the read is never even attempted (a reconnecting/closed connection reports
  // empty exactly like a genuine cache miss unless this is checked separately). It is only ever
  // true when NO record was found by either store: a memory record answers the question on its
  // own regardless of Redis's state (that's the whole point of the memory mirror), so a
  // Redis-configured-but-perpetually-unready deployment operating correctly off memory the entire
  // time must not have every lookup treated as untrustworthy just because isRedisReady() is false.
  // A deployment with no REDIS_URL at all must also never trip this — that's a legitimate
  // memory-only mode, not an outage.
  private async getWithReadStatus(
    jobId: string,
  ): Promise<{ record?: WalletPortabilityJobRecord; redisUnavailable: boolean }> {
    let redisRecord: WalletPortabilityJobRecord | undefined
    let redisReadFailed = false
    const redisSkippedDueToUnready = this.redisClient ? !this.isRedisReady() : false
    if (this.redisClient && this.isRedisReady()) {
      try {
        const raw = await this.redisClient.get(`${JOB_KEY_PREFIX}${jobId}`)
        if (raw) redisRecord = JSON.parse(raw) as WalletPortabilityJobRecord
      } catch (error) {
        this.logger.error(`[WalletPortabilityJobStore] Redis get failed, falling back to in-memory store: ${error}`)
        redisReadFailed = true
      }
    }
    const memoryRecord = this.getUnexpiredMemoryRecord(jobId)
    // Reconcile rather than preferring Redis unconditionally — save() mirrors into memoryStore
    // whenever Redis was unready at write time, so the two can genuinely disagree for the same
    // jobId (Redis holds a stale record from before an outage, memory holds the true latest
    // state, or the reverse if Redis recovered mid-job and a later write landed there instead).
    // Taking whichever has the later updatedAt is always correct either way — an entry only ever
    // exists in memoryStore because Redis was unavailable for that particular write.
    if (redisRecord && memoryRecord) {
      // >= not >: updatedAt is millisecond-resolution and consecutive writes for one job routinely
      // share a millisecond (Pending -> InProgress is only a couple of microtasks apart). A
      // memoryStore entry only exists because Redis was unavailable for that particular write, so
      // on a tie it is the later of the two, not redisRecord.
      const record = new Date(memoryRecord.updatedAt) >= new Date(redisRecord.updatedAt) ? memoryRecord : redisRecord
      return { record, redisUnavailable: redisReadFailed }
    }
    const record = redisRecord ?? memoryRecord
    return { record, redisUnavailable: !record && (redisReadFailed || redisSkippedDueToUnready) }
  }

  // Lazily reclaims a single expired entry the instant something actually looks it up — on top
  // of pruneExpiredMemoryEntries' write-time sweep, not instead of it, since a record that's
  // never read again after its write would never hit this path at all.
  private getUnexpiredMemoryRecord(jobId: string): WalletPortabilityJobRecord | undefined {
    const entry = this.memoryStore.get(jobId)
    if (!entry) return undefined
    if (entry.expiresAt <= Date.now()) {
      this.memoryStore.delete(jobId)
      return undefined
    }
    return entry.record
  }

  private pruneExpiredMemoryEntries(): void {
    const now = Date.now()
    for (const [jobId, entry] of this.memoryStore) {
      if (entry.expiresAt <= now) {
        this.memoryStore.delete(jobId)
      }
    }
  }

  /**
   * Atomically claim the "active portability job" slot for a tenant. Returns undefined if the
   * claim succeeded (the caller's jobId is now the active one) or the existing active jobId if
   * another job already holds the slot. Uses Redis's `SET ... NX` (set-if-absent) so two
   * concurrent requests for the same tenant can't both believe they won the race — whichever
   * `NX` call actually lands first wins, the other observes the key already set.
   */
  public async tryReserveActiveJob(tenantId: string, jobId: string): Promise<string | undefined> {
    const key = `${ACTIVE_JOB_KEY_PREFIX}${tenantId}`
    const reservedAt = Date.now()
    // Checked first, and regardless of Redis's current readiness: a reservation made while Redis
    // was unready lives only in memory, and Redis recovering before that job releases must not
    // make the reservation invisible to a later reserve attempt. Without this check up front, a
    // reserve call landing after Redis recovers falls straight into the Redis branch below, finds
    // no key there (the earlier reservation was memory-only), and wrongly admits a second
    // concurrent job for the same tenant — the exact race this reservation exists to prevent.
    const existingInMemory = this.activeJobMemoryStore.get(tenantId)
    if (existingInMemory) {
      if (await this.isReservationStillActive(existingInMemory)) return existingInMemory.jobId
      // The memory-side reservation belongs to a job that's no longer pending/in-progress -- the
      // process died before releaseActiveJob's finally ran. Memory has no TTL at all (unlike the
      // Redis key below), so without this the tenant would be wedged out permanently rather than
      // for a bounded 24h. Reclaim rather than trust a stale pointer.
      this.activeJobMemoryStore.delete(tenantId)
    }

    if (this.redisClient && this.isRedisReady()) {
      // Tracks whether Redis has already answered "the slot is taken" (SET ... NX refused) before
      // the catch below runs. Without this, a follow-up round trip failing *after* that answer —
      // the holder GET, or the reclaim CAS eval, both a few lines below — falls into the same catch
      // as a failure on the initial NX itself, and previously fell through to the unconditional
      // in-memory grant at the bottom of this method: silently discarding Redis's own "taken"
      // answer and admitting a second concurrent job for the tenant.
      let redisRefusedReservation = false
      try {
        const value = JSON.stringify({ jobId, reservedAt } satisfies ActiveJobReservation)
        const result = await this.redisClient.set(key, value, 'EX', JOB_TTL_SECONDS, 'NX')
        if (result === 'OK') {
          // Mirrored into the in-memory store too, not just Redis — a portability job runs for
          // seconds to minutes, so Redis's readiness can flip between reservation and release.
          // releaseActiveJob now clears both stores unconditionally (see its own comment), which
          // only works if a Redis-side reservation is also visible in memory once Redis drops.
          this.activeJobMemoryStore.set(tenantId, { jobId, reservedAt })
          return undefined
        }
        redisRefusedReservation = true
        const holderRaw = await this.redisClient.get(key)
        const holder = holderRaw ? (JSON.parse(holderRaw) as ActiveJobReservation) : undefined
        // The slot is only genuinely held if the job it points at is still live. A job whose
        // record is terminal (or gone entirely — its own TTL outlived the process that was
        // running it) means the previous holder died before its finally could release, and the
        // 24h TTL on this key would otherwise 409 the tenant for the rest of the day even though
        // nothing is actually running. Reclaim it on the next attempt instead of waiting out the
        // full TTL.
        if (holder && !(await this.isReservationStillActive(holder))) {
          // Compare-and-swap, not a plain SET — two concurrent callers can both reach this branch
          // having both observed the same stale `holderRaw`; without a CAS, both would "win" and
          // both admit their own job. Only the caller whose swap actually lands gets undefined
          // back; the loser re-reads and reports whoever now legitimately holds the slot.
          const swapped = await this.redisClient.eval(
            RECLAIM_IF_UNCHANGED_SCRIPT,
            1,
            key,
            holderRaw as string,
            value,
            String(JOB_TTL_SECONDS),
          )
          if (swapped === 1) {
            this.activeJobMemoryStore.set(tenantId, { jobId, reservedAt })
            return undefined
          }
          const currentRaw = await this.redisClient.get(key)
          const current = currentRaw ? (JSON.parse(currentRaw) as ActiveJobReservation) : undefined
          return current?.jobId
        }
        return holder?.jobId
      } catch (error) {
        this.logger.error(
          `[WalletPortabilityJobStore] Redis active-job reservation failed, falling back to in-memory: ${error}`,
        )
        if (redisRefusedReservation) {
          // Redis already told us the slot is taken; a follow-up round trip timing out afterward
          // must fail closed, not fall through to the in-memory grant below — that would silently
          // overturn the answer Redis already gave. The exact holder is unknown (that's the round
          // trip that just failed), but the slot must still be reported as held.
          return UNKNOWN_HOLDER_JOB_ID
        }
      }
    }
    this.activeJobMemoryStore.set(tenantId, { jobId, reservedAt })
    return undefined
  }

  // A reservation's TTL (24h, Redis) or lack of one (memory) is only a self-heal backstop, not
  // the primary way a dead reservation gets reclaimed — that's what this checks. A job whose own
  // record has reached a terminal status is no longer actually running, regardless of what the
  // reservation slot still says. A job with NO record at all is trickier: exportWallet/
  // importWallet reserve the slot before writing that record, so "no record yet" can mean either
  // "the process crashed before ever saving" (genuinely dead) or "we're a few milliseconds into a
  // perfectly live reservation, its save() call just hasn't landed yet" — the grace period below
  // is what tells those two apart, rather than treating every record-less reservation as dead the
  // instant it's checked (which readmitted a second concurrent job for the exact race this whole
  // mechanism exists to prevent).
  private async isReservationStillActive(reservation: ActiveJobReservation): Promise<boolean> {
    const { record, redisUnavailable } = await this.getWithReadStatus(reservation.jobId)
    if (redisUnavailable) {
      // Fail-safe: a transient Redis timeout OR a merely-unready connection must never be mistaken
      // for "the job is dead" — either would let a live job's slot be reclaimed out from under it
      // on nothing more than "we can't see the record right now", independent of the record-less
      // race above.
      return true
    }
    if (record) {
      return (
        record.status === WalletPortabilityJobStatus.Pending || record.status === WalletPortabilityJobStatus.InProgress
      )
    }
    return Date.now() - reservation.reservedAt <= RESERVATION_GRACE_PERIOD_MS
  }

  /**
   * Release the active-job slot, but only if it still points at this exact jobId — never clobber
   * a newer job's reservation. Clears BOTH stores unconditionally rather than picking one based on
   * Redis's *current* readiness: reservation and release can observe different readiness states
   * for the same job (it runs for seconds to minutes, plenty of time for Redis to blip), so
   * checking only the store that looks live right now can miss the store the reservation actually
   * landed in. A reservation stuck in Redis wedges the tenant for up to the 24h TTL; one stuck in
   * memory (no TTL) wedges it permanently until the process restarts.
   *
   * The Redis attempt below is gated on the client merely *existing*, not on isRedisReady() —
   * deliberately looser than every other Redis call in this class. Gating on readiness here would
   * reproduce the exact bug this fixes: a reservation made while Redis was ready can outlive a
   * disconnect, so by release time isRedisReady() may already be false even though the key is
   * still sitting in Redis waiting to be deleted. Attempting anyway costs nothing when truly
   * disconnected (enableOfflineQueue: false means the call rejects fast instead of hanging, same
   * as everywhere else in this class) and is the only way the Redis-side key ever gets cleared in
   * the disagreement window this finding described.
   *
   * The ownership check and the delete happen in one Lua eval (RELEASE_IF_OWNED_SCRIPT), not a
   * separate GET-then-DEL: between those two round trips, a newer job can legitimately take over
   * the slot (a tryReserveActiveJob reclaim, exactly like the one this class already makes atomic
   * on the reclaim side), and the plain DEL would then remove that new owner's reservation even
   * though *this* jobId was the owner when the GET ran.
   */
  public async releaseActiveJob(tenantId: string, jobId: string): Promise<void> {
    const key = `${ACTIVE_JOB_KEY_PREFIX}${tenantId}`
    if (this.redisClient) {
      try {
        await this.redisClient.eval(RELEASE_IF_OWNED_SCRIPT, 1, key, jobId)
      } catch (error) {
        this.logger.error(`[WalletPortabilityJobStore] Redis active-job release failed: ${error}`)
      }
    }
    if (this.activeJobMemoryStore.get(tenantId)?.jobId === jobId) {
      this.activeJobMemoryStore.delete(tenantId)
    }
  }

  /** Graceful shutdown — call from the process shutdown handler so the connection isn't just dropped. */
  public async disconnect(): Promise<void> {
    if (!this.redisClient) return
    try {
      await this.redisClient.quit()
    } catch (error) {
      this.logger.error(`[WalletPortabilityJobStore] graceful Redis disconnect failed: ${error}`)
      this.redisClient.disconnect()
    }
  }
}
