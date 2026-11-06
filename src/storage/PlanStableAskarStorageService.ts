import type { AgentContext, BaseRecord, BaseRecordConstructor, Query, QueryOptions } from '@credo-ts/core'

import { AskarStorageService, AskarStoreManager } from '@credo-ts/askar'
import { inject, injectable } from '@credo-ts/core'

import { planTagQuery } from './tagQueryPlan'

/**
 * Askar storage whose tag searches PostgreSQL can answer from the tag index on large wallets: OR
 * queries run as a union of indexed AND lookups, and AND queries lead with their most selective
 * tag. See `tagQueryPlan.ts` and docs/wallet-tag-query-plans.md.
 *
 * Results are the records the stock service returns. Where that cannot be guaranteed the original
 * query runs instead:
 * - `offset` or `orderBy`: a page of a union cannot be cut without Askar's internal row order.
 * - more distinct matches than `limit`: the stock query might return a different subset.
 * Without `orderBy` Askar applies no ORDER BY, so the order of an unpaged result was never defined.
 *
 * Each union branch is its own statement, run one after another, so the union is not one snapshot:
 * a record that changes between branch statements from matching only a later branch to matching only
 * an earlier one is missed by that call. The tag changes Credo makes (a DID rotation moving a DID
 * into `previousDids`, for one) go the other way, from earlier branches to later ones, and the
 * union then finds the record. Repository callers already read across statements.
 */
@injectable()
export class PlanStableAskarStorageService<T extends BaseRecord> extends AskarStorageService<T> {
  public constructor(@inject(AskarStoreManager) askarStoreManager: AskarStoreManager) {
    super(askarStoreManager)
  }

  public override async findByQuery(
    agentContext: AgentContext,
    recordClass: BaseRecordConstructor<T>,
    query: Query<T>,
    queryOptions?: QueryOptions,
  ): Promise<T[]> {
    const plan = planTagQuery(query)
    if (!plan) return super.findByQuery(agentContext, recordClass, query, queryOptions)
    if (plan.kind === 'single') return super.findByQuery(agentContext, recordClass, plan.query, queryOptions)

    if ((queryOptions?.offset !== undefined && queryOptions.offset !== 0) || queryOptions?.orderBy !== undefined) {
      return super.findByQuery(agentContext, recordClass, query, queryOptions)
    }
    const limit = queryOptions?.limit
    const branchOptions = limit === undefined ? undefined : { limit }
    const records = new Map<string, T>()
    for (const branch of plan.branches) {
      for (const record of await super.findByQuery(agentContext, recordClass, branch, branchOptions)) {
        if (!records.has(record.id)) records.set(record.id, record)
      }
      // Already past the limit: which records the stock query returns is unknown, so let it decide.
      if (limit !== undefined && records.size > limit) {
        return super.findByQuery(agentContext, recordClass, query, queryOptions)
      }
    }
    return [...records.values()]
  }
}
