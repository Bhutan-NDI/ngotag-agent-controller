/**
 * Regression test — reused recipient key bypasses routing-key registration entirely
 * (PR #94 review by @kinxa0, plus a concurrency follow-up caught by /code-review).
 *
 * Root cause: MultiTenancyController.createLegacyInvitation hand-builds `routing` when the
 * caller supplies `config.recipientKey` (used to reuse an existing connection's key in a new
 * invitation, e.g. the "reuse connection" feature), instead of calling
 * tenantAgent.mediationRecipient.getRouting({}). That bypasses RoutingCreatedEvent entirely, so
 * this key's TenantRoutingRecord may never exist - not late, never - regardless of the
 * emitAsync/onAsync race fix, which only helps keys created via getRouting(). Every inbound
 * message encrypted to such a key fails with "Couldn't determine tenant id for inbound message"
 * on every attempt, not just a raced first attempt.
 *
 * Fix v1: TenantsApi.ensureRoutingKeyRegistered({ tenantId, recipientKey }), called by
 * MultiTenancyController before the invitation referencing that key is returned. v1 checked for
 * an existing TenantRoutingRecord first and only inserted if none was found - a TOCTOU race
 * /code-review then caught: two concurrent calls for the same key (e.g. a client retry) could
 * both see "not found" and both insert, creating two records with the same recipientKeyFingerprint.
 * findTenantRoutingRecordByRecipientKey (used on every inbound message) throws RecordDuplicateError
 * as soon as more than one record matches - permanently breaking that key, via a different
 * mechanism than the original bug but with the same symptom.
 *
 * Fix v2: insert-first instead of check-then-insert. addTenantRoutingRecord now gives the record a
 * deterministic id (the recipient key's fingerprint) instead of a random uuid, so a concurrent or
 * repeat registration of the same key collides atomically at the storage layer (Askar's insert is
 * atomic per category+id) and surfaces as RecordDuplicateError, which ensureRoutingKeyRegistered
 * catches and resolves by fetching the (now guaranteed-to-exist) record - the same
 * id-collision-as-guard idiom MediatorService.createMediatorRoutingRecord already uses for
 * MEDIATOR_ROUTING_RECORD_ID.
 *
 * Fix v3 (this version) - @devdgna review follow-up: v2's insert-first approach only collides
 * correctly for keys registered *after* the deterministic-id change. A TenantRoutingRecord created
 * before it has a random uuid id, not a fingerprint id, so inserting a fingerprint-id record for a
 * key that already has a uuid-id record does NOT collide - it succeeds, leaving two records tagged
 * with the same recipientKeyFingerprint. findTenantRoutingRecordByRecipientKey then throws
 * RecordDuplicateError on every subsequent inbound message for that key, breaking a
 * previously-working key. The cross-tenant ownership check was also silently skipped for legacy
 * records, since it only ran inside the duplicate-id catch block, which a uuid-id record never
 * triggers. Fixed by querying by recipientKeyFingerprint *before* inserting - same-tenant match
 * short-circuits to the existing record (uuid-id or fingerprint-id, doesn't matter), a
 * different-tenant match is rejected immediately, and the deterministic-id insert + duplicate
 * recovery is retained purely for the concurrent-brand-new-key race that v2 was written for.
 *
 * These tests exercise the REAL vendored TenantsApi.ensureRoutingKeyRegistered.
 */
import 'reflect-metadata'
import * as fs from 'fs'
import * as path from 'path'
// eslint-disable-next-line @typescript-eslint/no-var-requires
import { TenantsApi } from '@credo-ts/tenants/build/TenantsApi'
// eslint-disable-next-line @typescript-eslint/no-var-requires
import { RecordDuplicateError } from '@credo-ts/core'

const readSource = (relativePath: string): string => fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8')

const logger: any = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, trace: () => {} }
const fakeRootAgentContext: any = { contextCorrelationId: 'root' }
const fakeAgentContextProvider: any = {}

const fakeRecipientKey = (fingerprint: string): any => ({ fingerprint })

