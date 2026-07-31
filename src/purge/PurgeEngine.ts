/**
 * State-aware, batched, throttled purge engine — the steady-state ("Tier B") purge that runs inside
 * the live agent process.
 *
 * The algorithm is ported from the validated operator batch tool `credo-data-purge`
 * (`src/purge-core.ts`), which stays the source of truth for purge semantics
 * (INTEGRATION-PLAN-develop.md §4.2, §4.3, §6). Three deliberate divergences from the batch tool,
 * each because this code shares a process and a DB pool with the live agent:
 *
 *  1. **No global orphan sweep.** The batch tool's set-based sweep is O(total records) on every run
 *     and must not sit in a daily in-process job (§8). Instead each eligible parent's
 *     `DidCommMessageRecord` children are cascaded per-parent, so cost scales with the (small) daily
 *     delta and no new orphans are created. Legacy orphans left behind by past bulk deletes are a
 *     one-off `credo-data-purge` job, not this one's problem.
 *  2. **Sequential deletes within a batch** instead of `Promise.allSettled` over all 100. The batch
 *     tool runs standalone in a maintenance window and can afford 100 concurrent Askar sessions;
 *     here that many concurrent sessions would compete with live request traffic for the same pool.
 *     Throughput is not the constraint — a steady-state run has a small delta by construction.
 *  3. **Children are deleted before the parent, and the parent is skipped if any child delete
 *     fails.** The batch tool submits both in one settled batch and relies on its orphan sweep as
 *     the backstop; without that backstop the ordering has to be strict (see §8 reasoning above).
 *
 * Scanning is state-scoped (`findByQuery({ state })`, an indexed tag) rather than
 * `findAllByQuery({})`, which is what makes a daily run cheap: once terminal records past TTL are
 * purged every day, the terminal-state set stays bounded to roughly one TTL window (§8).
 */
import type { PurgeCronConfig, PurgeRecordType as PurgeRecordTypeValue } from './PurgeTypes'
import type { Agent, Logger } from '@credo-ts/core'

import { RecordNotFoundError } from '@credo-ts/core'
import { OpenId4VcIssuanceSessionRepository, OpenId4VcVerificationSessionRepository } from '@credo-ts/openid4vc'

import { sleep } from '../utils/webhook'

import {
  RECORD_TYPES_WITH_DIDCOMM_MESSAGE_CHILDREN,
  deleteDidCommMessageChildren,
  deletePurgeRecord,
  findDidCommMessageChildIds,
} from './PurgeDeleteRecord'
import {
  DIDCOMM_CREDENTIAL_TERMINAL_STATES,
  DIDCOMM_OOB_PURGEABLE_STATES,
  DIDCOMM_PROOF_NON_TERMINAL_STATES,
  DIDCOMM_PROOF_TERMINAL_STATES,
  OID4VC_ISSUANCE_TERMINAL_STATES,
  OID4VC_VERIFICATION_TERMINAL_STATES,
} from './PurgeStates'
import { PurgeRecordType } from './PurgeTypes'

/** The subset of a Credo record the engine reads. Kept structural so the engine stays testable. */
export interface PurgeableRecord {
  id: string
  createdAt?: Date | string
  updatedAt?: Date | string
  /** Present on `DidCommOutOfBandRecord`; drives the reusable-invitation retention rule. */
  reusable?: boolean
  /** Present on `OpenId4VcIssuanceSessionRecord`; drives the revocation-handle retention rule. */
  issuanceMetadata?: { StatusListInfo?: unknown } | null
}

/**
 * True when an OID4VC issuance session carries the status-list entry needed to revoke the credential
 * it issued. Written defensively — `issuanceMetadata` is free-form JSON on the record, so a
 * malformed or unexpected shape must read as "might be revocable" and keep the record rather than
 * fall through to deletion.
 */
function hasStatusListInfo(record: PurgeableRecord): boolean {
  const info = record.issuanceMetadata?.StatusListInfo
  if (info === undefined || info === null) return false
  if (Array.isArray(info)) return info.length > 0
  return true
}

