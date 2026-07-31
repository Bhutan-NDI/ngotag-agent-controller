/**
 * Steady-state purge trigger. Owns scheduling, tenant enumeration and the per-run audit log; all
 * scanning and deleting lives in `PurgeEngine`.
 *
 * This is the "Tier B" purge from INTEGRATION-PLAN-develop.md §3 — the recurring job runs inside the
 * agent process precisely so no second service needs a copy of `WALLET_KEY` and no second writer
 * touches the Askar store. Heavy one-off backfills stay with the operator-run `credo-data-purge`
 * tool (Tier A).
 */
import type { PurgeTenantResult } from '../PurgeEngine'
import type { PurgeConfig, PurgeRecordType } from '../PurgeTypes'
import type { Agent } from '@credo-ts/core'
import type { ScheduledTask } from 'node-cron'

import cron from 'node-cron'
import { randomUUID } from 'node:crypto'

import { purgeTenant } from '../PurgeEngine'
import { PurgeDeletionStatus, sendPurgeWebhook } from '../PurgeWebhook'

type DeletionNotifier = (
  recordType: PurgeRecordType,
  recordId: string,
  tenantId: string,
  alreadyAbsent: boolean,
) => Promise<void>

export class CronPurgeScheduler {
  private job: ScheduledTask | null = null
  private isRunning = false

  public async start(agent: Agent, config: PurgeConfig, webhookUrl: string | undefined): Promise<void> {
    const { cronConfig } = config

    this.job = cron.schedule(cronConfig.cronSchedule, () => {
      // Overlapping runs would double the DB load the throttle exists to cap, so a tick that
      // arrives while the previous run is still going is dropped rather than queued.
      if (this.isRunning) {
        agent.config.logger.warn('[Purge] Cron scan still running — skipping this tick')
        return
      }
      this.isRunning = true
      this.runScan(agent, config, webhookUrl)
        .catch((err: Error) => {
          agent.config.logger.error('[Purge] Cron scan error', { error: err?.message })
        })
        .finally(() => {
          this.isRunning = false
        })
    })

    if (cronConfig.dryRun) {
      agent.config.logger.warn(
        '[Purge] DRY-RUN mode (PURGE_CRON_DRY_RUN=true) — the cron purge will scan and report a census ' +
          'but delete nothing, so retained data will keep growing. Unset PURGE_CRON_DRY_RUN once the ' +
          'census has been reviewed.',
      )
    } else {
      agent.config.logger.warn('[Purge] LIVE mode — the cron purge will permanently delete records past TTL.')
    }

    agent.config.logger.info('[Purge] CronPurgeScheduler started', {
      cronSchedule: cronConfig.cronSchedule,
      ttlSeconds: cronConfig.ttlSeconds,
      recordTypes: cronConfig.recordTypes,
      dryRun: cronConfig.dryRun,
      batchSize: cronConfig.batchSize,
      throttleMs: cronConfig.throttleMs,
      timeBudgetMs: cronConfig.timeBudgetMs,
      abandonedTtlSeconds: cronConfig.abandonedTtlSeconds,
      staleProofEnabled: cronConfig.staleProofEnabled,
    })
  }

  public async stop(): Promise<void> {
    this.job?.stop()
    this.job = null
  }

  private async runScan(agent: Agent, config: PurgeConfig, webhookUrl: string | undefined): Promise<void> {
    const logger = agent.config.logger
    const { cronConfig } = config
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const isShared = typeof (agent as any).modules?.tenants?.getAllTenants === 'function'
    const runId = randomUUID()
    const startedAt = Date.now()

    logger.info('[Purge] Cron scan started', {
      runId,
      agentMode: isShared ? 'shared' : 'dedicated',
      dryRun: cronConfig.dryRun,
    })

    const notify = this.buildDeletionNotifier(agent, webhookUrl)
    const results: PurgeTenantResult[] = []
    let tenantsFailed = 0

    if (isShared) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const tenants: Array<{ id: string }> = await (agent as any).modules.tenants.getAllTenants()

      for (const tenant of tenants) {
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          await (agent as any).modules.tenants.withTenantAgent({ tenantId: tenant.id }, async (tenantAgent: Agent) => {
            results.push(await purgeTenant(tenantAgent, tenant.id, cronConfig, runId, scopeNotifier(notify, tenant.id)))
          })
        } catch (err) {
          // Tenants are isolated: one unopenable wallet must not stop the rest of the run.
          tenantsFailed++
          logger.error('[Purge] Failed to purge tenant', { runId, tenantId: tenant.id, error: (err as Error)?.message })
        }
      }
    } else {
      results.push(await purgeTenant(agent, '', cronConfig, runId, scopeNotifier(notify, '')))
    }

    // Per-run audit record. This — not the deprecated per-record webhook — is the purge's
    // notification surface (INTEGRATION-PLAN-develop.md §4.5).
    logger.info('[Purge] Cron scan completed', {
      runId,
      dryRun: cronConfig.dryRun,
      durationMs: Date.now() - startedAt,
      tenantsProcessed: results.length,
      tenantsFailed,
      tenantsTruncated: results.filter((result) => result.truncated).length,
      eligible: sum(results.map((result) => result.eligible)),
      parentsDeleted: sum(results.map((result) => result.parentsDeleted)),
      childrenDeleted: sum(results.map((result) => result.childrenDeleted)),
      failed: sum(results.map((result) => result.failed)),
    })
  }

  /**
   * @deprecated Builds the per-record webhook notifier, or returns undefined when the webhook is
   * disabled (the default). Retained for reversibility only — see `PurgeWebhook.ts`.
   */
  private buildDeletionNotifier(agent: Agent, webhookUrl: string | undefined): DeletionNotifier | undefined {
    if (!webhookUrl) return undefined

    return async (recordType, recordId, tenantId, alreadyAbsent) => {
      const status = alreadyAbsent ? PurgeDeletionStatus.ALREADY_ABSENT : PurgeDeletionStatus.DELETED
      try {
        await sendPurgeWebhook(webhookUrl, recordId, recordType, tenantId, status, agent.config.logger)
      } catch (err) {
        // Notification is best-effort — a webhook failure must never make a completed delete look
        // like a failed purge.
        agent.config.logger.warn('[Purge] Webhook delivery failed after deletion', {
          recordId,
          recordType,
          error: (err as Error)?.message,
        })
      }
    }
  }
}

function scopeNotifier(notify: DeletionNotifier | undefined, tenantId: string) {
  if (!notify) return undefined
  return (recordType: PurgeRecordType, recordId: string, alreadyAbsent: boolean) =>
    notify(recordType, recordId, tenantId, alreadyAbsent)
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0)
}
