import '@openwallet-foundation/askar-nodejs'
import type { RelayPipeline, RelayRedis } from '../RelayStore'

import { Kms, TypedArrayEncoder } from '@credo-ts/core'
import { Key, KeyAlgorithm } from '@openwallet-foundation/askar-shared'

/** In-memory stand-in for the ioredis commands the relay uses; TTLs are recorded, not enforced. */
export class FakeRedis implements RelayRedis {
  public readonly strings = new Map<string, string>()
  public readonly lists = new Map<string, string[]>()
  public readonly hashes = new Map<string, Map<string, string>>()
  public readonly counters = new Map<string, number>()
  public readonly ttls = new Map<string, number>()
  public failing = false
  public calls: string[] = []

  private guard(command: string): void {
    this.calls.push(command)
    if (this.failing) throw new Error('Redis is down')
  }

  public async get(key: string) {
    this.guard('get')
    return this.strings.get(key) ?? (this.counters.has(key) ? String(this.counters.get(key)) : null)
  }

  public async set(key: string, value: string, ...args: (string | number)[]) {
    this.guard('set')
    const exists = this.strings.has(key)
    if (args.includes('NX') && exists) return null
    if (args.includes('XX') && !exists) return null
    this.strings.set(key, value)
    return 'OK'
  }

  public async del(...keys: string[]) {
    this.guard('del')
    let removed = 0
    for (const key of keys) {
      if (this.strings.delete(key) || this.lists.delete(key) || this.hashes.delete(key) || this.counters.delete(key))
        removed += 1
    }
    return removed
  }

  public async mget(...keys: string[]) {
    this.guard('mget')
    return keys.map((key) => this.strings.get(key) ?? (this.counters.has(key) ? String(this.counters.get(key)) : null))
  }

  public async rpush(key: string, ...values: string[]) {
    this.guard('rpush')
    const list = this.lists.get(key) ?? []
    list.push(...values)
    this.lists.set(key, list)
    return list.length
  }

  public async rpop(key: string) {
    this.guard('rpop')
    return this.lists.get(key)?.pop() ?? null
  }

  public async lpop(key: string) {
    this.guard('lpop')
    return this.lists.get(key)?.shift() ?? null
  }

  public async lindex(key: string, index: number) {
    this.guard('lindex')
    return this.lists.get(key)?.[index] ?? null
  }

  public async llen(key: string) {
    this.guard('llen')
    return this.lists.get(key)?.length ?? 0
  }

  public async expire(key: string, seconds: number) {
    this.guard('expire')
    this.ttls.set(key, seconds)
    return 1
  }

  public async incr(key: string) {
    this.guard('incr')
    const next = (this.counters.get(key) ?? 0) + 1
    this.counters.set(key, next)
    return next
  }

  public async hincrby(key: string, field: string, increment: number) {
    this.guard('hincrby')
    const hash = this.hashes.get(key) ?? new Map<string, string>()
    const next = Number(hash.get(field) ?? 0) + increment
    hash.set(field, String(next))
    this.hashes.set(key, hash)
    return next
  }

  public async hset(key: string, field: string, value: string) {
    this.guard('hset')
    const hash = this.hashes.get(key) ?? new Map<string, string>()
    hash.set(field, value)
    this.hashes.set(key, hash)
    return 1
  }

  public pipeline(): RelayPipeline {
    const queued: (() => Promise<unknown>)[] = []
    const pipeline: RelayPipeline = {
      set: (key, value) => {
        queued.push(() => this.set(key, value))
        return pipeline
      },
      del: (...keys) => {
        queued.push(() => this.del(...keys))
        return pipeline
      },
      exec: async () => {
        for (const command of queued) await command()
        return []
      },
    }
    return pipeline
  }

  public async ping() {
    this.guard('ping')
    return 'PONG'
  }

  public async quit() {
    return 'OK'
  }
}

export interface TestRecipient {
  kid: string
  fingerprint: string
}

export const newRecipient = (): TestRecipient => {
  const key = Key.generate(KeyAlgorithm.Ed25519)
  const publicKey = Uint8Array.from(key.publicBytes)
  key.handle.free()
  return {
    kid: TypedArrayEncoder.toBase58(publicKey),
    fingerprint: Kms.PublicJwk.fromPublicKey({ crv: 'Ed25519', kty: 'OKP', publicKey }).fingerprint,
  }
}

/** A DIDComm v1 JWE-shaped envelope addressed to the given recipients' kids. */
export const buildEnvelope = (kids: string[], extra: Record<string, unknown> = {}): string => {
  const header = {
    enc: 'xchacha20poly1305_ietf',
    typ: 'JWM/1.0',
    alg: 'Authcrypt',
    recipients: kids.map((kid) => ({ encrypted_key: 'ZW5jcnlwdGVk', header: { kid, sender: 'c2VuZGVy', iv: 'aXY' } })),
  }
  return JSON.stringify({
    protected: Buffer.from(JSON.stringify(header)).toString('base64url'),
    iv: 'aXY',
    ciphertext: 'Y2lwaGVydGV4dA',
    tag: 'dGFn',
    ...extra,
  })
}

export const DIDCOMM_MIME = 'application/didcomm-envelope-enc'

export const eventually = async (check: () => boolean | Promise<boolean>, timeoutMs = 3000): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('condition not met in time')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

export const silentLogger = (): never =>
  ({
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
    trace: () => undefined,
  }) as never
