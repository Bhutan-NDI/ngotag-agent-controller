import type { TsLogger } from './logger'
import type { AgentContext, Cache } from '@credo-ts/core'
import type { RedisOptions } from 'ioredis'

import { Redis } from 'ioredis'

enum RedisCacheConnectionState {
  Connecting = 'connecting',
  Ready = 'ready',
  Reconnecting = 'reconnecting',
  Closed = 'closed',
}

const RECONNECT_BASE_DELAY_MS = 500
const RECONNECT_MAX_DELAY_MS = 30000
const CONNECT_TIMEOUT_MS = 5000
const COMMAND_TIMEOUT_MS = 3000
const KEEP_ALIVE_MS = 10000
const MAX_RETRIES_PER_REQUEST = null

export class RedisCache implements Cache {
  private client: Redis
  private readonly ttlSeconds: number
  private readonly logger: TsLogger
  private readonly redisUrl: string
  private connectionState: RedisCacheConnectionState = RedisCacheConnectionState.Connecting

  public constructor(redisUrl: string, logger: TsLogger, ttlSeconds: number = 600) {
    this.ttlSeconds = ttlSeconds
    this.logger = logger
    this.redisUrl = redisUrl

    this.client = this.createClient()
  }

  private createClient(): Redis {
    const options: RedisOptions = {
      connectTimeout: CONNECT_TIMEOUT_MS,
      commandTimeout: COMMAND_TIMEOUT_MS,
      keepAlive: KEEP_ALIVE_MS,
      family: 4,

      enableOfflineQueue: false,

      maxRetriesPerRequest: MAX_RETRIES_PER_REQUEST,

      lazyConnect: false,

      retryStrategy(times: number): number {
        // Exponential backoff: 500ms, 1000ms, 2000ms, 4000ms ... capped at 30s
        const delay = Math.min(RECONNECT_BASE_DELAY_MS * Math.pow(2, times - 1), RECONNECT_MAX_DELAY_MS)
        return delay
      },

      // Reconnect on specific Redis errors (e.g. READONLY during failover)
      reconnectOnError(err: Error): boolean {
        const targetErrors = ['READONLY', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT']
        return targetErrors.some((e) => err.message.includes(e))
      },
    }

    const client = new Redis(this.redisUrl, options)
    this.attachEventHandlers(client)
    return client
  }

  private attachEventHandlers(client: Redis): void {
    client.on('connect', () => {
      this.connectionState = RedisCacheConnectionState.Connecting
      this.logger.info('RedisCache TCP connection established — waiting for ready')
    })

    client.on('ready', () => {
      this.connectionState = RedisCacheConnectionState.Ready
      this.logger.info('RedisCache ready — accepting commands')
    })

    client.on('reconnecting', () => {
      this.connectionState = RedisCacheConnectionState.Reconnecting
      this.logger.warn('RedisCache reconnecting — falling back to DB until restored')
    })

    client.on('error', (err: Error) => {
      this.logger.error(`RedisCache error: ${err.message}`)
    })

    client.on('close', () => {
      if (this.connectionState !== RedisCacheConnectionState.Reconnecting) {
        this.connectionState = RedisCacheConnectionState.Closed
        this.logger.warn('RedisCache connection closed')
      }
    })

    client.on('end', () => {
      this.connectionState = RedisCacheConnectionState.Closed
      this.logger.warn('RedisCache client ended — no further reconnection attempts')
    })
  }

  private isReady(): boolean {
    return this.connectionState === RedisCacheConnectionState.Ready
  }

  public async get<T>(_agentContext: AgentContext, key: string): Promise<T | null> {
    if (!this.isReady()) {
      this.logger.debug(`RedisCache not ready (${this.connectionState}) — cache miss for key ${key}`)
      return null
    }
    try {
      const value = await this.client.get(key)
      if (!value) return null
      return JSON.parse(value) as T
    } catch (err) {
      this.logger.error(`RedisCache get error for key ${key}: ${err}`)
      return null
    }
  }

  public async set<T>(_agentContext: AgentContext, key: string, value: T, expiresInSeconds?: number): Promise<void> {
    if (!this.isReady()) return
    try {
      const serialized = JSON.stringify(value)
      const expirySeconds = expiresInSeconds ?? this.ttlSeconds
      await this.client.set(key, serialized, 'EX', expirySeconds)
    } catch (err) {
      this.logger.error(`RedisCache set error for key ${key}: ${err}`)
    }
  }

  public async remove(_agentContext: AgentContext, key: string): Promise<void> {
    if (!this.isReady()) return
    try {
      await this.client.del(key)
    } catch (err) {
      this.logger.error(`RedisCache remove error for key ${key}: ${err}`)
    }
  }

  public async disconnect(): Promise<void> {
    this.logger.info('RedisCache disconnecting gracefully')
    try {
      await this.client.quit()
    } catch (err) {
      this.logger.error(`RedisCache graceful disconnect failed: ${err}`)
      this.client.disconnect()
    }
  }
}
