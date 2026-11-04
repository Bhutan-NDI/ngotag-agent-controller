import { randomBytes } from 'crypto'

export const NONCE_TTL_MS = 2 * 60 * 1000

export type NonceConsumeResult = 'ok' | 'unknown' | 'expired' | 'used'

interface Entry {
  scope: string
  policy: string
  expiresAt: number
}

/**
 * Single-use verifier nonces with a TTL. In memory, so it is lost on restart and only valid for one controller
 * instance (a documented PoC limit). Nonces are scoped to a verifier (tenant), so a nonce issued to one verifier is
 * 'unknown' to every other.
 */
export class NonceStore {
  private readonly entries = new Map<string, Entry>()
  private readonly consumed = new Map<string, number>()

  public constructor(
    private readonly now: () => number = Date.now,
    private readonly ttlMs: number = NONCE_TTL_MS,
  ) {}

  /** 32 random bytes, base64url (43 characters). */
  public issue(scope: string, policy: string): { nonce: string; expiresAt: Date } {
    this.sweep()
    const nonce = randomBytes(32).toString('base64url')
    const expiresAt = this.now() + this.ttlMs
    this.entries.set(nonce, { scope, policy, expiresAt })
    return { nonce, expiresAt: new Date(expiresAt) }
  }

  /**
   * Burns the nonce in every case where it is found, so a failed verification cannot be retried with the same nonce.
   * A nonce for another scope is reported 'unknown' and left alone.
   */
  public consume(scope: string, nonce: string): { result: NonceConsumeResult; policy?: string } {
    this.sweep()
    const entry = this.entries.get(nonce)
    if (!entry || entry.scope !== scope) {
      const usedAt = this.consumed.get(`${scope}:${nonce}`)
      return { result: usedAt !== undefined ? 'used' : 'unknown' }
    }
    this.entries.delete(nonce)
    this.consumed.set(`${scope}:${nonce}`, entry.expiresAt)
    if (this.now() > entry.expiresAt) return { result: 'expired', policy: entry.policy }
    return { result: 'ok', policy: entry.policy }
  }

  /** Drops expired entries, and consumed markers once their nonce could no longer be valid anyway. */
  private sweep(): void {
    const now = this.now()
    // An expired nonce stays in `entries` until looked up, so a late use reports 'expired' rather than 'unknown'.
    // Keep it for one extra TTL, then forget it.
    for (const [nonce, entry] of this.entries) if (now > entry.expiresAt + this.ttlMs) this.entries.delete(nonce)
    for (const [key, expiresAt] of this.consumed) if (now > expiresAt + this.ttlMs) this.consumed.delete(key)
  }
}
