import type { TsLogger } from './logger'
import type { AgentContext } from '@credo-ts/core'

import { Redis } from 'ioredis'

enum RedisCacheConnectionState {
  Connecting = 'connecting',
  Ready = 'ready',
  Reconnecting = 'reconnecting',
  Closed = 'closed',
}
export class RedisCache {
  private client: Redis
  private ttlSeconds: number
  private isConnected: boolean = false
  private logger: TsLogger
  private connectionState: RedisCacheConnectionState = RedisCacheConnectionState.Connecting

  public constructor(redisUrl: string, logger: TsLogger, ttlSeconds: number = 600) {
    this.ttlSeconds = ttlSeconds
    this.logger = logger

    this.client = new Redis(redisUrl, {
      connectTimeout: 3000, // fail fast on connect
      commandTimeout: 2000, // fail fast on commands
      maxRetriesPerRequest: 1, // one retry then fail — fall back to DB
      keepAlive: 5000,
      family: 4, // IPv4 — appropriate for AWS VPC
      enableOfflineQueue: false, // don't queue while disconnected
      lazyConnect: true,
      retryStrategy(times) {
        if (times > 5) {
          return null // stop retrying — circuit open
        }
        return Math.min(times * 500, 3000)
      },
    })

    this.client.on('connect', () => {
      this.connectionState = RedisCacheConnectionState.Connecting
      this.logger.info('RedisCache connecting')
    })

    this.client.on('ready', () => {
      this.connectionState = RedisCacheConnectionState.Ready
      this.logger.info('RedisCache ready')
    })

    this.client.on('reconnecting', () => {
      this.connectionState = RedisCacheConnectionState.Connecting
      this.logger.warn('RedisCache reconnecting')
    })

    this.client.on('error', (err) => {
      this.logger.error(`RedisCache error: ${err.message}`)
    })

    this.client.on('end', () => {
      this.connectionState = RedisCacheConnectionState.Closed
      this.logger.warn('RedisCache connection closed — falling back to DB for all requests')
    })

    this.client.connect().catch((err) => {
      this.logger.error(`RedisCache initial connection failed: ${err.message}`)
    })
  }

  private isReady(): boolean {
    return this.connectionState === RedisCacheConnectionState.Ready
  }

  public async get<T>(_agentContext: AgentContext, key: string): Promise<T | null> {
    if (!this.isReady()) {
      this.logger.warn(`RedisCache not ready (${this.connectionState})`)
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

  public async set<T>(_agentContext: AgentContext, key: string, value: T, ttl?: number): Promise<void> {
    if (!this.isReady()) return
    try {
      const serialized = JSON.stringify(value)
      const expirySeconds = ttl ?? this.ttlSeconds
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
}