// Mirrors the real (patched) TenantRecordService.addTenantRoutingRecord + storage backend: records
// are keyed by `id` (Askar's atomic-insert-collides-on-duplicate-id behavior applies to `id`, not
// to the recipientKeyFingerprint tag), and addTenantRoutingRecord always inserts using the
// recipient key's fingerprint as the id - matching the deterministic-id fix. seedLegacyRecord lets
// a test plant a record with a random uuid id (as every TenantRoutingRecord had before that fix),
// to exercise the case where the id and the fingerprint tag are NOT the same value.
const makeFakeTenantRecordService = () => {
  const recordsById = new Map<string, { id: string; tenantId: string; recipientKeyFingerprint: string }>()
  let addCallCount = 0
  return {
    addCallCount: () => addCallCount,
    recordCountForFingerprint: (fingerprint: string) =>
      [...recordsById.values()].filter((record) => record.recipientKeyFingerprint === fingerprint).length,
    seedLegacyRecord: (record: { id: string; tenantId: string; recipientKeyFingerprint: string }) => {
      recordsById.set(record.id, record)
    },
    tenantRecordService: {
      findTenantRoutingRecordByRecipientKey: async (_ctx: any, recipientKey: any) =>
        [...recordsById.values()].find((record) => record.recipientKeyFingerprint === recipientKey.fingerprint) ??
        null,
      addTenantRoutingRecord: async (_ctx: any, tenantId: string, recipientKey: any) => {
        addCallCount++
        const id = recipientKey.fingerprint
        if (recordsById.has(id)) {
          throw new RecordDuplicateError(`Record with id ${id} already exists`, {
            recordType: 'TenantRoutingRecord',
          })
        }
        const record = { id, tenantId, recipientKeyFingerprint: recipientKey.fingerprint }
        recordsById.set(id, record)
        return record
      },
    },
  }
}

