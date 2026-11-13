// Measures the wallet queries in shapes.mjs against the seeded local fixture under PostgreSQL's
// plan-selection modes, with the stock AskarStorageService and with the plan-stable one.
//
// usage: node bench.mjs <port> <container> <manifest.json> <out.json> [iterations] [modes]
//   modes: comma-separated <storage>:<planning>, storage = stock|planned,
//          planning = cache100 (default SQLx cache, plan_cache_mode auto) | cache0 | generic
// The container must be the dedicated local fixture; the script only touches its own database.
import { execFileSync } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { performance } from 'node:perf_hooks'

import { contextFor, openStore, postgresUri, storageFor } from './fixture.mjs'
import { shapes } from './shapes.mjs'

const require = createRequire(import.meta.url)
const [portArg, container, manifestPath, outPath, iterationsArg = '40', modesArg] = process.argv.slice(2)
const port = Number(portArg)
const iterations = Number(iterationsArg)
if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(container ?? '') || !outPath || !Number.isSafeInteger(iterations)) {
  throw new Error('usage: node bench.mjs <port> <container> <manifest.json> <out.json> [iterations] [modes]')
}
const dockerContext = execFileSync('docker', ['context', 'show'], { encoding: 'utf8' }).trim()
if (dockerContext !== 'default' && dockerContext !== 'desktop-linux') {
  throw new Error(`Refusing to run against docker context '${dockerContext}': local fixture only`)
}
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
const database = manifest.database
const modes = (modesArg ?? 'stock:cache100,stock:cache0,stock:generic,planned:cache100,planned:cache0,planned:generic')
  .split(',')
  .map((mode) => {
    const [storage, planning] = mode.split(':')
    if (!['stock', 'planned'].includes(storage) || !['cache100', 'cache0', 'generic'].includes(planning)) {
      throw new Error(`Unknown mode ${mode}`)
    }
    return { storage, planning }
  })

const psql = (sql) =>
  execFileSync('docker', ['exec', container, 'psql', '-U', 'fixture', '-d', database, '-tAqc', sql], {
    encoding: 'utf8',
  }).trim()

// Statement counters for the wallet scans only (they all read items_tags in the select list).
function scanCounters() {
  const row = psql(
    `SELECT coalesce(sum(calls),0), coalesce(sum(shared_blks_hit + shared_blks_read),0), ` +
      `coalesce(sum(total_exec_time),0), coalesce(sum(total_plan_time),0) FROM pg_stat_statements ` +
      `WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database()) ` +
      `AND query LIKE 'SELECT id, kind, category, name, value,%'`,
  )
  const [calls, buffers, execMs, planMs] = row.split('|').map(Number)
  return { calls, buffers, execMs, planMs }
}

const quantile = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]

async function storageForMode(store, storage) {
  if (storage === 'stock') return storageFor(store)
  const { PlanStableAskarStorageService } = require('../../../build/storage/PlanStableAskarStorageService.js')
  const stock = storageFor(store)
  return new PlanStableAskarStorageService(stock.askarStoreManager)
}

psql('CREATE EXTENSION IF NOT EXISTS pg_stat_statements')
const results = []
for (const { storage: storageKind, planning } of modes) {
  psql(`ALTER DATABASE ${database} SET plan_cache_mode = ${planning === 'generic' ? 'force_generic_plan' : 'auto'}`)
  // One pooled connection: every execution of a shape reuses the same connection, as a busy
  // production pool connection does after its first few executions.
  const uri = postgresUri(port, database, {
    cacheCapacity: planning === 'cache0' ? 0 : undefined,
    maxConnections: 1,
  })
  const store = await openStore(uri, manifest.passKey)
  const storage = await storageForMode(store, storageKind)
  try {
    for (const shape of shapes(manifest)) {
      const context = contextFor(shape.profile)
      const run = async (i) => {
        const query = shape.query(i)
        const records = await storage.findByQuery(
          context,
          shape.recordClass,
          query,
          shape.single ? { limit: 2 } : undefined,
        )
        return records.length
      }
      // Six executions let PostgreSQL's auto mode switch a prepared statement to its generic plan.
      for (let i = 0; i < 8; i++) await run(i)
      psql('SELECT pg_stat_statements_reset()')
      const latencies = []
      let mismatches = 0
      const started = performance.now()
      for (let i = 0; i < iterations; i++) {
        const t0 = performance.now()
        const count = await run(i)
        latencies.push(performance.now() - t0)
        if (count !== shape.expected) mismatches++
      }
      const wallMs = performance.now() - started
      const counters = scanCounters()
      latencies.sort((a, b) => a - b)
      const result = {
        storage: storageKind,
        planning,
        shape: shape.name,
        iterations,
        mismatches,
        p50Ms: +quantile(latencies, 0.5).toFixed(2),
        p95Ms: +quantile(latencies, 0.95).toFixed(2),
        maxMs: +latencies[latencies.length - 1].toFixed(2),
        wallMs: +wallMs.toFixed(1),
        statementsPerLookup: +(counters.calls / iterations).toFixed(2),
        buffersPerLookup: Math.round(counters.buffers / iterations),
        execMsPerLookup: +(counters.execMs / iterations).toFixed(3),
      }
      results.push(result)
      process.stdout.write(
        `${storageKind}:${planning}  ${shape.name.padEnd(40)} p50 ${String(result.p50Ms).padStart(9)} ms  ` +
          `p95 ${String(result.p95Ms).padStart(9)} ms  buffers/lookup ${String(result.buffersPerLookup).padStart(9)}  ` +
          `stmts ${result.statementsPerLookup}  mismatches ${mismatches}\n`,
      )
    }
  } finally {
    await store.close()
  }
}
psql(`ALTER DATABASE ${database} RESET plan_cache_mode`)
await writeFile(
  outPath,
  JSON.stringify(
    {
      fixture: {
        postgres: psql('SHOW server_version'),
        items: Number(psql('SELECT count(*) FROM items')),
        tags: Number(psql('SELECT count(*) FROM items_tags')),
        profiles: Object.fromEntries(Object.entries(manifest.profiles).map(([name, p]) => [name, p.items])),
        rootRoutingRecords: manifest.rootRoutingRecords,
      },
      results,
    },
    null,
    2,
  ),
)
