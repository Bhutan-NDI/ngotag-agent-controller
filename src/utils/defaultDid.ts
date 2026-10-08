import type { AgentContext, DidRecord } from '@credo-ts/core'
import type { DidRepository } from '@credo-ts/core'

// Shared by AgentController's self-attested lookup and DidController.getDids so both agree on
// which DID is default. No ordering guarantee from Askar, so sort by createdAt descending.
export async function findDefaultDidRecords(didRepository: DidRepository, context: AgentContext): Promise<DidRecord[]> {
  return (await didRepository.findByQuery(context, { isDefault: true })).sort(
    (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
  )
}
