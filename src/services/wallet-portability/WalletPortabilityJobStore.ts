import type { WalletPortabilityJobRecord } from './WalletPortabilityTypes'
import type { TsLogger } from '../../utils/logger'
import type { RedisOptions } from 'ioredis'

import { Redis } from 'ioredis'

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
  private readonly activeJobMemoryStore = new Map<string, string>()
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
    let redisRecord: WalletPortabilityJobRecord | undefined
    if (this.redisClient && this.isRedisReady()) {
      try {
        const raw = await this.redisClient.get(`${JOB_KEY_PREFIX}${jobId}`)
        if (raw) redisRecord = JSON.parse(raw) as WalletPortabilityJobRecord
      } catch (error) {
        this.logger.error(`[WalletPortabilityJobStore] Redis get failed, falling back to in-memory store: ${error}`)
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
      return new Date(memoryRecord.updatedAt) >= new Date(redisRecord.updatedAt) ? memoryRecord : redisRecord
    }
    return redisRecord ?? memoryRecord
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
    // Checked first, and regardless of Redis's current readiness: a reservation made while Redis
    // was unready lives only in memory, and Redis recovering before that job releases must not
    // make the reservation invisible to a later reserve attempt. Without this check up front, a
    // reserve call landing after Redis recovers falls straight into the Redis branch below, finds
    // no key there (the earlier reservation was memory-only), and wrongly admits a second
    // concurrent job for the same tenant — the exact race this reservation exists to prevent.
    const existingInMemory = this.activeJobMemoryStore.get(tenantId)
    if (existingInMemory) return existingInMemory

    if (this.redisClient && this.isRedisReady()) {
      try {
        const result = await this.redisClient.set(key, jobId, 'EX', JOB_TTL_SECONDS, 'NX')
        if (result === 'OK') {
          // Mirrored into the in-memory store too, not just Redis — a portability job runs for
          // seconds to minutes, so Redis's readiness can flip between reservation and release.
          // releaseActiveJob now clears both stores unconditionally (see its own comment), which
          // only works if a Redis-side reservation is also visible in memory once Redis drops.
          this.activeJobMemoryStore.set(tenantId, jobId)
          return undefined
        }
        const existing = await this.redisClient.get(key)
        return existing ?? undefined
      } catch (error) {
        this.logger.error(
          `[WalletPortabilityJobStore] Redis active-job reservation failed, falling back to in-memory: ${error}`,
        )
      }
    }
    this.activeJobMemoryStore.set(tenantId, jobId)
    return undefined
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
   */
  public async releaseActiveJob(tenantId: string, jobId: string): Promise<void> {
    const key = `${ACTIVE_JOB_KEY_PREFIX}${tenantId}`
    if (this.redisClient) {
      try {
        const current = await this.redisClient.get(key)
        if (current === jobId) {
          await this.redisClient.del(key)
        }
      } catch (error) {
        this.logger.error(`[WalletPortabilityJobStore] Redis active-job release failed: ${error}`)
      }
    }
    if (this.activeJobMemoryStore.get(tenantId) === jobId) {
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
