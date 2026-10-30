import type { Agent } from '@credo-ts/core'
import type { Store } from '@openwallet-foundation/askar-shared'

import { AskarStoreManager } from '@credo-ts/askar'
import { AskarError } from '@openwallet-foundation/askar-shared'

const LEASE_CATEGORY = 'MigrationRotationLease'

export const RUNNER_LEASE = 'runner'
export const connectionLease = (connectionId: string): string => `connection:${connectionId}`

export type Leasing = Pick<RotationLease, 'acquire' | 'release'>

export type LeaseStore = () => Promise<{ store: Store; profile?: string }>

interface LeaseValue {
  owner: string
  expiresAt: number
}

/**
 * A lease in the agent's own wallet, so two tasks of one dedicated agent (an ECS deploy runs the old and the new task
 * side by side) cannot both rotate the same connection. Each decision is made inside a transaction that locks the
 * lease row (`forUpdate`); the first insert of a lease that does not exist yet is settled by the unique key. An
 * expired lease is taken over, which is what happens when the task holding it dies. Other jobs that must run on one
 * task only (the cron purge) keep their leases under their own `category`.
 */
export class RotationLease {
  public constructor(
    private readonly openStore: LeaseStore,
    private readonly category: string = LEASE_CATEGORY,
  ) {}

  public static forAgent(agent: Agent, category?: string): RotationLease {
    return new RotationLease(
      () => agent.dependencyManager.resolve(AskarStoreManager).getInitializedStoreWithProfile(agent.context),
      category,
    )
  }

  /** Takes the lease, or renews it when `owner` already holds it. @returns false when someone else holds it */
  public async acquire(name: string, owner: string, ttlMs: number, now: number = Date.now()): Promise<boolean> {
    const { store, profile } = await this.openStore()
    const session = await store.transaction(profile).open()
    try {
      const entry = await session.fetch({ category: this.category, name, forUpdate: true, isJson: true })
      const value = JSON.stringify({ owner, expiresAt: now + ttlMs } satisfies LeaseValue)
      if (entry) {
        const held = entry.value as unknown as LeaseValue
        if (held.owner !== owner && held.expiresAt > now) return false
        await session.replace({ category: this.category, name, value })
      } else {
        await session.insert({ category: this.category, name, value })
      }
      await session.commit()
      return true
    } catch (error) {
      // Two tasks inserting the first lease at once: the loser finds the key taken.
      if (error instanceof AskarError && /duplicate/i.test(error.message)) return false
      throw error
    } finally {
      await session.close().catch(() => undefined)
    }
  }

  /** Gives the lease up, if `owner` still holds it. */
  public async release(name: string, owner: string): Promise<void> {
    const { store, profile } = await this.openStore()
    const session = await store.transaction(profile).open()
    try {
      const entry = await session.fetch({ category: this.category, name, forUpdate: true, isJson: true })
      if (entry && (entry.value as unknown as LeaseValue).owner === owner) {
        await session.remove({ category: this.category, name })
        await session.commit()
      }
    } finally {
      await session.close().catch(() => undefined)
    }
  }
}
