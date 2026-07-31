import type { PurgeRecordType } from './PurgeTypes'
import type { Agent } from '@credo-ts/core'

import { RecordNotFoundError } from '@credo-ts/core'
import {
  DidCommCredentialExchangeRepository,
  DidCommMessageRepository,
  DidCommProofExchangeRepository,
} from '@credo-ts/didcomm'
import { OpenId4VcIssuanceSessionRepository, OpenId4VcVerificationSessionRepository } from '@credo-ts/openid4vc'

import { PurgeRecordType as RecordType } from './PurgeTypes'

/**
 * Deletion is performed at the REPOSITORY layer, never the protocol layer.
 *
 * Why not `agent.modules.didcomm.credentials.deleteById(id)`:
 * `DidCommBaseCredentialProtocol.delete()` defaults `deleteAssociatedCredentials` to `true`, and on
 * this deployment's format-service ordering that resolves to `legacyIndyCredentialFormat` →
 * `AnonCredsRsHolderService.deleteCredential()` → `W3cCredentialRepository.delete()`. For a holder
 * cloud wallet issuing JSON-LD over DIDComm, a routine retention purge would destroy the holder's
 * actual credential. See `__tests__/PurgeDeleteRecord.spec.ts` and INTEGRATION-PLAN-develop.md §4.1.
 *
 * Why the repository rather than the raw `StorageService`: `Repository.deleteById()` is exactly
 * `storageService.deleteById()` plus a `RepositoryEventTypes.RecordDeleted` emit — no extra read, no
 * cascade — so it keeps the credential-safety property while preserving the lifecycle event that
 * every other delete path in Credo produces.
 *
 * OOB is the one exception and goes through its API on purpose — see `deletePurgeRecord`.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRepository = {
  deleteById(agentContext: any, id: string): Promise<void>
  findById(agentContext: any, id: string): Promise<any>
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

function resolveRepository(agent: Agent, recordType: PurgeRecordType): AnyRepository | undefined {
  switch (recordType) {
    case RecordType.DIDCOMM_CREDENTIAL:
      return agent.dependencyManager.resolve(DidCommCredentialExchangeRepository) as unknown as AnyRepository
    case RecordType.DIDCOMM_PROOF:
      return agent.dependencyManager.resolve(DidCommProofExchangeRepository) as unknown as AnyRepository
    case RecordType.OID4VC_ISSUANCE:
      return agent.dependencyManager.resolve(OpenId4VcIssuanceSessionRepository) as unknown as AnyRepository
    case RecordType.OID4VC_VERIFICATION:
      return agent.dependencyManager.resolve(OpenId4VcVerificationSessionRepository) as unknown as AnyRepository
    // OOB has no repository branch — it must go through the API for the routing cleanup.
    default:
      return undefined
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function oobApi(agent: Agent): any {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (agent as any).modules.didcomm.oob
}

/** IDs of the `DidCommMessageRecord`s associated with an exchange record. */
export async function findDidCommMessageChildIds(agent: Agent, parentRecordId: string): Promise<string[]> {
  const repository = agent.dependencyManager.resolve(DidCommMessageRepository)
  const messages = await repository.findByQuery(agent.context, { associatedRecordId: parentRecordId })
  return messages.map((message) => message.id)
}

/**
 * Delete the `DidCommMessageRecord` children of an exchange record.
 *
 * Callers must run this to completion BEFORE deleting the parent: the parent delete no longer
 * cascades, so a parent removed while a child delete is still outstanding leaves an orphaned message
 * that only a full-wallet orphan sweep can find. The steady-state job deliberately does not run that
 * sweep (INTEGRATION-PLAN-develop.md §8), so this per-parent cascade is the only thing keeping
 * orphans from accumulating — and that only holds if the ordering is respected.
 *
 * A child that is ALREADY gone is skipped rather than treated as an error: for a delete, "absent" is
 * the desired end state. Letting `RecordNotFoundError` escape here would abort the cascade and, via
 * the caller's error handling, leave the parent undeleted while reporting the record as successfully
 * already-absent.
 *
 * @returns the number of children that are no longer present (deleted here or already gone).
 */
export async function deleteDidCommMessageChildren(agent: Agent, childIds: string[]): Promise<number> {
  const repository = agent.dependencyManager.resolve(DidCommMessageRepository)
  let removed = 0
  for (const childId of childIds) {
    try {
      await repository.deleteById(agent.context, childId)
    } catch (error) {
      // Real failures (lock, I/O) still propagate, so the parent is not deleted and is retried.
      if (!(error instanceof RecordNotFoundError)) throw error
    }
    removed++
  }
  return removed
}

/**
 * Re-read a record immediately before deleting it, so eligibility is decided on its CURRENT state
 * rather than on the snapshot taken when the page was scanned.
 *
 * @returns the record, or undefined if it no longer exists.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function findPurgeRecordById(agent: Agent, recordType: PurgeRecordType, id: string): Promise<any> {
  if (recordType === RecordType.DIDCOMM_OOB) return oobApi(agent).findById(id)

  const repository = resolveRepository(agent, recordType)
  if (!repository) throw new Error(`[Purge] No repository for record type: ${recordType}`)
  return repository.findById(agent.context, id)
}

/**
 * Delete a single purgeable record — the parent record ONLY.
 *
 * @throws {RecordNotFoundError} if the record is already gone. Callers treat this as an idempotent
 * success: for a delete, "already absent" is the desired end state.
 */
export async function deletePurgeRecord(agent: Agent, recordType: PurgeRecordType, recordId: string): Promise<void> {
  if (recordType === RecordType.DIDCOMM_OOB) {
    // OOB deliberately goes through the API rather than the repository. `DidCommOutOfBandApi
    // .deleteById()` deregisters the invitation's recipient keys from the mediator first, when the
    // record has a `mediatorId`, carries only inline services, and has no related connection (or is
    // reusable). The 7-day `await-response` non-reusable track is exactly that "no related
    // connection" case, and `create-request-oob` routes through `mediationRecipient.getRouting()`,
    // so every purged invitation would otherwise leave its recipient keys registered at the mediator
    // forever. Unlike the credential API, this one cascades nothing else — the hazard that forces
    // credentials off the protocol layer simply does not exist here.
    await oobApi(agent).deleteById(recordId)
    return
  }

  const repository = resolveRepository(agent, recordType)
  if (!repository) {
    throw new Error(`[Purge] Unhandled record type: ${recordType}`)
  }
  await repository.deleteById(agent.context, recordId)
}
