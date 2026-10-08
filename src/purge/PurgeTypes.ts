// Cron defaults live here rather than in PurgeConstants.ts because PurgeConstants imports
// PurgeRecordType from this module, and `import/no-cycle` is an error in this repo.
const DEFAULT_TTL_SECONDS = 2_592_000 // 30 days — completed flows (audit value)
const DEFAULT_ABANDONED_TTL_SECONDS = 604_800 // 7 days — dead flows (no value)
const DEFAULT_BATCH_SIZE = 100 // matches credo-data-purge BATCH_SIZE
const DEFAULT_THROTTLE_MS = 250 // matches credo-data-purge THROTTLE_MS

/**
 * Floor on the abandoned TTL. The real hazard is deleting a flow a holder is still responding to,
 * and that window is minutes, not months — so an hour has ample margin. Overridable for testing via
 * `PURGE_CRON_ALLOW_SHORT_ABANDONED_TTL`, mirroring credo-data-purge's `STALE_ALLOW_ZERO_TTL`.
 */
export const MIN_ABANDONED_TTL_SECONDS = 3_600

export interface NatsConfig {
  servers: string[]
  nkeySeed?: string
  credentialsFile?: string
  username?: string
  password?: string
}

export type AgentMode = 'shared' | 'dedicated'

export enum PurgeRecordType {
  DIDCOMM_CREDENTIAL = 'didcomm_credential',
  DIDCOMM_PROOF = 'didcomm_proof',
  DIDCOMM_OOB = 'didcomm_oob',
  OID4VC_ISSUANCE = 'oid4vc_issuance',
  OID4VC_VERIFICATION = 'oid4vc_verification',
}

export interface PurgeJob {
  recordId: string
  recordType: PurgeRecordType
  tenantId: string
  agentMode: AgentMode
  scheduledAt: string
}

/**
 * @deprecated The NATS schedule-at-create flow is retained only for reversibility and is dormant by
 * default (`PURGE_NATS_ENABLED=false`). It fixes the deletion time when the record is *created*, so
 * it fires state-blind at TTL and can delete records that are still in flight; it also depends on
 * the JetStream `allow_msg_schedules` feature. Prefer the cron flow, which re-checks state at delete
 * time. See INTEGRATION-PLAN-develop.md §4.4 — slated for removal once cron parity is proven in prod.
 */
export interface PurgeNatsConfig {
  enabled: boolean
  ttlSeconds: number
  nats: NatsConfig
  recordTypes: PurgeRecordType[]
  /** Operator acknowledgement that this flow deletes records without re-checking their state. */
  ackStateBlind: boolean
}

export interface PurgeCronConfig {
  enabled: boolean
  /** Terminal-state records whose `updatedAt` is older than this are eligible. */
  ttlSeconds: number
  cronSchedule: string
  recordTypes: PurgeRecordType[]
  /**
   * When true, scan and report a census but never delete. Opt-in (default false).
   *
   * Not the default, unlike `credo-data-purge`: that tool's dry-run default is safe because an
   * operator reads the census and immediately re-runs live, whereas a cron job silently doing
   * nothing while looking enabled means unbounded storage growth found weeks later. What keeps this
   * job safe is structural — storage-level deletes, state-scoped scans, the retention rules in
   * `PurgeStates.ts`, and children-before-parent ordering — not the absence of deletion. The mode
   * exists for the pre-enable census (plan §7 step 5) and for §8's measure-don't-guess decision on
   * whether the largest tenant needs the batch tool instead.
   */
  dryRun: boolean
  /** Records processed between throttle sleeps. */
  batchSize: number
  /** Milliseconds slept between batches so the scan cannot monopolise the shared DB pool. */
  throttleMs: number
  /** Per-tenant wall-clock budget; 0 disables. A truncated tenant resumes on the next run. */
  timeBudgetMs: number
  /**
   * Purge non-terminal PROOF exchanges against `abandonedTtlSeconds`. On by default: the July 2026
   * production drain measured `request-sent` at ~68% of all proof exchanges and ~10% of the entire
   * wallet — making it the single largest contributor to both storage and the
   * proof-response latency it caused. Never applies to credentials.
   */
  staleProofEnabled: boolean
  /**
   * TTL for records that represent a *dead* flow rather than a completed one: non-terminal proof
   * exchanges (when `staleProofEnabled`) and non-reusable `await-response` OOB invitations.
   *
   * Deliberately SHORTER than `ttlSeconds`, which is the opposite of what an earlier revision of
   * this file assumed. A completed exchange is an audit record of a verification that happened and
   * has retention value; an unanswered proof request or unscanned invitation has none and is of no
   * use to anyone once it is a few hours old.
   */
  abandonedTtlSeconds: number
  /** Escape hatch allowing `abandonedTtlSeconds` below `MIN_ABANDONED_TTL_SECONDS`. Testing only. */
  allowShortAbandonedTtl: boolean
}

