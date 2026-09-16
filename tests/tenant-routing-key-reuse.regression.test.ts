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
 * Fix v2 (this version): insert-first instead of check-then-insert. addTenantRoutingRecord now
 * gives the record a deterministic id (the recipient key's fingerprint) instead of a random uuid,
 * so a concurrent or repeat registration of the same key collides atomically at the storage layer
 * (Askar's insert is atomic per category+id) and surfaces as RecordDuplicateError, which
 * ensureRoutingKeyRegistered catches and resolves by fetching the (now guaranteed-to-exist) record
 * - the same id-collision-as-guard idiom MediatorService.createMediatorRoutingRecord already uses
 * for MEDIATOR_ROUTING_RECORD_ID.
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

// Mirrors the real (patched) TenantRecordService.addTenantRoutingRecord + storage backend: an
// in-memory map keyed by recipientKeyFingerprint (standing in for the deterministic record id),
// with Askar's atomic-insert-collides-on-duplicate-id behavior.
const makeFakeTenantRecordService = () => {
  const recordsByFingerprint = new Map<string, { tenantId: string; recipientKeyFingerprint: string }>()
  let addCallCount = 0
  return {
    addCallCount: () => addCallCount,
    tenantRecordService: {
      findTenantRoutingRecordByRecipientKey: async (_ctx: any, recipientKey: any) =>
        recordsByFingerprint.get(recipientKey.fingerprint) ?? null,
      addTenantRoutingRecord: async (_ctx: any, tenantId: string, recipientKey: any) => {
        addCallCount++
        if (recordsByFingerprint.has(recipientKey.fingerprint)) {
          throw new RecordDuplicateError(`Record with id ${recipientKey.fingerprint} already exists`, {
            recordType: 'TenantRoutingRecord',
          })
        }
        const record = { tenantId, recipientKeyFingerprint: recipientKey.fingerprint }
        recordsByFingerprint.set(recipientKey.fingerprint, record)
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

    expect(result).toEqual({ tenantId: 'tenant-a', recipientKeyFingerprint: 'fp-existing' })
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
