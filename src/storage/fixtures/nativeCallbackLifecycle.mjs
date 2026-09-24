import '@openwallet-foundation/askar-nodejs'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { KdfMethod, Store, StoreKeyMethod } from '@openwallet-foundation/askar-shared'

// A fresh child process must survive the callbacks AND exit naturally after
// cleanup. No process.exit(), keep-alive interval, application config, or server.
const directory = await mkdtemp(join(tmpdir(), 'credo-callback-lifecycle-'))
const config = {
  uri: `sqlite://${join(directory, 'wallet.db')}`,
  keyMethod: new StoreKeyMethod(KdfMethod.Raw),
  passKey: Store.generateRawKey(),
  profile: 'synthetic-tenant',
}
let store
let queries = 0
try {
  store = await Store.provision({ ...config, recreate: false })
  async function missing() {
    const rows = await store.scan({ category: 'synthetic-record', tagFilter: { absent: 'yes' } }).fetchAll()
    assert.deepEqual(rows, [])
    queries++
  }
  for (let i = 0; i < 2000; i++) {
    await missing()
    if (i % 250 === 0) global.gc()
  }
  // Concurrent native worker completions also race with loop-thread timers.
  await Promise.all(
    Array.from({ length: 8 }, async () => {
      for (let i = 0; i < 250; i++) await missing()
    }),
  )
  await assert.rejects(store.scan({ profile: 'nonexistent-profile', category: 'synthetic-record' }).fetchAll())
  for (let i = 0; i < 20; i++) {
    await store.close()
    store = undefined
    global.gc()
    store = await Store.open(config)
    await missing()
  }
} finally {
  if (store) await store.close()
  await rm(directory, { recursive: true, force: true })
}
assert.equal(queries, 4020)
console.log(JSON.stringify({ queries, closed: true }))
