import type { WalletPortabilityJobRecord } from './WalletPortabilityTypes'
import type { TsLogger } from '../../utils/logger'

import { Redis } from 'ioredis'

// Job records are small and short-lived (a single export/import run) — 24h is generous headroom
// for a client to poll status without leaking memory/Redis keys indefinitely.
const JOB_TTL_SECONDS = 24 * 60 * 60
const JOB_KEY_PREFIX = 'walletPortabilityJob:'

/**
 * Tracks async export/import job status.
 *
 * Mirrors the fallback philosophy already used for RedisCache/InMemoryLruCache in cliAgent.ts:
 * Redis when REDIS_URL is set (required for correctness across multiple agent instances), an
 * in-memory Map otherwise (fine for local/single-instance dev, not for production multi-instance).
 */
export class WalletPortabilityJobStore {
  private readonly logger: TsLogger
  private readonly redisClient?: Redis
  private readonly memoryStore = new Map<string, WalletPortabilityJobRecord>()

  public constructor(logger: TsLogger, redisUrl?: string) {
    this.logger = logger

    if (redisUrl) {
      this.redisClient = new Redis(redisUrl, { maxRetriesPerRequest: null })
      this.redisClient.on('error', (error) => {
        this.logger.error(`[WalletPortabilityJobStore] Redis error: ${error}`)
      })
      this.logger.info('[WalletPortabilityJobStore] Redis URL found — job status will be tracked in Redis')
    } else {
      this.logger.warn(
        '[WalletPortabilityJobStore] REDIS_URL not set — falling back to in-memory job status (not safe for multi-instance deployments)',
      )
    }
  }

  public async save(job: WalletPortabilityJobRecord): Promise<void> {
    if (this.redisClient) {
      await this.redisClient.set(`${JOB_KEY_PREFIX}${job.jobId}`, JSON.stringify(job), 'EX', JOB_TTL_SECONDS)
      return
    }
    this.memoryStore.set(job.jobId, job)
  }

  public async get(jobId: string): Promise<WalletPortabilityJobRecord | undefined> {
    if (this.redisClient) {
      const raw = await this.redisClient.get(`${JOB_KEY_PREFIX}${jobId}`)
      return raw ? (JSON.parse(raw) as WalletPortabilityJobRecord) : undefined
    }
    return this.memoryStore.get(jobId)
  }
}
