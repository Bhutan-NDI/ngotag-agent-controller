import { MAX_OR_BRANCHES, planTagQuery } from '../tagQueryPlan'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Tags = Record<string, unknown>

describe('planTagQuery', () => {
  describe('queries left as written', () => {
    it.each([
      ['a single tag', { threadId: 't' }],
      ['tags Askar already leads with an identifier', { associatedRecordId: 'a', messageName: 'm', role: 'sender' }],
      ['an array tag that sorts first', { recipientKeyFingerprints: ['z6Mk'], role: 'created' }],
      ['only enumerations', { role: 'verifier', state: 'done' }],
      ['an empty $or (Askar ignores it)', { threadId: 't', $or: [] }],
      ['an empty $and (Askar ignores it)', { threadId: 't', $and: [] }],
    ])('%s', (_, query) => {
      expect(planTagQuery(query as any)).toBeUndefined()
    })

    it.each([
      ['a non-array $or', { $or: { a: 'b' } }],
      ['a non-object $or member', { $or: ['a'] }],
      ['an $or alternative without conditions', { $or: [{}, { did: 'd' }] }],
      ['an $or alternative of absent values only', { $or: [{ did: undefined }, { did: 'd' }] }],
      ['an empty query', {}],
      ['a non-object query', 'did'],
    ])('%s', (_, query) => {
      expect(planTagQuery(query as any)).toBeUndefined()
    })

    it(`more than ${MAX_OR_BRANCHES} OR branches`, () => {
      const alternatives = Array.from({ length: MAX_OR_BRANCHES + 1 }, (_, i) => ({ did: `d${i}` }))
      expect(planTagQuery({ $or: alternatives } as any)).toBeUndefined()
      const four = (prefix: string) => Array.from({ length: 4 }, (_, i) => ({ [prefix]: `${i}` }))
      // 3 x 3 = 9 branches after distribution.
      expect(planTagQuery({ $and: [{ $or: four('a').slice(1) }, { $or: four('b').slice(1) }] } as any)).toBeUndefined()
      expect(planTagQuery({ $and: [{ $or: four('a') }, { $or: four('b').slice(2) }] } as any)).toEqual(
        expect.objectContaining({ kind: 'union' }),
      )
    })
  })

  describe('AND led by a selective tag', () => {
    it('moves threadId ahead of role (connectionless proof lookup)', () => {
      expect(planTagQuery({ connectionId: undefined, threadId: 't', role: 'verifier' } as any)).toEqual({
        kind: 'single',
        query: { $and: [{ threadId: 't' }, { role: 'verifier' }] },
      })
    })

    it('leads with a unique id before a grouping id, enumerations last', () => {
      expect(planTagQuery({ connectionId: 'c', threadId: 't', role: 'holder' } as any)).toEqual({
        kind: 'single',
        query: { $and: [{ threadId: 't' }, { connectionId: 'c' }, { role: 'holder' }] },
      })
    })

    it('ranks booleans and operator values with enumerations, operators last', () => {
      expect(
        planTagQuery({ autoAccept: true, $not: { state: 'done' }, state: { $neq: 'x' }, invitationId: 'i' } as any),
      ).toEqual({
        kind: 'single',
        query: {
          $and: [{ invitationId: 'i' }, { autoAccept: true }, { state: { $neq: 'x' } }, { $not: { state: 'done' } }],
        },
      })
    })

    it('drops absent values exactly as Askar does', () => {
      expect(planTagQuery({ role: 'r', parentThreadId: null, previousDids: [], did: 'd' } as any)).toBeUndefined()
      expect(planTagQuery({ role: 'r', previousDids: [], threadId: 't' } as any)).toEqual({
        kind: 'single',
        query: { $and: [{ threadId: 't' }, { role: 'r' }] },
      })
    })

    it('orders a nested $and', () => {
      expect(planTagQuery({ $and: [{ role: 'r' }, { threadId: 't' }] } as any)).toEqual({
        kind: 'single',
        query: { $and: [{ threadId: 't' }, { role: 'r' }] },
      })
    })
  })

  describe('OR as a union of AND lookups', () => {
    it('splits DidCommConnectionRepository.findByDids', () => {
      expect(
        planTagQuery({
          $or: [
            { did: 'ours', theirDid: 'theirs' },
            { did: 'ours', previousTheirDids: ['theirs'] },
            { previousDids: ['ours'], theirDid: 'theirs' },
          ],
        } as any),
      ).toEqual({
        kind: 'union',
        branches: [
          { $and: [{ did: 'ours' }, { theirDid: 'theirs' }] },
          { $and: [{ did: 'ours' }, { previousTheirDids: ['theirs'] }] },
          { $and: [{ previousDids: ['ours'] }, { theirDid: 'theirs' }] },
        ],
      })
    })

    it('distributes sibling conditions into every branch (DidRepository.findCreatedDid)', () => {
      expect(planTagQuery({ $or: [{ alternativeDids: ['d'] }, { did: 'd' }], role: 'created' } as any)).toEqual({
        kind: 'union',
        branches: [
          { $and: [{ alternativeDids: ['d'] }, { role: 'created' }] },
          { $and: [{ did: 'd' }, { role: 'created' }] },
        ],
      })
    })

    it('expands nested OR inside $and and inside OR', () => {
      const plan = planTagQuery({
        $and: [{ $or: [{ a: '1' }, { b: '2' }] }, { $or: [{ c: '3' }, { $or: [{ d: '4' }, { e: '5' }] }] }],
      } as any)
      expect(plan?.kind).toBe('union')
      expect((plan as any).branches).toHaveLength(6)
    })

    it('keeps an OR under $not inside its branch', () => {
      expect(planTagQuery({ $or: [{ a: '1' }, { b: '2' }], $not: { $or: [{ c: '3' }, { d: '4' }] } } as any)).toEqual({
        kind: 'union',
        branches: [
          { $and: [{ a: '1' }, { $not: { $or: [{ c: '3' }, { d: '4' }] } }] },
          { $and: [{ b: '2' }, { $not: { $or: [{ c: '3' }, { d: '4' }] } }] },
        ],
      })
    })
  })

  describe('matches exactly the records the original query matches', () => {
    // Reference semantics: Credo's tag encoding (askar/storage/utils transformFromRecordTagValues)
    // followed by Askar's WQL evaluation, where every condition is an equality on an encoded tag.
    const encodeTags = (tags: Tags) => {
      const encoded: Record<string, string> = {}
      for (const [key, value] of Object.entries(tags)) {
        if (value === null || value === undefined) continue
        if (typeof value === 'boolean') encoded[key] = value ? '1' : '0'
        else if (value === '1' || value === '0') encoded[key] = `n__${value}`
        else if (Array.isArray(value)) for (const item of value) encoded[`${key}:${item}`] = '1'
        else encoded[key] = value as string
      }
      return encoded
    }
    const matches = (query: any, record: Record<string, string>): boolean => {
      let result = true
      for (const [key, value] of Object.entries(query)) {
        if (value === undefined) continue
        if (key === '$and') result &&= (value as any[]).every((q) => matches(q, record))
        else if (key === '$or')
          result &&= (value as any[]).length === 0 || (value as any[]).some((q) => matches(q, record))
        else if (key === '$not') result &&= !matches(value, record)
        else {
          const conditions = Object.entries(encodeTags({ [key]: value }))
          result &&= conditions.every(([name, encoded]) => record[name] === encoded)
        }
      }
      return result
    }

    // Deterministic pseudo-random generator, so a failure reproduces.
    let seed = 20261106
    const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648
    const pick = <V>(values: V[]) => values[Math.floor(random() * values.length)]
    const names = ['threadId', 'role', 'state', 'connectionId', 'did', 'recipientKeyFingerprints', 'flag']
    const tagValue = (name: string): unknown => {
      if (name === 'recipientKeyFingerprints') return pick([[], ['k1'], ['k2'], ['k1', 'k2']])
      if (name === 'flag') return pick([true, false, undefined])
      return pick(['1', '0', 'a', 'b', undefined, null])
    }
    const randomRecord = () => Object.fromEntries(names.map((name) => [name, tagValue(name)]))
    const randomQuery = (depth: number): any => {
      const query: any = {}
      for (const name of names) if (random() < 0.35) query[name] = tagValue(name)
      if (depth > 0 && random() < 0.5)
        query.$or = Array.from({ length: 1 + Math.floor(random() * 3) }, () => randomQuery(depth - 1))
      if (depth > 0 && random() < 0.25)
        query.$and = Array.from({ length: Math.floor(random() * 3) }, () => randomQuery(depth - 1))
      if (depth > 0 && random() < 0.15) query.$not = randomQuery(depth - 1)
      return query
    }

    it('on 3,000 random queries over 300 random records', () => {
      const records = Array.from({ length: 300 }, () => encodeTags(randomRecord()))
      let planned = 0
      for (let i = 0; i < 3000; i++) {
        const query = randomQuery(2)
        const expected = records.map((record) => matches(query, record))
        const plan = planTagQuery(query)
        if (!plan) continue
        planned++
        const actual = records.map((record) =>
          plan.kind === 'single'
            ? matches(plan.query, record)
            : plan.branches.some((branch) => matches(branch, record)),
        )
        expect({ query, actual }).toEqual({ query, actual: expected })
        const orOutsideNot = (q: any): boolean =>
          Object.entries(q).some(
            ([key, value]) => key === '$or' || (key === '$and' && (value as any[]).some((part) => orOutsideNot(part))),
          )
        if (plan.kind === 'union') for (const branch of plan.branches) expect(orOutsideNot(branch)).toBe(false)
      }
      expect(planned).toBeGreaterThan(1000)
    })
  })
})