export interface PurgeCategoryResult {
  recordType: PurgeRecordTypeValue
  /** Records returned by the state-scoped scans. */
  scanned: number
  /** Past TTL and not retained by policy. */
  eligible: number
  /** Past TTL but deliberately kept (currently only reusable `await-response` OOB invitations). */
  retainedByPolicy: number
  parentsDeleted: number
  childrenDeleted: number
  /** Deletes that found the record already gone — an idempotent success, not a failure. */
  alreadyAbsent: number
  failed: number
  /** True when the per-tenant time budget cut this category short; it resumes next run. */
  truncated: boolean
}

export interface PurgeTenantResult {
  tenantId: string
  dryRun: boolean
  durationMs: number
  categories: PurgeCategoryResult[]
  eligible: number
  parentsDeleted: number
  childrenDeleted: number
  failed: number
  truncated: boolean
}

/** Thrown internally when the per-tenant wall-clock budget is exhausted. Never escapes `purgeTenant`. */
class TimeBudgetExceededError extends Error {}

interface ScanPlan {
  /** Human-readable plan name for the audit log, e.g. `state=done`. */
  label: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  query: Record<string, any>
  /** Records with `updatedAt` at or before this instant are past TTL. */
  cutoff: Date
  /** Returns true when a past-TTL record must nonetheless be kept. */
  retain?: (record: PurgeableRecord) => boolean
}

interface EngineContext {
  agent: Agent
  tenantId: string
  config: PurgeCronConfig
  logger: Logger
  runId: string
  /** Absolute time after which the tenant is abandoned for this run; undefined when unbudgeted. */
  deadline?: number
  /** Invoked after each successful parent delete — used for the deprecated webhook notification. */
  onDeleted?: (recordType: PurgeRecordTypeValue, recordId: string, alreadyAbsent: boolean) => Promise<void>
}

type ScanFn = (query: Record<string, unknown>) => Promise<PurgeableRecord[]>

/**
 * Purge one wallet (a tenant agent in shared mode, or the root agent in dedicated mode).
 *
 * Never throws for per-category failures: each record type is isolated so a poison record in one
 * category cannot stop the others. The caller isolates tenants from each other in the same way.
 */
export async function purgeTenant(
  agent: Agent,
  tenantId: string,
  config: PurgeCronConfig,
  runId: string,
  onDeleted?: EngineContext['onDeleted'],
): Promise<PurgeTenantResult> {
  const startedAt = Date.now()
  const ctx: EngineContext = {
    agent,
    tenantId,
    config,
    logger: agent.config.logger,
    runId,
    deadline: config.timeBudgetMs > 0 ? startedAt + config.timeBudgetMs : undefined,
    onDeleted,
  }

  const categories: PurgeCategoryResult[] = []

  for (const recordType of config.recordTypes) {
    const result = emptyCategoryResult(recordType)
    categories.push(result)

    try {
      const scan = buildScanFn(agent, recordType)
      for (const plan of buildScanPlans(recordType, config)) {
        await runScanPlan(ctx, recordType, plan, scan, result)
      }
    } catch (error) {
      if (error instanceof TimeBudgetExceededError) {
        result.truncated = true
        ctx.logger.warn('[Purge] Time budget exhausted — tenant will resume on the next run', {
          runId,
          tenantId,
          recordType,
          timeBudgetMs: config.timeBudgetMs,
        })
        break
      }
      ctx.logger.error('[Purge] Record type failed — continuing with the next type', {
        runId,
        tenantId,
        recordType,
        error: (error as Error)?.message,
      })
    }
  }

  const summary: PurgeTenantResult = {
    tenantId,
    dryRun: config.dryRun,
    durationMs: Date.now() - startedAt,
    categories,
    eligible: sumBy(categories, (c) => c.eligible),
    parentsDeleted: sumBy(categories, (c) => c.parentsDeleted),
    childrenDeleted: sumBy(categories, (c) => c.childrenDeleted),
    failed: sumBy(categories, (c) => c.failed),
    truncated: categories.some((c) => c.truncated),
  }

  ctx.logger.info('[Purge] Tenant summary', {
    runId,
    tenantId: tenantId || '(dedicated)',
    dryRun: summary.dryRun,
    durationMs: summary.durationMs,
    eligible: summary.eligible,
    parentsDeleted: summary.parentsDeleted,
    childrenDeleted: summary.childrenDeleted,
    failed: summary.failed,
    truncated: summary.truncated,
    byType: categories.map((c) => ({
      recordType: c.recordType,
      scanned: c.scanned,
      eligible: c.eligible,
      retainedByPolicy: c.retainedByPolicy,
      parentsDeleted: c.parentsDeleted,
      childrenDeleted: c.childrenDeleted,
      alreadyAbsent: c.alreadyAbsent,
      failed: c.failed,
    })),
  })

  return summary
}

