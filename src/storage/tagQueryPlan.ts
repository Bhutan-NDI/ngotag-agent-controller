/**
 * Rewrites a Credo storage query so that PostgreSQL can answer it from the wallet's tag index.
 *
 * Askar turns every tag condition into `i.id IN (SELECT item_id FROM items_tags WHERE name = ? AND
 * value = ? ...)`. Two shapes of that SQL are slow on a large wallet profile:
 *
 * - **OR.** `(i.id IN (...) OR i.id IN (...))` cannot become a join, so PostgreSQL reads every item of
 *   the profile (generic plan) or of the category (custom plan) and tests each one: the cost grows
 *   with the tenant's history although the answer is one record. The union of the AND branches is
 *   the same set, and each branch is an index lookup.
 * - **AND led by a common tag.** Askar emits the conditions of a query object in sorted key order,
 *   and a cached generic plan cannot tell which value is selective, so it walks the first
 *   condition's index range. For `{ threadId, role }`, `role` sorts first and the lookup scans every
 *   exchange with that role. An `$and` array keeps its order, so the lookup can lead with `threadId`.
 *
 * The planned queries match exactly the records the original matches, including Askar's handling
 * of absent values (`undefined`, `null`, `[]`) and of empty `$and` / `$or` arrays (all ignored).
 * A shape the planner does not handle is left alone: `planTagQuery` returns undefined.
 */
import type { BaseRecord, Query } from '@credo-ts/core'

/** Above this many OR branches the original single query runs. Credo's hot paths need at most 3. */
export const MAX_OR_BRANCHES = 8

/**
 * Tags whose value is shared by many records of a wallet: enumerations (roles, states, protocol
 * identifiers). They lead a lookup only when nothing better is available.
 */
export const LOW_SELECTIVITY_TAGS: ReadonlySet<string> = new Set([
  'role',
  'state',
  'method',
  'protocolName',
  'messageName',
  'protocolMajorVersion',
  'protocolMinorVersion',
  'messageType',
  'protocolVersion',
  'connectionTypes',
  'autoAcceptConnection',
  'isDefault',
  'default',
  'type',
])

/**
 * Identifiers that group records: one connection, invitation, tenant or credential definition can
 * own thousands of them. They lead a lookup only when no unique identifier is present.
 */
export const GROUPING_TAGS: ReadonlySet<string> = new Set([
  'connectionId',
  'outOfBandId',
  'parentThreadId',
  'mediatorId',
  'tenantId',
  'credentialDefinitionId',
  'unqualifiedCredentialDefinitionId',
  'schemaId',
  'unqualifiedSchemaId',
  'schemaIssuerId',
  'schemaName',
  'schemaVersion',
  'issuerId',
  'revocationRegistryId',
])

type AnyQuery = Record<string, unknown>
type TagCondition = { kind: 'tag'; key: string; value: unknown }
type OperatorCondition = { kind: 'operator'; key: string; query: AnyQuery }
/** One condition of a conjunction: a tag equality, or an operator (`$not`, ...) kept as written. */
type Condition = TagCondition | OperatorCondition

export type TagQueryPlan<T extends BaseRecord> =
  /** One query matching the same records as the original, with a selective tag leading. */
  | { kind: 'single'; query: Query<T> }
  /** AND-only queries whose union is the set of records the original matches. */
  | { kind: 'union'; branches: Query<T>[] }

const isPlainObject = (value: unknown): value is AnyQuery =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * Values Askar never sees: JSON drops undefined, Credo maps null to undefined, and an empty array
 * produces no `key:item` tag.
 */
const isAbsent = (value: unknown) =>
  value === undefined || value === null || (Array.isArray(value) && value.length === 0)

/**
 * The conjunctions whose union matches the same records as `query` (disjunctive normal form), or
 * undefined for a shape this planner does not rewrite or that would expand past MAX_OR_BRANCHES.
 */
