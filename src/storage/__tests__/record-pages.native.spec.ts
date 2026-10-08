import 'reflect-metadata'

// Exercise the shipped repository + Askar adapter + native scan; no storage mock.
const fixturePath = '../fixtures/recordPages.helpers.mjs'
const { fixture } = await import(fixturePath)

describe.each(['proofs', 'oob'])('%s native live pages', (kind) => {
  let f: any
  beforeEach(async () => {
    f = await fixture()
    for (let index = 0; index < 7; index++) await f.save(kind, index)
    await f.save(kind, 999, 'tenant-b')
  })
  afterEach(async () => {
    await f?.close()
  })

  it('traverses a static list exactly once, preserves tenant isolation and filters', async () => {
    const repository = f.repositories[kind]
    const all = await repository.findByQuery(f.context(), {}, { orderBy: 'id' })
    const seen: string[] = []
    for (let offset = 0; offset < all.length; offset += 2) {
      const page = await repository.findByQuery(f.context(), {}, { limit: 3, offset, orderBy: 'id' })
      expect(page.length).toBeLessThanOrEqual(3)
      seen.push(...page.slice(0, 2).map((row: any) => row.id))
    }
    expect(seen).toEqual(all.map((row: any) => row.id))
    expect(new Set(seen).size).toBe(7)
    const query = kind === 'proofs' ? { threadId: 'thread-1' } : { invitationId: 'invitation-1' }
    const filtered = await repository.findByQuery(f.context(), query, { limit: 3, offset: 1, orderBy: 'id' })
    expect(filtered.map((row: any) => row.id)).toEqual(kind === 'proofs' ? ['proof-3', 'proof-5'] : ['oob-3', 'oob-5'])
    expect(await repository.findByQuery(f.context(), {}, { limit: 3, offset: 7, orderBy: 'id' })).toEqual([])
  })

  it('keeps ordering after an update and documents live deletion shifts and later inserts', async () => {
    const repository = f.repositories[kind]
    const first = await repository.findByQuery(f.context(), {}, { limit: 2, offset: 0, orderBy: 'id' })
    first[0].setTag('synthetic-update', 'yes')
    await repository.update(f.context(), first[0])
    expect(
      (await repository.findByQuery(f.context(), {}, { limit: 2, orderBy: 'id' })).map((row: any) => row.id),
    ).toEqual(first.map((row: any) => row.id))
    await repository.delete(f.context(), first[0])
    await f.save(kind, 7)
    const next = await repository.findByQuery(f.context(), {}, { offset: 2, limit: 10, orderBy: 'id' })
    // Offset pages deliberately do not promise a snapshot: deletion shifts index 2 past the old index 2.
    expect(next.map((row: any) => row.id)).toEqual(
      [3, 4, 5, 6, 7].map((index) => `${kind === 'proofs' ? 'proof' : 'oob'}-${index}`),
    )
  })
})
