import type { NatsConfig, PurgeConfig } from './PurgeTypes'

import { connect } from 'nats'

import { buildNatsAuthenticator } from '../utils/NatsAuthenticator'

export async function validatePurgeConfig(config: PurgeConfig): Promise<void> {
  const { natsConfig, cronConfig } = config

  if (!natsConfig.enabled && !cronConfig.enabled) {
    throw new Error(
      '[Purge] PURGE_ENABLED=true but neither PURGE_NATS_ENABLED nor PURGE_CRON_ENABLED is set to true. ' +
        'Enable at least one mode.',
    )
  }

  if (cronConfig.enabled && cronConfig.staleProofEnabled && cronConfig.staleProofTtlSeconds < cronConfig.ttlSeconds) {
    // The stale-proof policy targets records that are still open, so a TTL shorter than the terminal
    // one would delete in-flight verifications sooner than completed ones — always a
    // misconfiguration, and one that silently destroys live flows if allowed through.
    throw new Error(
      `[Purge] PURGE_CRON_STALE_PROOF_TTL_SECONDS (${cronConfig.staleProofTtlSeconds}) must be >= ` +
        `PURGE_CRON_TTL_SECONDS (${cronConfig.ttlSeconds}). Incomplete proof exchanges must never be ` +
        'purged more aggressively than completed ones.',
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