function toConjunctions(query: unknown): Condition[][] | undefined {
  if (!isPlainObject(query)) return undefined
  let branches: Condition[][] = [[]]
  const cross = (alternatives: Condition[][]) => {
    if (branches.length * alternatives.length > MAX_OR_BRANCHES) return false
    branches = branches.flatMap((branch) => alternatives.map((alternative) => [...branch, ...alternative]))
    return true
  }
  for (const key of Object.keys(query)) {
    const value = query[key]
    if (isAbsent(value)) continue
    if (key === '$and' || key === '$or') {
      if (!Array.isArray(value)) return undefined
      const parts: Condition[][][] = []
      for (const part of value) {
        const conjunctions = toConjunctions(part)
        if (!conjunctions) return undefined
        parts.push(conjunctions)
      }
      if (key === '$or') {
        if (!cross(parts.flat())) return undefined
      } else {
        for (const conjunctions of parts) if (!cross(conjunctions)) return undefined
      }
    } else if (key.startsWith('$')) {
      // $not and any other operator: one more condition of the conjunction, kept as written.
      branches = branches.map((branch) => [...branch, { kind: 'operator', key, query: { [key]: value } }])
    } else {
      branches = branches.map((branch) => [...branch, { kind: 'tag', key, value }])
    }
  }
  return branches
}

/** The tag names Askar writes for a condition: arrays become one `key:item` tag per item. */
const askarTagNames = (condition: TagCondition): string[] =>
  Array.isArray(condition.value) ? condition.value.map((item) => `${condition.key}:${item}`).sort() : [condition.key]

const sortName = (condition: Condition) => (condition.kind === 'tag' ? askarTagNames(condition)[0] : condition.key)

/** 0 = unique identifier, 1 = grouping identifier, 2 = enumeration or non-equality, 3 = operator. */
function rank(condition: Condition): number {
  if (condition.kind === 'operator') return 3
  if (LOW_SELECTIVITY_TAGS.has(condition.key) || typeof condition.value === 'boolean' || isPlainObject(condition.value))
    return 2
  if (GROUPING_TAGS.has(condition.key)) return 1
  return 0
}

/** Most selective first; Askar's sorted name order within a rank, so the result is deterministic. */
function lookupOrder(conditions: Condition[]): Condition[] {
  return [...conditions].sort((a, b) => {
    const byRank = rank(a) - rank(b)
    if (byRank !== 0) return byRank
    const [left, right] = [sortName(a), sortName(b)]
    return left < right ? -1 : left > right ? 1 : 0
  })
}

/** The query object for one conjunction: an `$and` array, which Askar evaluates in order. */
function conjunctionQuery<T extends BaseRecord>(conditions: Condition[]): Query<T> {
  const parts = conditions.map((condition) =>
    condition.kind === 'tag' ? { [condition.key]: condition.value } : condition.query,
  )
  return (parts.length === 1 ? parts[0] : { $and: parts }) as Query<T>
}

/**
 * Whether Askar would already lead with the best condition: only decidable for a flat object, whose
 * conditions Askar emits sorted by tag name (operators sort first, `$` < letters).
 */
function askarAlreadyLeadsWell(query: AnyQuery, conditions: Condition[]): boolean {
  if (Object.keys(query).some((key) => (key === '$and' || key === '$or') && !isAbsent(query[key]))) return false
  const best = lookupOrder(conditions)[0]
  const askarFirst = conditions.flatMap((c) => (c.kind === 'tag' ? askarTagNames(c) : [c.key])).sort()[0]
  return rank(best) >= 2 || (best.kind === 'tag' && askarTagNames(best).includes(askarFirst))
}

/**
 * Plans `query`, or returns undefined when it should run exactly as written: there is no OR to split
 * and Askar already leads with a selective tag, or the shape is outside what this planner handles.
 */
export function planTagQuery<T extends BaseRecord>(query: Query<T>): TagQueryPlan<T> | undefined {
  const conjunctions = toConjunctions(query)
  // No conjunctions only happens for malformed input; an empty conjunction matches every record,
  // so a union containing one would just be the whole category.
  if (!conjunctions || conjunctions.length === 0 || conjunctions.some((conditions) => conditions.length === 0)) {
    return undefined
  }
  if (conjunctions.length === 1) {
    const [conditions] = conjunctions
    if (askarAlreadyLeadsWell(query as AnyQuery, conditions)) return undefined
    return { kind: 'single', query: conjunctionQuery<T>(lookupOrder(conditions)) }
  }
  return { kind: 'union', branches: conjunctions.map((conditions) => conjunctionQuery<T>(lookupOrder(conditions))) }
}