/**
 * The retention policy, expressed as the set of queries the purge is allowed to run.
 *
 * Safety is structural rather than checked: because credentials only ever get plans built from
 * `DIDCOMM_CREDENTIAL_TERMINAL_STATES`, there is no configuration or code path that can make the
 * engine query a non-terminal credential state. See `PurgeStates.ts` for why that matters.
 */
export function buildScanPlans(recordType: PurgeRecordTypeValue, config: PurgeCronConfig): ScanPlan[] {
  /** Completed flows — an audit record of something that happened. */
  const cutoff = cutoffFor(config.ttlSeconds)
  /** Dead flows — nobody responded and nobody will. Shorter by design. */
  const abandonedCutoff = cutoffFor(config.abandonedTtlSeconds)

  switch (recordType) {
    case PurgeRecordType.DIDCOMM_CREDENTIAL:
      return DIDCOMM_CREDENTIAL_TERMINAL_STATES.map((state) => ({
        label: `state=${state}`,
        query: { state },
        cutoff,
      }))

    case PurgeRecordType.DIDCOMM_PROOF: {
      const plans: ScanPlan[] = DIDCOMM_PROOF_TERMINAL_STATES.map((state) => ({
        label: `state=${state}`,
        query: { state },
        cutoff,
      }))

      // Opt-in only, and against its own far longer TTL, so an in-flight verification is never
      // caught. A holder answering a deleted proof request just gets an error and the verifier
      // re-requests — no credential data is at risk. The equivalent for credentials is unsafe and
      // is not offered at all.
      if (config.staleProofEnabled) {
        for (const state of DIDCOMM_PROOF_NON_TERMINAL_STATES) {
          plans.push({ label: `abandoned state=${state}`, query: { state }, cutoff: abandonedCutoff })
        }
      }

      return plans
    }

    case PurgeRecordType.DIDCOMM_OOB:
      return [
        {
          label: `state=${DIDCOMM_OOB_PURGEABLE_STATES.terminal}`,
          query: { state: DIDCOMM_OOB_PURGEABLE_STATES.terminal },
          cutoff,
        },
        {
          label: `abandoned state=${DIDCOMM_OOB_PURGEABLE_STATES.stuck} (non-reusable only)`,
          query: { state: DIDCOMM_OOB_PURGEABLE_STATES.stuck },
          // An unscanned invitation is dead in exactly the way an unanswered proof request is, so it
          // gets the abandoned TTL rather than the terminal one. This matters more than the naming
          // suggests: OOB was the largest purgeable category in the July 2026 production drain
          // (~91% of it eligible), and `create-request-oob` mints one of these
          // per connectionless proof request — so they are the other half of the `request-sent` pile.
          cutoff: abandonedCutoff,
          // A reusable await-response record backs a published invitation URL / QR code. Deleting it
          // breaks every future scan, so it is retained regardless of age.
          retain: (record) => record.reusable === true,
        },
      ]

    case PurgeRecordType.OID4VC_ISSUANCE:
      return OID4VC_ISSUANCE_TERMINAL_STATES.map((state) => ({
        label: `state=${state}`,
        query: { state },
        cutoff,
        // The issuance session IS the revocation handle: `revokeBySessionId` reads
        // `issuanceMetadata.StatusListInfo` off this record to get {listId, index, issuerDid}, and
        // there is no other copy. Purging a revocable session would silently make that credential
        // permanently unrevocable, so any session carrying status-list info is kept indefinitely.
        // Sessions without it (nothing to revoke) and `Error` sessions still age out normally.
        retain: (record) => hasStatusListInfo(record),
      }))

    case PurgeRecordType.OID4VC_VERIFICATION:
      return OID4VC_VERIFICATION_TERMINAL_STATES.map((state) => ({
        label: `state=${state}`,
        query: { state },
        cutoff,
      }))

    default: {
      const _exhaustive: never = recordType as never
      throw new Error(`[Purge] No scan plan for record type: ${_exhaustive}`)
    }
  }
}

