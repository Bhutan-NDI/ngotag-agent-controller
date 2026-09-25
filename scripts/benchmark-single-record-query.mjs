import 'reflect-metadata'
import { askar } from '@openwallet-foundation/askar-nodejs'
import { execFileSync } from 'node:child_process'
import { performance } from 'node:perf_hooks'
import { AskarStorageService } from '@credo-ts/askar'
import { CacheModuleConfig, GenericRecord, RecordDuplicateError, Repository } from '@credo-ts/core'
import { KdfMethod, Store, StoreKeyMethod } from '@openwallet-foundation/askar-shared'

const mode = process.argv[2]
const scenario = process.argv[3]
if (
  !['seed', 'before', 'after'].includes(mode) ||
  (mode !== 'seed' && !['unique', 'missing', 'duplicate'].includes(scenario))
) {
  throw new Error('Usage: node scripts/benchmark-single-record-query.mjs seed | before|after unique|missing|duplicate')
}
const container = 'codex-credo-priority1-pg16'
// This benchmark only targets the dedicated local fixture container below.
// It never reads application configuration or accepts a database URL.
const endpoint = execFileSync('docker', ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'], {
  encoding: 'utf8',
}).trim()
if (!endpoint.startsWith('unix://')) throw new Error('Benchmark requires a local Docker context')
const portMapping = execFileSync('docker', ['port', container, '5432/tcp'], { encoding: 'utf8' }).trim()
const mapping = /^127\.0\.0\.1:(\d+)$/.exec(portMapping)
if (!mapping) throw new Error('Benchmark container must publish PostgreSQL only on 127.0.0.1')
const database = 'credo_priority1_benchmark'
const config = {
  uri: `postgres://postgres@127.0.0.1:${mapping[1]}/${database}`,
  keyMethod: new StoreKeyMethod(KdfMethod.Raw),
  // Deterministic, synthetic fixture key; never use this for application data.
  passKey: Store.generateRawKey(new Uint8Array(32).fill(7)),
  profile: 'benchmark-tenant',
}
function sql(query) {
  return execFileSync(
    'docker',
    ['exec', container, 'psql', '-XAt', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', database, '-c', query],
    { encoding: 'utf8', timeout: 10000 },
  ).trim()
}
let acquiredLists = 0
let releasedLists = 0
const scanNext = askar.scanNext.bind(askar)
const entryListFree = askar.entryListFree.bind(askar)
// Before mode reproduces the original scan's unreleased native result lists.
// This deliberate leak is restricted to the disposable benchmark process.
askar.scanNext = async (options) => {
  const handle = await scanNext(options)
  if (handle) acquiredLists++
  return handle
}
askar.entryListFree = (options) => {
  if (mode !== 'before') {
    releasedLists++
    return entryListFree(options)
  }
}
let report
// Fail closed rather than presenting a hung native run as a completed benchmark.
const watchdog = setTimeout(() => {
  process.stderr.write('Benchmark exceeded 90 seconds; native run or cleanup did not complete.\n')
  process.exit(1)
}, 90000)
const store = mode === 'seed' ? await Store.provision({ ...config, recreate: false }) : await Store.open(config)
try {
  if (mode === 'seed') {
    const session = await store.transaction(config.profile).open()
    try {
      for (let i = 0; i < 11000; i++) {
        const tags = {
          associatedRecordId: i < 10000 ? `exchange-${i}` : 'duplicate-exchange',
          messageName: 'presentation',
          protocolName: 'present-proof',
          protocolMajorVersion: '2',
          role: 'receiver',
        }
        const record = new GenericRecord({ id: `record-${i}`, tags, content: { fixture: 'x'.repeat(1024) } })
        await session.insert({
          category: GenericRecord.type,
          name: record.id,
          value: JSON.stringify(record.toJSON()),
          tags,
        })
      }
      await session.commit()
    } catch (error) {
      await session.rollback()
      throw error
    }
    sql('CREATE EXTENSION pg_stat_statements; ANALYZE;')
    report = { seeded: 11000, unique: 10000, duplicateMatches: 1000, tagsPerRecord: 5 }
  } else {
    const context = {
      contextCorrelationId: config.profile,
      dependencyManager: { isRegistered: () => false },
      resolve: () => new CacheModuleConfig({ cache: {}, useCachedStorageService: false }),
    }
    const storage = new AskarStorageService({
      getInitializedStoreWithProfile: async () => ({ store, profile: config.profile }),
    })
    let returned = 0
    const find = storage.findByQuery.bind(storage)
    storage.findByQuery = async (ctx, recordClass, query, options) => {
      // Reproduce the pre-patch storage call without changing the installed
      // package while keeping every other part of the pipeline identical.
      const records = await find(ctx, recordClass, query, mode === 'before' ? undefined : options)
      returned += records.length
      return records
    }
    const repository = new Repository(GenericRecord, storage, { emit() {} })
    const base = {
      messageName: 'presentation',
      protocolName: 'present-proof',
      protocolMajorVersion: '2',
      role: 'receiver',
    }
    async function lookup(index) {
      const associatedRecordId =
        scenario === 'duplicate'
          ? 'duplicate-exchange'
          : scenario === 'missing'
            ? 'missing-exchange'
            : `exchange-${index % 10000}`
      try {
        const result = await repository.findSingleByQuery(context, { ...base, associatedRecordId })
        if (
          scenario === 'duplicate' ||
          (scenario === 'missing' ? result !== null : result?.id !== `record-${index % 10000}`)
        )
          throw new Error('Unexpected benchmark result')
      } catch (error) {
        if (scenario !== 'duplicate' || !(error instanceof RecordDuplicateError)) throw error
      }
    }
    const operations = Number(process.argv[4] ?? 200)
    const warmup = Number(process.argv[5] ?? 20)
    if (
      !Number.isInteger(operations) ||
      operations < 1 ||
      operations > 100000 ||
      !Number.isInteger(warmup) ||
      warmup < 0 ||
      warmup > 10000
    ) {
      throw new Error('Invalid benchmark iteration or warmup count')
    }
    for (let i = 0; i < warmup; i++) await lookup(i)
    returned = 0
    acquiredLists = 0
    releasedLists = 0
    sql('SELECT pg_stat_statements_reset();')
    const durations = []
    const cpu = process.cpuUsage()
    const started = performance.now()
    for (let i = 0; i < operations; i++) {
      const t = performance.now()
      await lookup(i)
      durations.push(performance.now() - t)
    }
    const elapsed = performance.now() - started
    const usedCpu = process.cpuUsage(cpu)
    durations.sort((a, b) => a - b)
    const statements = JSON.parse(
      sql(
        `SELECT coalesce(json_agg(row_to_json(s)), '[]'::json) FROM (SELECT calls, rows, total_exec_time, shared_blks_hit, shared_blks_read, temp_blks_read, temp_blks_written, blk_read_time, blk_write_time FROM pg_stat_statements WHERE query LIKE '%FROM items%' AND query NOT LIKE '%pg_stat_statements%') s;`,
      ),
    )
    report = {
      mode,
      scenario,
      operations,
      returned,
      acquiredLists,
      releasedLists,
      elapsedMs: elapsed,
      opsPerSecond: (operations * 1000) / elapsed,
      p50Ms: durations[Math.ceil(operations * 0.5) - 1],
      p95Ms: durations[Math.ceil(operations * 0.95) - 1],
      p99Ms: durations[Math.ceil(operations * 0.99) - 1],
      applicationCpuMs: (usedCpu.user + usedCpu.system) / 1000,
      maxRssKiB: process.resourceUsage().maxRSS,
      statements,
    }
  }
} finally {
  askar.scanNext = scanNext
  askar.entryListFree = entryListFree
  await store.close()
  clearTimeout(watchdog)
}
console.log(JSON.stringify(report))
