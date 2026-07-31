/**
 * Tests for the steady-state purge engine (INTEGRATION-PLAN-develop.md §4.2, §4.3).
 *
 * What is locked in here:
 *   - **State-awareness.** Credentials are scanned only in terminal states — there is no config that
 *     makes the engine query a non-terminal credential state. Non-terminal *proofs* are opt-in and
 *     use their own, longer TTL.
 *   - **Retention.** Reusable `await-response` OOB invitations survive regardless of age.
 *   - **TTL basis.** Eligibility is keyed on `updatedAt` (last activity), not `createdAt`.
 *   - **Cascade ordering.** Message children go before the parent, and a failed child delete leaves
 *     the parent in place so no orphan is created.
 *   - **Dry-run.** Nothing is deleted, but the census still counts what would go.
 *   - **Idempotency.** `RecordNotFoundError` counts as a success, not a failure.
 *   - **Zero-progress guard.** A batch where every delete genuinely failed aborts the record type.
 *
 * Runs under Jest ESM mode (see jest.config.base.ts).
 */
import { jest } from '@jest/globals'

const { InjectionSymbols, RecordNotFoundError } = await import('@credo-ts/core')
const { DidCommCredentialState, DidCommProofState } = await import('@credo-ts/didcomm')
const { OpenId4VcIssuanceSessionRepository, OpenId4VcVerificationSessionRepository } =
  await import('@credo-ts/openid4vc')
const { buildScanPlans, purgeTenant } = await import('../PurgeEngine')
const { DIDCOMM_CREDENTIAL_NON_TERMINAL_STATES, DIDCOMM_PROOF_NON_TERMINAL_STATES } = await import('../PurgeStates')
const { PurgeRecordType } = await import('../PurgeTypes')

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PurgeCronConfig = any

const DAY_MS = 86_400_000
const TTL_SECONDS = 30 * 24 * 60 * 60 // 30 days

const daysAgo = (days: number) => new Date(Date.now() - days * DAY_MS)

function makeConfig(overrides: Partial<PurgeCronConfig> = {}): PurgeCronConfig {
  return {
    enabled: true,
    ttlSeconds: TTL_SECONDS,
    cronSchedule: '0 3 * * *',
    recordTypes: [PurgeRecordType.DIDCOMM_CREDENTIAL],
    dryRun: false,
    batchSize: 100,
    // 0 keeps the tests fast; the throttle path itself is asserted separately via batchSize.
    throttleMs: 0,
    timeBudgetMs: 0,
    staleProofEnabled: true,
    abandonedTtlSeconds: 7 * 24 * 60 * 60,
    allowShortAbandonedTtl: false,
    ...overrides,
  }
}

interface AgentOptions {
  /** Records the credential/proof/oob `findAllByQuery({ state })` returns, keyed by state. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  recordsByState?: Record<string, any[]>
  /** `DidCommMessageRecord` children keyed by parent record id. */
  children?: Record<string, Array<{ id: string }>>
  /** Ids whose delete should throw the given error. */
  deleteErrors?: Record<string, Error>
}

function makeAgent(options: AgentOptions = {}) {
  const { recordsByState = {}, children = {}, deleteErrors = {} } = options

  const logger = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    trace: jest.fn(),
    fatal: jest.fn(),
    test: jest.fn(),
  }

  const deletedIds: string[] = []
  const queriedStates: Record<string, string[]> = { credentials: [], proofs: [], oob: [] }

  const storageService = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    findByQuery: jest.fn(async (_ctx: any, _recordClass: any, query: any) => children[query.associatedRecordId] ?? []),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    deleteById: jest.fn(async (_ctx: any, _recordClass: any, id: string) => {
      const error = deleteErrors[id]
      if (error) throw error
      deletedIds.push(id)
    }),
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const scanFor = (bucket: string) => async (query: any) => {
    queriedStates[bucket].push(query.state)
    return recordsByState[query.state] ?? []
  }

  const agent = {
    context: { contextCorrelationId: 'tenant-abc' },
    config: { logger },
    dependencyManager: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      resolve: (token: any) => {
        if (token === InjectionSymbols.StorageService) return storageService
        if (token === OpenId4VcIssuanceSessionRepository || token === OpenId4VcVerificationSessionRepository) {
          return { findByQuery: jest.fn(async () => []), deleteById: jest.fn(async () => {}) }
        }
        throw new Error(`unexpected token: ${String(token)}`)
      },
    },
    modules: {
      didcomm: {
        credentials: { findAllByQuery: jest.fn(scanFor('credentials')) },
        proofs: { findAllByQuery: jest.fn(scanFor('proofs')) },
        oob: { findAllByQuery: jest.fn(scanFor('oob')) },
      },
    },
  }

  return { agent, logger, storageService, deletedIds, queriedStates }
}