function buildScanFn(agent: Agent, recordType: PurgeRecordTypeValue): ScanFn {
  switch (recordType) {
    case PurgeRecordType.DIDCOMM_CREDENTIAL:
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (query) => (agent as any).modules.didcomm.credentials.findAllByQuery(query)

    case PurgeRecordType.DIDCOMM_PROOF:
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (query) => (agent as any).modules.didcomm.proofs.findAllByQuery(query)

    case PurgeRecordType.DIDCOMM_OOB:
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (query) => (agent as any).modules.didcomm.oob.findAllByQuery(query)

    case PurgeRecordType.OID4VC_ISSUANCE: {
      const repo = agent.dependencyManager.resolve(OpenId4VcIssuanceSessionRepository)
      return (query) => repo.findByQuery(agent.context, query)
    }

    case PurgeRecordType.OID4VC_VERIFICATION: {
      const repo = agent.dependencyManager.resolve(OpenId4VcVerificationSessionRepository)
      return (query) => repo.findByQuery(agent.context, query)
    }

    default: {
      const _exhaustive: never = recordType as never
      throw new Error(`[Purge] No scan function for record type: ${_exhaustive}`)
    }
  }
}

async function runScanPlan(
  ctx: EngineContext,
  recordType: PurgeRecordTypeValue,
  plan: ScanPlan,
  scan: ScanFn,
  result: PurgeCategoryResult,
): Promise<void> {
  assertWithinTimeBudget(ctx)

  // One continuous scan per plan, with no {limit, offset} paging. Askar applies no stable sort
  // across separate scan calls, so paginating a category over multiple queries silently skips or
  // double-counts rows — a hazard measured and documented in credo-data-purge's purgeOrphans. The
  // `state` tag keeps the result set bounded to roughly one TTL window in steady state (§8); the
  // *deletes* are what get batched and throttled below.
  const records = await scan(plan.query)
  result.scanned += records.length

  const eligible: PurgeableRecord[] = []
  for (const record of records) {
    if (!isPastCutoff(record, plan.cutoff)) continue
    if (plan.retain?.(record)) {
      result.retainedByPolicy++
      continue
    }
    eligible.push(record)
  }
  result.eligible += eligible.length

  ctx.logger.debug('[Purge] Scan plan complete', {
    runId: ctx.runId,
    tenantId: ctx.tenantId,
    recordType,
    plan: plan.label,
    scanned: records.length,
    eligible: eligible.length,
  })

  if (eligible.length === 0) return

  const { batchSize, throttleMs } = ctx.config

  for (let offset = 0; offset < eligible.length; offset += batchSize) {
    // The first batch of a plan is never budget-gated. The scan has already been paid for by this
    // point, so bailing out before deleting anything would burn the expensive half of the work and
    // make no progress — and a tenant whose scan alone outlasts the budget would then never purge
    // anything, on any run. Letting one batch through guarantees forward progress; the overshoot is
    // bounded by batchSize.
    if (offset > 0) assertWithinTimeBudget(ctx)

    const batch = eligible.slice(offset, offset + batchSize)
    const before = { parents: result.parentsDeleted, absent: result.alreadyAbsent, failed: result.failed }

    for (const record of batch) {
      await processRecord(ctx, recordType, record, result)
    }

    const progressed =
      result.parentsDeleted - before.parents > 0 ||
      result.alreadyAbsent - before.absent > 0 ||
      // In dry-run nothing is deleted, so "no progress" is the expected outcome, not a failure.
      ctx.config.dryRun

    // Zero-progress guard (credo-data-purge `assertDeleteProgress`): if every delete in a batch
    // genuinely failed, something systemic is wrong — a lock, a poison record, a broken store.
    // Aborting the category beats grinding through the whole eligible set logging the same error.
    if (!progressed) {
      throw new Error(
        `[Purge] ${recordType} ${plan.label}: 0/${batch.length} deletes succeeded in this batch — ` +
          'possible lock or poison record. Aborting this record type.',
      )
    }

    ctx.logger.debug('[Purge] Batch complete', {
      runId: ctx.runId,
      tenantId: ctx.tenantId,
      recordType,
      plan: plan.label,
      progress: `${Math.min(offset + batch.length, eligible.length)}/${eligible.length}`,
      dryRun: ctx.config.dryRun,
    })

    if (throttleMs > 0) await sleep(throttleMs)
  }
}

