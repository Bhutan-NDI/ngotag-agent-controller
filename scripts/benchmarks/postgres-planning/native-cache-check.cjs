const assert = require('node:assert/strict')
const req = require
req('@openwallet-foundation/askar-nodejs')
const { Store, StoreKeyMethod, KdfMethod } = req('@openwallet-foundation/askar-shared')
const { execFileSync } = require('child_process')
const container = 'codex-credo-capacity-pg16'
if (
  !execFileSync('docker', ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'], { encoding: 'utf8' })
    .trim()
    .startsWith('unix://')
)
  throw Error('Local Docker context required')
const m = /^127\.0\.0\.1:(\d+)$/.exec(
  execFileSync('docker', ['port', container, '5432/tcp'], { encoding: 'utf8' }).trim(),
)
if (!m) throw Error('Local fixture required')
function sql(q) {
  return execFileSync(
    'docker',
    [
      'exec',
      container,
      'psql',
      '-XAt',
      '-v',
      'ON_ERROR_STOP=1',
      '-U',
      'postgres',
      '-d',
      'native_plan_validation',
      '-c',
      q,
    ],
    { encoding: 'utf8' },
  ).trim()
}
;(async () => {
  const base = {
    uri: `postgres://postgres@127.0.0.1:${m[1]}/native_plan_validation?max_connections=1`,
    keyMethod: new StoreKeyMethod(KdfMethod.Raw),
    passKey: Store.generateRawKey(new Uint8Array(32).fill(33)),
    profile: 'synthetic',
  }
  let store = await Store.provision({ ...base, recreate: false })
  let sess = await store.transaction('synthetic').open()
  for (let i = 0; i < 100; i++)
    await sess.insert({
      category: 'message',
      name: `record-${i}`,
      value: 'synthetic-only',
      tags: {
        associatedRecordId: `exchange-${i}`,
        messageName: 'presentation',
        protocolName: 'present-proof',
        role: 'receiver',
      },
    })
  await sess.commit()
  await store.close()
  sql('CREATE EXTENSION pg_stat_statements; ANALYZE;')
  for (const capacity of [100, 0]) {
    sql('SELECT pg_stat_statements_reset();')
    store = await Store.open({ ...base, uri: base.uri + `&statement-cache-capacity=${capacity}` })
    for (let i = 0; i < 20; i++) {
      const rows = await store
        .scan({
          category: 'message',
          tagFilter: {
            associatedRecordId: `exchange-${i}`,
            messageName: 'presentation',
            protocolName: 'present-proof',
            role: 'receiver',
          },
          limit: 2,
          profile: 'synthetic',
        })
        .fetchAll()
      if (rows.length !== 1 || rows[0].name !== `record-${i}`) throw Error('Result changed')
    }
    await store.close()
    const statistics = JSON.parse(
      sql(
        "SELECT json_agg(x) FROM (SELECT calls,plans,rows FROM pg_stat_statements WHERE query LIKE 'SELECT id, kind, category, name, value%') x",
      ),
    )
    assert.equal(statistics.length, 1)
    assert.equal(statistics[0].calls, 20)
    assert.equal(statistics[0].rows, 20)
    if (capacity === 0) assert.equal(statistics[0].plans, 20)
    console.log(
      JSON.stringify({
        capacity,
        stats: sql(
          "SELECT json_agg(x) FROM (SELECT calls,plans,rows FROM pg_stat_statements WHERE query LIKE 'SELECT id, kind, category, name, value%') x",
        ),
      }),
    )
  }
  store = await Store.open({ ...base, uri: base.uri + '&statement-cache-capacity=0' })
  try {
    await store.createProfile('isolated')
    const other = await store.session('isolated').open()
    try {
      await other.insert({
        category: 'message',
        name: 'record-0',
        value: 'other-profile',
        tags: { associatedRecordId: 'exchange-0' },
      })
      assert.equal(await other.count({ category: 'message' }), 1)
    } finally {
      await other.close()
    }
    const txn = await store.transaction('synthetic').open()
    try {
      await txn.replace({ category: 'message', name: 'record-0', value: 'rolled-back' })
    } finally {
      await txn.rollback()
    }
    const session = await store.session('synthetic').open()
    try {
      assert.equal((await session.fetch({ category: 'message', name: 'record-0' })).value, 'synthetic-only')
      assert.equal(await session.fetch({ category: 'message', name: 'missing' }), null)
      assert.equal(await session.count({ category: 'message' }), 100)
      const rows = await session.fetchAll({
        category: 'message',
        tagFilter: { $or: [{ associatedRecordId: 'exchange-0' }, { associatedRecordId: 'exchange-1' }] },
      })
      assert.deepEqual(rows.map((row) => row.name).sort(), ['record-0', 'record-1'])
      await session.insert({ category: 'message', name: 'temporary', value: 'inserted' })
      await session.replace({ category: 'message', name: 'temporary', value: 'updated' })
      assert.equal((await session.fetch({ category: 'message', name: 'temporary' })).value, 'updated')
      await session.remove({ category: 'message', name: 'temporary' })
      assert.equal(await session.fetch({ category: 'message', name: 'temporary' }), null)
    } finally {
      await session.close()
    }
    console.log(JSON.stringify({ uncachedCrudRollbackOrAndProfileIsolation: true }))
  } finally {
    await store.close()
  }
})().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