export interface PurgeConfig {
  natsConfig: PurgeNatsConfig
  cronConfig: PurgeCronConfig
  /**
   * @deprecated Per-record HTTP notification. Defaults to false — the receiving platform endpoints
   * (`/purge/*`) do not exist, and now that the purge no longer deletes stored holder credentials
   * there is nothing notification-worthy; the per-run audit log is the right level.
   * See INTEGRATION-PLAN-develop.md §4.5.
   */
  webhookEnabled: boolean
}

export function buildPurgeConfig(): PurgeConfig | undefined {
  if (process.env.PURGE_ENABLED !== 'true') return undefined

  const natsEnabled = process.env.PURGE_NATS_ENABLED === 'true'
  const cronEnabled = process.env.PURGE_CRON_ENABLED === 'true'

  if (!natsEnabled && !cronEnabled) {
    // Fail loudly rather than returning undefined. cliAgent only validates a truthy config, so
    // returning undefined here made the validator's own "enable at least one mode" error dead code
    // and turned a typo in PURGE_CRON_ENABLED into a purge that silently never runs while the master
    // switch reports it as on.
    throw new Error(
      '[Purge] PURGE_ENABLED=true but neither PURGE_NATS_ENABLED nor PURGE_CRON_ENABLED is set to "true". ' +
        'Enable the cron flow with PURGE_CRON_ENABLED=true, or set PURGE_ENABLED=false to disable purging.',
    )
  }

  return {
    natsConfig: {
      enabled: natsEnabled,
      ttlSeconds: parsePositiveInt(process.env.PURGE_NATS_TTL_SECONDS, 'PURGE_NATS_TTL_SECONDS', DEFAULT_TTL_SECONDS),
      nats: {
        servers: (process.env.NATS_SERVERS || 'nats://localhost:4222')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
        nkeySeed: process.env.NATS_NKEY_SEED,
        credentialsFile: process.env.NATS_CREDENTIALS_FILE,
        username: process.env.NATS_USER,
        password: process.env.NATS_PASSWORD,
      },
      recordTypes: buildPurgeRecordTypes(),
      ackStateBlind: process.env.PURGE_NATS_ACK_STATE_BLIND === 'true',
    },
    cronConfig: {
      enabled: cronEnabled,
      ttlSeconds: parsePositiveInt(process.env.PURGE_CRON_TTL_SECONDS, 'PURGE_CRON_TTL_SECONDS', DEFAULT_TTL_SECONDS),
      cronSchedule: process.env.PURGE_CRON_SCHEDULE || '0 * * * *',
      recordTypes: buildPurgeRecordTypes(),
      dryRun: parseStrictBoolean(process.env.PURGE_CRON_DRY_RUN, 'PURGE_CRON_DRY_RUN', false),
      batchSize: parsePositiveInt(process.env.PURGE_CRON_BATCH_SIZE, 'PURGE_CRON_BATCH_SIZE', DEFAULT_BATCH_SIZE),
      throttleMs: parseNonNegativeInt(
        process.env.PURGE_CRON_THROTTLE_MS,
        'PURGE_CRON_THROTTLE_MS',
        DEFAULT_THROTTLE_MS,
      ),
      timeBudgetMs: parseNonNegativeInt(process.env.PURGE_CRON_TIME_BUDGET_MS, 'PURGE_CRON_TIME_BUDGET_MS', 0),
      staleProofEnabled: parseStrictBoolean(
        process.env.PURGE_CRON_STALE_PROOF_ENABLED,
        'PURGE_CRON_STALE_PROOF_ENABLED',
        true,
      ),
      abandonedTtlSeconds: parsePositiveInt(
        process.env.PURGE_CRON_ABANDONED_TTL_SECONDS,
        'PURGE_CRON_ABANDONED_TTL_SECONDS',
        DEFAULT_ABANDONED_TTL_SECONDS,
      ),
      allowShortAbandonedTtl: process.env.PURGE_CRON_ALLOW_SHORT_ABANDONED_TTL === 'true',
    },
    webhookEnabled: process.env.PURGE_WEBHOOK_ENABLED === 'true',
  }
}

