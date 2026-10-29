import {
  DAILY_COUNTER_TTL_SECONDS,
  DRAIN_LOCK_MS,
  holdBufferCap,
  holdBufferTtlSeconds,
  SEEN_COUNTER_TTL_SECONDS,
  TOMBSTONE_TTL_SECONDS,
} from './relayConfig'

export type RelayMode = 'HOLD' | 'FORWARD'

export interface RelayEntry {
  tenantId: string
  mode: RelayMode
  target?: string
  updatedAt: string
}

export interface HeldEnvelope {
  receivedAt: string
  contentType: string
  body: string
}

// The subset of ioredis the relay uses, so the store can be exercised against an in-memory fake.
export interface RelayRedis {
  status?: string
  get(key: string): Promise<string | null>
  set(key: string, value: string, ...args: (string | number)[]): Promise<unknown>
  del(...keys: string[]): Promise<number>
  mget(...keys: string[]): Promise<(string | null)[]>
  rpush(key: string, ...values: string[]): Promise<number>
  rpop(key: string): Promise<string | null>
  lpop(key: string): Promise<string | null>
  lrem(key: string, count: number, value: string): Promise<number>
  lindex(key: string, index: number): Promise<string | null>
  llen(key: string): Promise<number>
  expire(key: string, seconds: number): Promise<number>
  incr(key: string): Promise<number>
  hincrby(key: string, field: string, increment: number): Promise<number>
  hset(key: string, field: string, value: string): Promise<number>
  pipeline(): RelayPipeline
  ping(): Promise<string>
  quit(): Promise<unknown>
}

export interface RelayPipeline {
  set(key: string, value: string): RelayPipeline
  del(...keys: string[]): RelayPipeline
  exec(): Promise<unknown>
}

const PIPELINE_CHUNK = 500

const entryKey = (tenantId: string): string => `relay:entry:${tenantId}`
const kidKey = (fingerprint: string): string => `relay:kid:${fingerprint}`
const holdKey = (tenantId: string): string => `relay:hold:${tenantId}`
const drainKey = (tenantId: string): string => `relay:drain:${tenantId}`
const dailyKey = (tenantId: string, day: string): string => `relay:daily:${tenantId}:${day}`
const goneKey = (tenantId: string): string => `relay:gone:${tenantId}`
const seenKey = (fingerprint: string): string => `relay:seen:${fingerprint}`

const dayStamp = (date: Date): string => date.toISOString().slice(0, 10).replace(/-/g, '')

/** Redis-backed state of the migration relay: entries, the recipient-key index, the HOLD buffer and counters. */
export class RelayStore {
  public constructor(private readonly redis: RelayRedis) {}

  public async isReady(): Promise<boolean> {
    try {
      return 'PONG' === (await this.redis.ping())
    } catch {
      return false
    }
  }

  // Hot path: one round trip for every inbound DIDComm message.
  public async findTenantIdByFingerprints(fingerprints: string[]): Promise<string | undefined> {
    if (0 === fingerprints.length) return undefined
    const tenantIds = await this.redis.mget(...fingerprints.map(kidKey))
    return tenantIds.find((tenantId): tenantId is string => null !== tenantId)
  }

  public async getEntry(tenantId: string): Promise<RelayEntry | undefined> {
    const raw = await this.redis.get(entryKey(tenantId))
    return raw ? (JSON.parse(raw) as RelayEntry) : undefined
  }

  public async setEntry(entry: RelayEntry): Promise<void> {
    await this.redis.set(entryKey(entry.tenantId), JSON.stringify(entry))
  }

  /** @returns false when an entry is already there, which is then left untouched */
  public async setEntryIfAbsent(entry: RelayEntry): Promise<boolean> {
    return 'OK' === (await this.redis.set(entryKey(entry.tenantId), JSON.stringify(entry), 'NX'))
  }

  public async deleteEntry(tenantId: string): Promise<void> {
    await this.redis.del(entryKey(tenantId))
  }

  public async markRemoved(tenantId: string): Promise<void> {
    await this.redis.set(goneKey(tenantId), '1', 'EX', TOMBSTONE_TTL_SECONDS)
  }

  public async clearRemoved(tenantId: string): Promise<void> {
    await this.redis.del(goneKey(tenantId))
  }