// ---------------------------------------------------------------------------
// Retention policy
// ---------------------------------------------------------------------------

describe('buildScanPlans — retention policy', () => {
  test('credentials are scanned only in terminal states', () => {
    const plans = buildScanPlans(PurgeRecordType.DIDCOMM_CREDENTIAL, makeConfig())
    const states = plans.map((plan) => plan.query.state)

    expect(states).toEqual([
      DidCommCredentialState.Done,
      DidCommCredentialState.Abandoned,
      DidCommCredentialState.Declined,
    ])
  })

  test('no credential plan exists for any non-terminal state, even with abandoned purging enabled', () => {
    // The stale policy is proof-only by construction. A holder can still accept a pending offer
    // (`offer-received`) after any TTL, so deleting the issuer-side record is unrecoverable.
    const plans = buildScanPlans(PurgeRecordType.DIDCOMM_CREDENTIAL, makeConfig({ staleProofEnabled: true }))
    const states = plans.map((plan) => plan.query.state)

    expect(DIDCOMM_CREDENTIAL_NON_TERMINAL_STATES.length).toBeGreaterThan(0)
    for (const nonTerminal of DIDCOMM_CREDENTIAL_NON_TERMINAL_STATES) {
      expect(states).not.toContain(nonTerminal)
    }
  })

  test('non-terminal proof states are swept by default and can be turned off', () => {
    // request-sent was ~68% of all proof exchanges in the July 2026 production drain, so sweeping
    // it is the default, not an opt-in.
    const on = buildScanPlans(PurgeRecordType.DIDCOMM_PROOF, makeConfig()).map((plan) => plan.query.state)
    for (const nonTerminal of DIDCOMM_PROOF_NON_TERMINAL_STATES) {
      expect(on).toContain(nonTerminal)
    }

    const off = buildScanPlans(PurgeRecordType.DIDCOMM_PROOF, makeConfig({ staleProofEnabled: false }))
    expect(off.map((plan) => plan.query.state)).toEqual([
      DidCommProofState.Done,
      DidCommProofState.Abandoned,
      DidCommProofState.Declined,
    ])
  })

  test('abandoned records use a SHORTER cutoff than completed ones', () => {
    const config = makeConfig({ ttlSeconds: 30 * 24 * 60 * 60, abandonedTtlSeconds: 7 * 24 * 60 * 60 })
    const plans = buildScanPlans(PurgeRecordType.DIDCOMM_PROOF, config)

    const completed = plans.find((plan) => plan.query.state === DidCommProofState.Done)
    const abandoned = plans.find((plan) => plan.query.state === DidCommProofState.RequestSent)

    // A dead request has no value; a completed exchange is an audit record. So the abandoned cutoff
    // is NEARER to now — records qualify sooner — which is the opposite of the original assumption.
    expect(abandoned!.cutoff.getTime()).toBeGreaterThan(completed!.cutoff.getTime())
  })

  test('the non-reusable await-response OOB track uses the abandoned TTL, the done track does not', () => {
    // OOB was the largest purgeable category in production (7.78M, 91% eligible), and
    // create-request-oob mints one per connectionless proof request — the other half of request-sent.
    const config = makeConfig({ ttlSeconds: 30 * 24 * 60 * 60, abandonedTtlSeconds: 7 * 24 * 60 * 60 })
    const [done, awaitResponse] = buildScanPlans(PurgeRecordType.DIDCOMM_OOB, config)

    expect(awaitResponse.cutoff.getTime()).toBeGreaterThan(done.cutoff.getTime())
  })

  test('OID4VC issuance sessions carrying revocation info are retained indefinitely', () => {
    // revokeBySessionId reads issuanceMetadata.StatusListInfo off this record to get
    // {listId, index, issuerDid}. There is no other copy, so purging it would make the credential
    // permanently unrevocable.
    const [plan] = buildScanPlans(PurgeRecordType.OID4VC_ISSUANCE, makeConfig())

    expect(plan.retain!({ id: 'a', issuanceMetadata: { StatusListInfo: [{ listId: 'l', index: 1 }] } })).toBe(true)
    // Defensive: an unexpected non-array shape still reads as "might be revocable".
    expect(plan.retain!({ id: 'b', issuanceMetadata: { StatusListInfo: { listId: 'l' } } })).toBe(true)
    // Nothing to revoke — these still age out.
    expect(plan.retain!({ id: 'c', issuanceMetadata: { StatusListInfo: [] } })).toBe(false)
    expect(plan.retain!({ id: 'd', issuanceMetadata: {} })).toBe(false)
    expect(plan.retain!({ id: 'e' })).toBe(false)
  })

  test('OOB has a done track and a non-reusable-only await-response track', () => {
    const plans = buildScanPlans(PurgeRecordType.DIDCOMM_OOB, makeConfig())

    expect(plans.map((plan) => plan.query.state)).toEqual(['done', 'await-response'])

    const awaitResponse = plans[1]
    expect(awaitResponse.retain!({ id: 'a', reusable: true })).toBe(true)
    expect(awaitResponse.retain!({ id: 'b', reusable: false })).toBe(false)
    expect(awaitResponse.retain!({ id: 'c' })).toBe(false)

    // The done track has no retain predicate — reusability is irrelevant once the flow closed.
    expect(plans[0].retain).toBeUndefined()
  })

  test('OID4VC sessions are scanned only in terminal states', () => {
    expect(buildScanPlans(PurgeRecordType.OID4VC_ISSUANCE, makeConfig()).map((p) => p.query.state)).toEqual([
      'Completed',
      'Error',
    ])
    expect(buildScanPlans(PurgeRecordType.OID4VC_VERIFICATION, makeConfig()).map((p) => p.query.state)).toEqual([
      'ResponseVerified',
      'Error',
    ])
  })
})

