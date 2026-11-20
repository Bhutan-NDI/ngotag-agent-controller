import type { RelayStore } from './RelayStore'
import type { ForwardFn } from './relayForwarder'
import type { TsLogger } from '../../utils/logger'

import { randomUUID } from 'crypto'

import { DRAIN_BACKOFF_BASE_MS, DRAIN_BACKOFF_MAX_MS } from './relayConfig'

export interface DrainerOptions {
  backoffBaseMs?: number
  backoffMaxMs?: number
}

/**
 * Delivers a FORWARD tenant's buffered envelopes to its target: the buffer built up during the freeze, and anything a
 * live forward could not send because the target was unreachable. A Redis lock keeps the shared agent's tasks from
 * draining the same buffer twice. An envelope that never left, or that the target refused with 503 or 429 (nothing
 * accepted it), is retried with backoff; one that got any other answer, or may have been delivered, is removed so it
 * cannot be sent twice.
 */
export class RelayDrainer {
  private readonly running = new Set<string>()
  private readonly timers = new Map<string, NodeJS.Timeout>()
  private stopped = false
  private readonly backoffBaseMs: number
  private readonly backoffMaxMs: number

  public constructor(
    private readonly store: RelayStore,
    private readonly forward: ForwardFn,
    private readonly logger: TsLogger,
    options: DrainerOptions = {},
  ) {
    this.backoffBaseMs = options.backoffBaseMs ?? DRAIN_BACKOFF_BASE_MS
    this.backoffMaxMs = options.backoffMaxMs ?? DRAIN_BACKOFF_MAX_MS
  }

  /** Starts draining in the background if this process is not already doing so. Never throws. */
  public ensureDraining(tenantId: string): void {
    if (this.stopped || this.running.has(tenantId) || this.timers.has(tenantId)) return
    this.run(tenantId, 0).catch((error) => {
      this.logger.error(`[RelayDrainer] drain for tenant '${tenantId}' failed: ${error}`)
    })
  }

  public stop(): void {
    this.stopped = true
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
  }

  private async run(tenantId: string, attempt: number): Promise<void> {
    this.running.add(tenantId)
    const token = randomUUID()
    let retryAfterAttempt: number | undefined
    let lockHeld = false
    try {
      lockHeld = await this.store.acquireDrainLock(tenantId, token)
      if (!lockHeld) {
        // Another task is draining; look again later in case it stops before the buffer is empty.
        retryAfterAttempt = attempt
        return
      }

      for (;;) {
        const entry = await this.store.getEntry(tenantId)
        if (!entry || 'FORWARD' !== entry.mode || !entry.target) return
        const envelope = await this.store.holdPeek(tenantId)
        if (!envelope) return

        const result = await this.forward(entry.target, { contentType: envelope.contentType, body: envelope.body })
        // 503/429: the target did not take the message (e.g. no healthy target behind its load balancer); keep it.
        const notTaken = 'response' === result.kind && (503 === result.status || 429 === result.status)
        if ('neverLeft' === result.kind || notTaken) {
          retryAfterAttempt = attempt + 1
          return
        }
        if ('ambiguous' === result.kind) {
          this.logger.warn(
            `[RelayDrainer] dropping a buffered envelope for tenant '${tenantId}': delivery unknown (${result.reason}); not retried to avoid a duplicate`,
          )
        }
        await this.store.holdPop(tenantId)
        attempt = 0
        if (!(await this.store.refreshDrainLock(tenantId, token))) return
      }
    } finally {
      if (lockHeld) await this.store.releaseDrainLock(tenantId, token).catch(() => undefined)
      this.running.delete(tenantId)
      if (undefined !== retryAfterAttempt) this.scheduleRetry(tenantId, retryAfterAttempt)
    }
  }

  private scheduleRetry(tenantId: string, attempt: number): void {
    if (this.stopped) return
    const delay = Math.min(this.backoffBaseMs * 2 ** Math.max(attempt - 1, 0), this.backoffMaxMs)
    const timer = setTimeout(() => {
      this.timers.delete(tenantId)
      this.run(tenantId, attempt).catch((error) => {
        this.logger.error(`[RelayDrainer] retry for tenant '${tenantId}' failed: ${error}`)
      })
    }, delay)
    timer.unref()
    this.timers.set(tenantId, timer)
  }
}
