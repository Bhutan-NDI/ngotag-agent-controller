import type { NatsConfig, PurgeConfig } from './PurgeTypes'

import { connect } from 'nats'
import cron from 'node-cron'

import { buildNatsAuthenticator } from '../utils/NatsAuthenticator'

import { MIN_ABANDONED_TTL_SECONDS } from './PurgeTypes'

export async function validatePurgeConfig(config: PurgeConfig): Promise<void> {
  const { natsConfig, cronConfig } = config

  if (!natsConfig.enabled && !cronConfig.enabled) {
    throw new Error(
      '[Purge] PURGE_ENABLED=true but neither PURGE_NATS_ENABLED nor PURGE_CRON_ENABLED is set to true. ' +
        'Enable at least one mode.',
    )
  }

  if (cronConfig.enabled && !cron.validate(cronConfig.cronSchedule)) {
    // node-cron does validate, but only when the task is created, and it fails with a bare
    // "Cannot read properties of undefined (reading 'replace')" that names neither the purge nor the
    // schedule — leaving an operator with a crashed agent and no clue why. Fail here instead.
    throw new Error(
      `[Purge] PURGE_CRON_SCHEDULE is not a valid cron expression: "${cronConfig.cronSchedule}". ` +
        'Expected 5 or 6 fields, e.g. "0 3 * * *" for 03:00 daily.',
    )
  }

  if (
    cronConfig.enabled &&
    cronConfig.abandonedTtlSeconds < MIN_ABANDONED_TTL_SECONDS &&
    !cronConfig.allowShortAbandonedTtl
  ) {
    // An absolute floor, NOT a "must be >= the terminal TTL" rule. Abandoned records are expected to
    // be purged far sooner than completed ones — dead requests have no value where completed
    // exchanges are audit records. The only real hazard is deleting a flow a holder is still
    // responding to, which is a minutes-scale window, so the floor guards that and nothing else.
    throw new Error(
      `[Purge] PURGE_CRON_ABANDONED_TTL_SECONDS (${cronConfig.abandonedTtlSeconds}) is below the ` +
        `${MIN_ABANDONED_TTL_SECONDS}s floor, which risks deleting flows a holder is still responding to. ` +
        'Set PURGE_CRON_ALLOW_SHORT_ABANDONED_TTL=true to override (testing only).',
    )
  }

  if (natsConfig.enabled) {
    // Deprecated flow (INTEGRATION-PLAN-develop.md §4.4). It is kept for reversibility, but enabling
    // it must be a deliberate, documented act rather than a flag someone flips by analogy with the
    // cron flow — it deletes without re-checking record state.
    if (!natsConfig.ackStateBlind) {
      throw new Error(
        '[Purge] PURGE_NATS_ENABLED=true is deprecated and refused by default. The NATS ' +
          'schedule-at-create flow fixes a record’s deletion time when the record is created, so it fires ' +
          'without re-checking state and can delete exchanges that are still in flight. Use the cron flow ' +
          '(PURGE_CRON_ENABLED=true), which re-checks state at delete time. To override anyway, set ' +
          'PURGE_NATS_ACK_STATE_BLIND=true.',
      )
    }
    await verifyNatsJetStream(natsConfig.nats)
  }
}

async function verifyNatsJetStream(nats: NatsConfig): Promise<void> {
  let nc: Awaited<ReturnType<typeof connect>> | null = null

  try {
    nc = await connect({
      servers: nats.servers,
      ...buildNatsAuthenticator(nats),
      timeout: 5000,
      maxReconnectAttempts: 0,
    })
  } catch (err: any) {
    throw new Error(
      `[Purge] PURGE_NATS_ENABLED=true but cannot connect to NATS at ${nats.servers.join(', ')}: ${err?.message}`,
    )
  }

  try {
    await nc.jetstreamManager()
  } catch (err: any) {
    throw new Error(
      `[Purge] Connected to NATS but JetStream is not enabled. Start NATS with the -js flag. Error: ${err?.message}`,
    )
  } finally {
    await nc.close()
  }
}