/**
 * Strict boolean: accepts only `true`, `false`, or unset/blank. Every other purge boolean is parsed
 * leniently (`=== 'true'`), which is fine because a typo there lands on the non-destructive side —
 * the feature simply stays off. `PURGE_CRON_DRY_RUN` is the one flag where lenient parsing would be
 * asymmetric in the dangerous direction, so a malformed value fails startup rather than silently
 * picking either mode.
 */
function parseStrictBoolean(value: string | undefined, envKey: string, defaultValue: boolean): boolean {
  const normalized = value?.trim()
  if (normalized === undefined || normalized === '') return defaultValue
  if (normalized === 'true') return true
  if (normalized === 'false') return false
  throw new Error(`[Purge] ${envKey} must be exactly "true" or "false", got: "${value}"`)
}

function parsePositiveInt(value: string | undefined, envKey: string, defaultValue: number): number {
  if (value === undefined || value.trim() === '') return defaultValue
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`[Purge] ${envKey} must be a positive integer, got: "${value}"`)
  }
  return parsed
}

function parseNonNegativeInt(value: string | undefined, envKey: string, defaultValue: number): number {
  if (value === undefined || value.trim() === '') return defaultValue
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`[Purge] ${envKey} must be a non-negative integer, got: "${value}"`)
  }
  return parsed
}

function buildPurgeRecordTypes(): PurgeRecordType[] {
  const envFlags: Record<string, PurgeRecordType> = {
    PURGE_DIDCOMM_CREDENTIAL: PurgeRecordType.DIDCOMM_CREDENTIAL,
    PURGE_DIDCOMM_PROOF: PurgeRecordType.DIDCOMM_PROOF,
    PURGE_DIDCOMM_OOB: PurgeRecordType.DIDCOMM_OOB,
    PURGE_OID4VC_ISSUANCE: PurgeRecordType.OID4VC_ISSUANCE,
    PURGE_OID4VC_VERIFICATION: PurgeRecordType.OID4VC_VERIFICATION,
  }

  const anyEnvSet = Object.keys(envFlags).some((key) => process.env[key] !== undefined)

  if (anyEnvSet) {
    const selected = Object.entries(envFlags)
      .filter(([key]) => process.env[key] === 'true')
      .map(([, type]) => type)

    if (selected.length === 0) {
      throw new Error(
        '[Purge] At least one PURGE_* record type flag must be set to "true" when any flag is present. ' +
          'Set PURGE_ENABLED=false to disable purge entirely.',
      )
    }

    return selected
  }

  return [
    PurgeRecordType.DIDCOMM_CREDENTIAL,
    PurgeRecordType.DIDCOMM_PROOF,
    PurgeRecordType.DIDCOMM_OOB,
    PurgeRecordType.OID4VC_ISSUANCE,
    PurgeRecordType.OID4VC_VERIFICATION,
  ]
}