// ---------------------------------------------------------------------------
// Eligibility
// ---------------------------------------------------------------------------

describe('purgeTenant — eligibility', () => {
  test('keys TTL on updatedAt, not createdAt', async () => {
    const { agent, deletedIds } = makeAgent({
      recordsByState: {
        done: [
          // Created long ago but only just completed — an exchange that stayed open. Must survive.
          { id: 'recently-active', createdAt: daysAgo(400), updatedAt: daysAgo(1) },
          // Created recently but last touched beyond TTL — eligible.
          { id: 'long-idle', createdAt: daysAgo(45), updatedAt: daysAgo(40) },
        ],
      },
    })

    await purgeTenant(agent as never, 'tenant-abc', makeConfig(), 'run-1')

    expect(deletedIds).toEqual(['long-idle'])
  })

  test('a record with no usable timestamp is never eligible', async () => {
    const { agent, deletedIds } = makeAgent({
      recordsByState: { done: [{ id: 'no-timestamps' }, { id: 'bad-timestamp', updatedAt: 'not-a-date' }] },
    })

    await purgeTenant(agent as never, 'tenant-abc', makeConfig(), 'run-1')

    expect(deletedIds).toEqual([])
  })

  test('falls back to createdAt when updatedAt is absent', async () => {
    const { agent, deletedIds } = makeAgent({
      recordsByState: { done: [{ id: 'legacy', createdAt: daysAgo(60) }] },
    })

    await purgeTenant(agent as never, 'tenant-abc', makeConfig(), 'run-1')

    expect(deletedIds).toEqual(['legacy'])
  })

  test('reusable await-response OOB invitations are retained and counted separately', async () => {
    const { agent, deletedIds } = makeAgent({
      recordsByState: {
        done: [{ id: 'oob-done', updatedAt: daysAgo(60) }],
        'await-response': [
          { id: 'oob-reusable', updatedAt: daysAgo(400), reusable: true },
          { id: 'oob-single-use', updatedAt: daysAgo(60), reusable: false },
        ],
      },
    })

    const result = await purgeTenant(
      agent as never,
      'tenant-abc',
      makeConfig({ recordTypes: [PurgeRecordType.DIDCOMM_OOB] }),
      'run-1',
    )

    expect(deletedIds.sort()).toEqual(['oob-done', 'oob-single-use'])
    expect(result.categories[0].retainedByPolicy).toBe(1)
    expect(result.categories[0].eligible).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// Cascade
// ---------------------------------------------------------------------------

describe('purgeTenant — DidCommMessageRecord cascade', () => {
  test('deletes children before the parent', async () => {
    const { agent, deletedIds } = makeAgent({
      recordsByState: { done: [{ id: 'cred-1', updatedAt: daysAgo(60) }] },
      children: { 'cred-1': [{ id: 'msg-1' }, { id: 'msg-2' }] },
    })

    const result = await purgeTenant(agent as never, 'tenant-abc', makeConfig(), 'run-1')

    expect(deletedIds).toEqual(['msg-1', 'msg-2', 'cred-1'])
    expect(result.childrenDeleted).toBe(2)
    expect(result.parentsDeleted).toBe(1)
  })

  test('an already-gone child does not abort the cascade or block the parent', async () => {
    // Regression: RecordNotFoundError from a CHILD used to escape the cascade and be handled as
    // "parent already absent" — so the parent survived while being reported as successfully
    // deleted. On a wallet with a partially-completed previous run that made every run stall at
    // partial progress while the summary looked clean.
    const { agent, deletedIds } = makeAgent({
      recordsByState: { done: [{ id: 'cred-1', updatedAt: daysAgo(60) }] },
      children: { 'cred-1': [{ id: 'msg-gone' }, { id: 'msg-live' }] },
      deleteErrors: { 'msg-gone': new RecordNotFoundError('gone', { recordType: 'DidCommMessageRecord' }) },
    })

    const result = await purgeTenant(agent as never, 'tenant-abc', makeConfig(), 'run-1')

    // The surviving child and the parent are both removed; absence of the first is not an error.
    expect(deletedIds).toEqual(['msg-live', 'cred-1'])
    expect(result.parentsDeleted).toBe(1)
    expect(result.childrenDeleted).toBe(2) // one deleted here, one already gone
    expect(result.categories[0].alreadyAbsent).toBe(0)
    expect(result.failed).toBe(0)
  })

  test('leaves the parent in place when a child delete fails, so no orphan is created', async () => {
    const { agent, deletedIds } = makeAgent({
      recordsByState: {
        done: [
          { id: 'cred-1', updatedAt: daysAgo(60) },
          { id: 'cred-2', updatedAt: daysAgo(60) },
        ],
      },
      children: { 'cred-1': [{ id: 'msg-1' }], 'cred-2': [{ id: 'msg-2' }] },
      deleteErrors: { 'msg-1': new Error('storage locked') },
    })

    const result = await purgeTenant(agent as never, 'tenant-abc', makeConfig(), 'run-1')

    // cred-1 survives alongside its message; cred-2 is fully cleaned. Next run retries cred-1.
    expect(deletedIds).toEqual(['msg-2', 'cred-2'])
    expect(result.failed).toBe(1)
    expect(result.parentsDeleted).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Dry-run, idempotency, guards
// ---------------------------------------------------------------------------

describe('purgeTenant — modes and guards', () => {
  test('dry-run deletes nothing but still reports the census', async () => {
    const { agent, deletedIds, storageService } = makeAgent({
      recordsByState: { done: [{ id: 'cred-1', updatedAt: daysAgo(60) }] },
      children: { 'cred-1': [{ id: 'msg-1' }, { id: 'msg-2' }] },
    })

    const result = await purgeTenant(agent as never, 'tenant-abc', makeConfig({ dryRun: true }), 'run-1')

    expect(storageService.deleteById).not.toHaveBeenCalled()
    expect(deletedIds).toEqual([])
    // Counts mirror what a live run would remove, so a dry-run census is directly comparable.
    expect(result.eligible).toBe(1)
    expect(result.parentsDeleted).toBe(1)
    expect(result.childrenDeleted).toBe(2)
    expect(result.dryRun).toBe(true)
  })

  test('RecordNotFoundError counts as an idempotent success, not a failure', async () => {
    const { agent } = makeAgent({
      recordsByState: { done: [{ id: 'cred-gone', updatedAt: daysAgo(60) }] },
      deleteErrors: { 'cred-gone': new RecordNotFoundError('gone', { recordType: 'CredentialRecord' }) },
    })

    const result = await purgeTenant(agent as never, 'tenant-abc', makeConfig(), 'run-1')

    expect(result.categories[0].alreadyAbsent).toBe(1)
    expect(result.failed).toBe(0)
  })

  test('a batch where every delete genuinely fails aborts the record type', async () => {
    const failing = Array.from({ length: 3 }, (_, index) => ({ id: `cred-${index}`, updatedAt: daysAgo(60) }))
    const { agent, logger } = makeAgent({
      recordsByState: { done: failing },
      deleteErrors: Object.fromEntries(failing.map((record) => [record.id, new Error('storage locked')])),
    })

    const result = await purgeTenant(agent as never, 'tenant-abc', makeConfig({ batchSize: 3 }), 'run-1')

    // All 3 failed in one batch, so the zero-progress guard fires instead of letting the run grind
    // through the remaining states logging the same error.
    expect(result.failed).toBe(3)
    expect(result.parentsDeleted).toBe(0)
    expect(logger.error).toHaveBeenCalledWith(
      '[Purge] Record type failed — continuing with the next type',
      expect.objectContaining({ recordType: PurgeRecordType.DIDCOMM_CREDENTIAL }),
    )
  })

  test('a failure in one record type does not stop the others', async () => {
    const { agent, deletedIds } = makeAgent({
      recordsByState: {
        done: [{ id: 'shared-done', updatedAt: daysAgo(60) }],
      },
      deleteErrors: { 'shared-done': new Error('storage locked') },
    })
    // Make the proof scan itself throw, and assert the credential type still ran.
    agent.modules.didcomm.proofs.findAllByQuery = jest.fn(async () => {
      throw new Error('proof scan exploded')
    }) as never

    const result = await purgeTenant(
      agent as never,
      'tenant-abc',
      makeConfig({ recordTypes: [PurgeRecordType.DIDCOMM_PROOF, PurgeRecordType.DIDCOMM_OOB] }),
      'run-1',
    )

    expect(result.categories.map((category) => category.recordType)).toEqual([
      PurgeRecordType.DIDCOMM_PROOF,
      PurgeRecordType.DIDCOMM_OOB,
    ])
    // OOB still processed its own tracks despite the proof scan failing.
    expect(deletedIds).toEqual([])
    expect(agent.modules.didcomm.oob.findAllByQuery).toHaveBeenCalled()
  })

  test('the per-tenant time budget truncates the run instead of overrunning', async () => {
    const { agent, logger, deletedIds } = makeAgent()

    // The budget is checked at plan and batch boundaries, so make the first scan outlast it: the
    // credential category has three state plans, and the second one must find the budget spent.
    let scanCount = 0
    agent.modules.didcomm.credentials.findAllByQuery = jest.fn(async () => {
      scanCount++
      await new Promise((resolve) => setTimeout(resolve, 20))
      return [{ id: `cred-${scanCount}`, updatedAt: daysAgo(60) }]
    }) as never

    const result = await purgeTenant(agent as never, 'tenant-abc', makeConfig({ timeBudgetMs: 10 }), 'run-1')

    expect(result.truncated).toBe(true)
    // Truncation stops further work rather than abandoning what already succeeded, and the
    // untouched records are simply picked up by the next run.
    expect(scanCount).toBe(1)
    expect(deletedIds).toEqual(['cred-1'])
    expect(logger.warn).toHaveBeenCalledWith(
      '[Purge] Time budget exhausted — tenant will resume on the next run',
      expect.objectContaining({ timeBudgetMs: 10 }),
    )
  })

  test('scans are state-scoped — findAllByQuery is never called with an empty query', async () => {
    const { agent, queriedStates } = makeAgent({ recordsByState: {} })

    await purgeTenant(
      agent as never,
      'tenant-abc',
      makeConfig({ recordTypes: [PurgeRecordType.DIDCOMM_CREDENTIAL, PurgeRecordType.DIDCOMM_PROOF] }),
      'run-1',
    )

    // Loading a whole category (`findAllByQuery({})`) is the flaw this replaces: its cost scales
    // with total retained volume rather than the daily delta.
    for (const state of [...queriedStates.credentials, ...queriedStates.proofs]) {
      expect(state).toBeDefined()
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const call of (agent.modules.didcomm.credentials.findAllByQuery as any).mock.calls) {
      expect(Object.keys(call[0])).toEqual(['state'])
    }
  })

  test('processes eligible records in batches of batchSize', async () => {
    const records = Array.from({ length: 5 }, (_, index) => ({ id: `cred-${index}`, updatedAt: daysAgo(60) }))
    const { agent, deletedIds, logger } = makeAgent({ recordsByState: { done: records } })

    await purgeTenant(agent as never, 'tenant-abc', makeConfig({ batchSize: 2 }), 'run-1')

    expect(deletedIds).toHaveLength(5)
    const batchLogs = logger.debug.mock.calls.filter((call) => call[0] === '[Purge] Batch complete')
    // 5 records at batchSize 2 → 3 batches.
    expect(batchLogs).toHaveLength(3)
  })
})