  public async isRemoved(tenantId: string): Promise<boolean> {
    return null !== (await this.redis.get(goneKey(tenantId)))
  }

  public async indexKeys(tenantId: string, fingerprints: string[]): Promise<void> {
    for (let start = 0; start < fingerprints.length; start += PIPELINE_CHUNK) {
      const pipeline = this.redis.pipeline()
      for (const fingerprint of fingerprints.slice(start, start + PIPELINE_CHUNK)) {
        pipeline.set(kidKey(fingerprint), tenantId)
      }
      await pipeline.exec()
    }
  }

  public async removeKeys(fingerprints: string[]): Promise<void> {
    for (let start = 0; start < fingerprints.length; start += PIPELINE_CHUNK) {
      await this.redis.del(...fingerprints.slice(start, start + PIPELINE_CHUNK).map(kidKey))
    }
  }

  /** @returns false when the buffer is full, in which case nothing was stored */
  public async holdPush(tenantId: string, envelope: HeldEnvelope): Promise<boolean> {
    const length = await this.redis.rpush(holdKey(tenantId), JSON.stringify(envelope))
    if (length > holdBufferCap()) {
      await this.redis.rpop(holdKey(tenantId))
      return false
    }
    await this.redis.expire(holdKey(tenantId), holdBufferTtlSeconds())
    return true
  }

  /** Takes one copy of an envelope back out of the buffer, for a message that turned out not to need holding. */
  public async holdRemove(tenantId: string, envelope: HeldEnvelope): Promise<void> {
    await this.redis.lrem(holdKey(tenantId), 1, JSON.stringify(envelope))
  }

  public async holdLength(tenantId: string): Promise<number> {
    return this.redis.llen(holdKey(tenantId))
  }

  // An unreadable item is dropped rather than left to block the buffer forever.
  public async holdPeek(tenantId: string): Promise<HeldEnvelope | undefined> {
    for (;;) {
      const raw = await this.redis.lindex(holdKey(tenantId), 0)
      if (null === raw) return undefined
      try {
        return JSON.parse(raw) as HeldEnvelope
      } catch {
        await this.redis.lpop(holdKey(tenantId))
      }
    }
  }

  public async holdPop(tenantId: string): Promise<void> {
    await this.redis.lpop(holdKey(tenantId))
  }

  public async acquireDrainLock(tenantId: string, token: string): Promise<boolean> {
    return 'OK' === (await this.redis.set(drainKey(tenantId), token, 'PX', DRAIN_LOCK_MS, 'NX'))
  }

  public async refreshDrainLock(tenantId: string, token: string): Promise<boolean> {
    if (token !== (await this.redis.get(drainKey(tenantId)))) return false
    await this.redis.set(drainKey(tenantId), token, 'PX', DRAIN_LOCK_MS, 'XX')
    return true
  }

  public async releaseDrainLock(tenantId: string, token: string): Promise<void> {
    if (token === (await this.redis.get(drainKey(tenantId)))) {
      await this.redis.del(drainKey(tenantId))
    }
  }

  /** Best effort: a counter failure must never affect message delivery. */
  public async recordMessage(tenantId: string, fingerprint: string, now: Date = new Date()): Promise<void> {
    const daily = dailyKey(tenantId, dayStamp(now))
    await this.redis.incr(daily)
    await this.redis.expire(daily, DAILY_COUNTER_TTL_SECONDS)
    await this.redis.hincrby(seenKey(fingerprint), 'count', 1)
    await this.redis.hset(seenKey(fingerprint), 'last', now.toISOString())
    await this.redis.expire(seenKey(fingerprint), SEEN_COUNTER_TTL_SECONDS)
  }

  public async messagesInLastDays(tenantId: string, days: number, now: Date = new Date()): Promise<number> {
    const keys = Array.from({ length: days }, (_, offset) =>
      dailyKey(tenantId, dayStamp(new Date(now.getTime() - offset * 24 * 60 * 60 * 1000))),
    )
    const counts = await this.redis.mget(...keys)
    return counts.reduce((total, count) => total + Number(count ?? 0), 0)
  }

  public async disconnect(): Promise<void> {
    await this.redis.quit().catch(() => undefined)
  }
}