async function processRecord(
  ctx: EngineContext,
  recordType: PurgeRecordTypeValue,
  record: PurgeableRecord,
  result: PurgeCategoryResult,
): Promise<void> {
  const cascade = RECORD_TYPES_WITH_DIDCOMM_MESSAGE_CHILDREN.has(recordType)

  try {
    const childIds = cascade ? await findDidCommMessageChildIds(ctx.agent, record.id) : []

    if (ctx.config.dryRun) {
      // Count what *would* go, so a dry-run census is directly comparable to a live run.
      result.childrenDeleted += childIds.length
      result.parentsDeleted++
      return
    }

    // Children first, then the parent. If a child delete throws, the parent is left in place and
    // the whole record is retried on the next run — the alternative is an orphaned message that
    // only a full-wallet sweep could ever find again.
    if (childIds.length > 0) {
      result.childrenDeleted += await deleteDidCommMessageChildren(ctx.agent, childIds)
    }

    await deletePurgeRecord(ctx.agent, recordType, record.id)
    result.parentsDeleted++
    await ctx.onDeleted?.(recordType, record.id, false)
  } catch (error) {
    if (error instanceof RecordNotFoundError) {
      // Idempotent success: the desired end state (record gone) already holds. Happens on retries
      // and when the live agent deleted the record between the scan and the delete.
      result.alreadyAbsent++
      ctx.logger.debug('[Purge] Record already absent — treated as deleted', {
        runId: ctx.runId,
        tenantId: ctx.tenantId,
        recordType,
        recordId: record.id,
      })
      await ctx.onDeleted?.(recordType, record.id, true)
      return
    }

    result.failed++
    ctx.logger.error('[Purge] Failed to delete record', {
      runId: ctx.runId,
      tenantId: ctx.tenantId,
      recordType,
      recordId: record.id,
      error: (error as Error)?.message,
    })
  }
}

/**
 * TTL is keyed on `updatedAt` (last activity), not `createdAt`. `AskarStorageService` stamps
 * `updatedAt` on every save and update, so for a terminal record it is the moment the flow closed —
 * which is what a retention window should measure. `createdAt` would delete a long-running exchange
 * that only just completed.
 *
 * A record with neither timestamp is never eligible: without an age there is no way to show it is
 * past TTL, and refusing to delete is the safe default.
 */
function isPastCutoff(record: PurgeableRecord, cutoff: Date): boolean {
  const timestamp = toDate(record.updatedAt) ?? toDate(record.createdAt)
  if (!timestamp) return false
  return timestamp.getTime() <= cutoff.getTime()
}

function toDate(value: Date | string | undefined): Date | undefined {
  if (value === undefined || value === null) return undefined
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? undefined : date
}

function cutoffFor(ttlSeconds: number): Date {
  return new Date(Date.now() - ttlSeconds * 1000)
}

function assertWithinTimeBudget(ctx: EngineContext): void {
  if (ctx.deadline !== undefined && Date.now() >= ctx.deadline) {
    throw new TimeBudgetExceededError()
  }
}

function emptyCategoryResult(recordType: PurgeRecordTypeValue): PurgeCategoryResult {
  return {
    recordType,
    scanned: 0,
    eligible: 0,
    retainedByPolicy: 0,
    parentsDeleted: 0,
    childrenDeleted: 0,
    alreadyAbsent: 0,
    failed: 0,
    truncated: false,
  }
}

function sumBy<T>(items: T[], pick: (item: T) => number): number {
  return items.reduce((total, item) => total + pick(item), 0)
}
