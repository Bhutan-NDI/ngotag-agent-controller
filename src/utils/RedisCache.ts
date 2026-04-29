import type { TsLogger } from './logger'
import type { AgentContext } from '@credo-ts/core'

import { Redis } from 'ioredis'

export class RedisCache {
  private client: Redis
  private ttlSeconds: number
  private isConnected: boolean = false
  private logger: TsLogger

  public constructor(redisUrl: string, logger: TsLogger, ttlSeconds: number = 300) {
    this.ttlSeconds = ttlSeconds
    this.logger = logger
    this.client = new Redis(redisUrl, {
      // Retry strategy for connection failures
      retryStrategy(times) {
        if (times > 3) {
          return null // stop retrying after 3 attempts
        }
        return Math.min(times * 200, 1000) // wait 200ms, 400ms, 600ms
      },
      enableOfflineQueue: false, // don't queue commands when disconnected
      lazyConnect: true,
    })

    this.client.on('connect', () => {
      this.isConnected = true
      this.logger.info('RedisCache connected')
    })

    this.client.on('error', (err) => {
      this.isConnected = false
      this.logger.error(`RedisCache error: ${err.message}`)
    })

    this.client.on('close', () => {
      this.isConnected = false
      this.logger.warn('RedisCache connection closed')
    })

    // Connect explicitly
    this.client.connect().catch((err) => {
      this.logger.error(`RedisCache initial connection failed: ${err.message}`)
    })
  }

  public async get<T>(_agentContext: AgentContext, key: string): Promise<T | null> {
    if (!this.isConnected) return null
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
    if (!this.isConnected) return // skip cache write if Redis is down
    try {
      const serialized = JSON.stringify(value)
      const expirySeconds = ttl ?? this.ttlSeconds
      await this.client.set(key, serialized, 'EX', expirySeconds)
    } catch (err) {
      this.logger.error(`RedisCache set error for key ${key}: ${err}`)
    }
  }

  public async remove(_agentContext: AgentContext, key: string): Promise<void> {
    if (!this.isConnected) return
    try {
      await this.client.del(key)
    } catch (err) {
      this.logger.error(`RedisCache remove error for key ${key}: ${err}`)
    }
  }
}