describe('TenantsApi.ensureRoutingKeyRegistered — reused-key registration regression', () => {
  it('registers a key that has never been seen before', async () => {
    const { tenantRecordService, addCallCount } = makeFakeTenantRecordService()
    const api = new (TenantsApi as any)(tenantRecordService, fakeRootAgentContext, fakeAgentContextProvider, logger)

    const result = await api.ensureRoutingKeyRegistered({ tenantId: 'tenant-a', recipientKey: fakeRecipientKey('fp-new') })

    expect(addCallCount()).toBe(1)
    expect(result.tenantId).toBe('tenant-a')
  })

  it('is idempotent: an already-registered key for the same tenant resolves to the existing record', async () => {
    const { tenantRecordService } = makeFakeTenantRecordService()
    const api = new (TenantsApi as any)(tenantRecordService, fakeRootAgentContext, fakeAgentContextProvider, logger)
    await api.ensureRoutingKeyRegistered({ tenantId: 'tenant-a', recipientKey: fakeRecipientKey('fp-existing') })

    const result = await api.ensureRoutingKeyRegistered({ tenantId: 'tenant-a', recipientKey: fakeRecipientKey('fp-existing') })

    expect(result).toEqual({ id: 'fp-existing', tenantId: 'tenant-a', recipientKeyFingerprint: 'fp-existing' })
  })

  it('refuses to silently reassign a key already registered to a different tenant', async () => {
    const { tenantRecordService } = makeFakeTenantRecordService()
    const api = new (TenantsApi as any)(tenantRecordService, fakeRootAgentContext, fakeAgentContextProvider, logger)
    await api.ensureRoutingKeyRegistered({ tenantId: 'tenant-b', recipientKey: fakeRecipientKey('fp-cross-tenant') })

    await expect(
      api.ensureRoutingKeyRegistered({ tenantId: 'tenant-a', recipientKey: fakeRecipientKey('fp-cross-tenant') })
    ).rejects.toThrow(/already registered to a different tenant/)
  })

  it('concurrency regression: two simultaneous registrations of the same brand-new key never create two records', async () => {
    const { tenantRecordService, addCallCount } = makeFakeTenantRecordService()
    const api = new (TenantsApi as any)(tenantRecordService, fakeRootAgentContext, fakeAgentContextProvider, logger)

    // Both calls race past the point where a check-then-insert implementation would have already
    // read "not found" for both. With insert-first + deterministic ids, the storage layer itself
    // is the arbiter: whichever call's addTenantRoutingRecord actually runs first wins, the other
    // gets RecordDuplicateError and falls back to reading the winner's record.
    const [first, second] = await Promise.all([
      api.ensureRoutingKeyRegistered({ tenantId: 'tenant-a', recipientKey: fakeRecipientKey('fp-race') }),
      api.ensureRoutingKeyRegistered({ tenantId: 'tenant-a', recipientKey: fakeRecipientKey('fp-race') }),
    ])

    expect(addCallCount()).toBe(2) // both attempted the insert
    expect(first).toEqual(second) // but only one record exists, and both calls agree on it
    expect(first.tenantId).toBe('tenant-a')
  })

  it('does not swallow a genuine RecordDuplicateError with no findable record behind it', async () => {
    const tenantRecordService: any = {
      findTenantRoutingRecordByRecipientKey: async () => null,
      addTenantRoutingRecord: async () => {
        throw new RecordDuplicateError('unexpected', { recordType: 'TenantRoutingRecord' })
      },
    }
    const api = new (TenantsApi as any)(tenantRecordService, fakeRootAgentContext, fakeAgentContextProvider, logger)

    await expect(
      api.ensureRoutingKeyRegistered({ tenantId: 'tenant-a', recipientKey: fakeRecipientKey('fp-inconsistent') })
    ).rejects.toThrow(RecordDuplicateError)
  })

  it('@devdgna regression: recognizes a pre-change uuid-id record for the same tenant instead of inserting a duplicate', async () => {
    const { tenantRecordService, seedLegacyRecord, addCallCount, recordCountForFingerprint } =
      makeFakeTenantRecordService()
    // A TenantRoutingRecord created before the deterministic-id fix - random uuid id, id !== fingerprint.
    seedLegacyRecord({ id: 'legacy-uuid-1234', tenantId: 'tenant-a', recipientKeyFingerprint: 'fp-legacy-same-tenant' })
    const api = new (TenantsApi as any)(tenantRecordService, fakeRootAgentContext, fakeAgentContextProvider, logger)

    const result = await api.ensureRoutingKeyRegistered({
      tenantId: 'tenant-a',
      recipientKey: fakeRecipientKey('fp-legacy-same-tenant'),
    })

    expect(result).toEqual({ id: 'legacy-uuid-1234', tenantId: 'tenant-a', recipientKeyFingerprint: 'fp-legacy-same-tenant' })
    // Must resolve via the fingerprint lookup, not attempt a fingerprint-id insert - an insert-first
    // approach would succeed here (different id, no collision) and create a second record.
    expect(addCallCount()).toBe(0)
    expect(recordCountForFingerprint('fp-legacy-same-tenant')).toBe(1)
  })

  it('@devdgna regression: rejects a pre-change uuid-id record registered to a different tenant', async () => {
    const { tenantRecordService, seedLegacyRecord, addCallCount } = makeFakeTenantRecordService()
    seedLegacyRecord({ id: 'legacy-uuid-5678', tenantId: 'tenant-b', recipientKeyFingerprint: 'fp-legacy-cross-tenant' })
    const api = new (TenantsApi as any)(tenantRecordService, fakeRootAgentContext, fakeAgentContextProvider, logger)

    await expect(
      api.ensureRoutingKeyRegistered({ tenantId: 'tenant-a', recipientKey: fakeRecipientKey('fp-legacy-cross-tenant') })
    ).rejects.toThrow(/already registered to a different tenant/)
    // Must reject on the fingerprint-lookup ownership check - no insert attempt, no new record.
    expect(addCallCount()).toBe(0)
  })
})

describe('MultiTenancyController.createLegacyInvitation — reused-key path stays wired up (source guard)', () => {
  it('calls ensureRoutingKeyRegistered when a caller-supplied recipientKey is used', () => {
    const source = readSource('src/controllers/multi-tenancy/MultiTenancyController.ts')
    const recipientKeyBranch = source.slice(
      source.indexOf('public async createLegacyInvitation'),
      source.indexOf('public async createLegacyInvitation') + 1600
    )
    expect(recipientKeyBranch).toMatch(/this\.agent\.modules\.tenants\.ensureRoutingKeyRegistered\(/)
  })
})

describe('TenantRecordService.addTenantRoutingRecord — deterministic id (source guard)', () => {
  it('derives the record id from the recipient key fingerprint, not a random uuid', () => {
    const source = readSource('node_modules/@credo-ts/tenants/build/services/TenantRecordService.js')
    const method = source.slice(source.indexOf('async addTenantRoutingRecord'), source.indexOf('async addTenantRoutingRecord') + 800)
    expect(method).toMatch(/id:\s*recipientKey\.fingerprint/)
  })
})
