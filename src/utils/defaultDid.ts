import type { AgentContext, DidRecord } from '@credo-ts/core'
import type { DidRepository } from '@credo-ts/core'

// Shared by AgentController.createW3cSelfAttestedCredential (issuing with the wallet's default
// DID) and DidController.getDids (GET /dids?isDefault=true) -- both read the same isDefault tag
// on a DID's own DidRecord (see DidController.writeDid), and must resolve it the same way or the
// two endpoints can disagree about which DID is default. findByQuery applies no ordering of its
// own (a plain Askar scan), and a wallet migrated from the legacy stack can carry more than one
// isDefault-tagged DID (from before DidController.writeDid started clearing the previous default
// on every write) -- sorting by createdAt descending makes the pick deterministic and favors the
// most recently tagged DID over a stale, superseded one. See the #73/#75 reviews.
export async function findDefaultDidRecords(didRepository: DidRepository, context: AgentContext): Promise<DidRecord[]> {
  return (await didRepository.findByQuery(context, { isDefault: true })).sort(
    (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
  )
}
