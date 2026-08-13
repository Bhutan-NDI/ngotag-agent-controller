import type { WalletPortabilityJobRecord } from './WalletPortabilityTypes'
import type { TsLogger } from '../../utils/logger'
import type { RedisOptions } from 'ioredis'

import { Redis } from 'ioredis'

// Job records are small and short-lived (a single export/import run) — 24h is generous headroom
// for a client to poll status without leaking memory/Redis keys indefinitely.
const JOB_TTL_SECONDS = 24 * 60 * 60
const JOB_KEY_PREFIX = 'walletPortabilityJob:'

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
export class WalletPortabilityJobStore {
  private readonly logger: TsLogger
  private readonly redisClient?: Redis
  private readonly memoryStore = new Map<string, WalletPortabilityJobRecord>()
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
        return
      } catch (error) {
        this.logger.error(`[WalletPortabilityJobStore] Redis set failed, falling back to in-memory store: ${error}`)
      }
    }
    // Also mirror into the in-memory store when Redis is configured but unreachable, so a job
    // started during an outage is still observable for the life of this process instead of
    // silently vanishing.
    this.memoryStore.set(job.jobId, job)
  }

  public async get(jobId: string): Promise<WalletPortabilityJobRecord | undefined> {
    if (this.redisClient && this.isRedisReady()) {
      try {
        const raw = await this.redisClient.get(`${JOB_KEY_PREFIX}${jobId}`)
        if (raw) return JSON.parse(raw) as WalletPortabilityJobRecord
      } catch (error) {
        this.logger.error(`[WalletPortabilityJobStore] Redis get failed, falling back to in-memory store: ${error}`)
      }
    }
    return this.memoryStore.get(jobId)
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
