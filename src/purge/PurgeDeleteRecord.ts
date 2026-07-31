import type { PurgeRecordType } from './PurgeTypes'
import type { Agent, BaseRecord, BaseRecordConstructor, StorageService } from '@credo-ts/core'

import { InjectionSymbols } from '@credo-ts/core'
import {
  DidCommCredentialExchangeRecord,
  DidCommMessageRecord,
  DidCommOutOfBandRecord,
  DidCommProofExchangeRecord,
} from '@credo-ts/didcomm'
import { OpenId4VcIssuanceSessionRepository, OpenId4VcVerificationSessionRepository } from '@credo-ts/openid4vc'

import { PurgeRecordType as RecordType } from './PurgeTypes'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRecord = BaseRecord<any, any, any>

/**
 * The exchange record classes deleted at the STORAGE layer.
 *
 * Why storage-level and not `agent.modules.didcomm.credentials.deleteById(id)`:
 * `DidCommBaseCredentialProtocol.delete()` defaults `deleteAssociatedCredentials` to `true`, so the
 * protocol-level delete also destroys the stored `W3cCredentialRecord` / `AnonCredsCredentialRecord`
 * the exchange produced. For a holder cloud wallet that is data loss — the holder loses the actual
 * credential, not just the (already-completed) exchange bookkeeping. Going through the
 * `StorageService` deletes the parent exchange record and nothing else.
 *
 * This mirrors `credo-data-purge`'s "bypass the protocol layer entirely" decision
 * (INTEGRATION-PLAN-develop.md §4.1) and is covered by `__tests__/PurgeDeleteRecord.spec.ts`.
 *
 * DIDComm message children are NOT cascaded by the storage layer, so the purge engine removes them
 * explicitly per parent before deleting the parent — see `deleteDidCommMessageChildren`.
 */
const STORAGE_LEVEL_RECORD_CLASSES: Partial<Record<PurgeRecordType, BaseRecordConstructor<AnyRecord>>> = {
  [RecordType.DIDCOMM_CREDENTIAL]: DidCommCredentialExchangeRecord as BaseRecordConstructor<AnyRecord>,
  [RecordType.DIDCOMM_PROOF]: DidCommProofExchangeRecord as BaseRecordConstructor<AnyRecord>,
  [RecordType.DIDCOMM_OOB]: DidCommOutOfBandRecord as BaseRecordConstructor<AnyRecord>,
}

/**
 * Record types that own `DidCommMessageRecord` children (linked by the `associatedRecordId` tag).
 *
 * Only the credential and proof protocols associate stored DIDComm messages with an exchange
 * record. OOB records carry their invitation inline, and the OID4VC sessions are not DIDComm at
 * all — so neither needs the extra child query per record.
 */
export const RECORD_TYPES_WITH_DIDCOMM_MESSAGE_CHILDREN: ReadonlySet<PurgeRecordType> = new Set([
  RecordType.DIDCOMM_CREDENTIAL,
  RecordType.DIDCOMM_PROOF,
])

export function resolveStorageService(agent: Agent): StorageService<AnyRecord> {
  return agent.dependencyManager.resolve<StorageService<AnyRecord>>(InjectionSymbols.StorageService)
}

/** IDs of the `DidCommMessageRecord`s associated with an exchange record. */
export async function findDidCommMessageChildIds(agent: Agent, parentRecordId: string): Promise<string[]> {
  const storageService = resolveStorageService(agent)
  const messages = await storageService.findByQuery(agent.context, DidCommMessageRecord, {
    associatedRecordId: parentRecordId,
  })
  return messages.map((message) => message.id)
}

/**
 * Delete the `DidCommMessageRecord` children of an exchange record.
 *
 * Callers must run this to completion BEFORE deleting the parent: the storage-level parent delete
 * no longer cascades, so a parent removed while a child delete is still outstanding leaves an
 * orphaned message that only a full-wallet orphan sweep can find. The steady-state job deliberately
 * does not run that sweep (INTEGRATION-PLAN-develop.md §8), so this per-parent cascade is the only
 * thing keeping orphans from accumulating — and that only holds if the ordering is respected.
 */
export async function deleteDidCommMessageChildren(agent: Agent, childIds: string[]): Promise<void> {
  const storageService = resolveStorageService(agent)
  for (const childId of childIds) {
    await storageService.deleteById(agent.context, DidCommMessageRecord, childId)
  }
}

/**
 * Delete a single purgeable record — the parent record ONLY.
 *
 * @throws {RecordNotFoundError} if the record is already gone. Callers treat this as an idempotent
 * success: for a delete, "already absent" is the desired end state.
 */
export async function deletePurgeRecord(agent: Agent, recordType: PurgeRecordType, recordId: string): Promise<void> {
  const recordClass = STORAGE_LEVEL_RECORD_CLASSES[recordType]
  if (recordClass) {
    await resolveStorageService(agent).deleteById(agent.context, recordClass, recordId)
    return
  }

  switch (recordType) {
    // The OID4VC repositories are already parent-only — no protocol cascade to bypass.
    case RecordType.OID4VC_ISSUANCE: {
      const repo = agent.dependencyManager.resolve(OpenId4VcIssuanceSessionRepository)
      await repo.deleteById(agent.context, recordId)
      break
    }

    case RecordType.OID4VC_VERIFICATION: {
      const repo = agent.dependencyManager.resolve(OpenId4VcVerificationSessionRepository)
      await repo.deleteById(agent.context, recordId)
      break
    }

    default: {
      const _exhaustive: never = recordType as never
      throw new Error(`[Purge] Unhandled record type: ${_exhaustive}`)
    }
  }
}
