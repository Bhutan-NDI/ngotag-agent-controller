import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { writeFile, readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { fixture } from '../../../src/storage/fixtures/recordPages.helpers.mjs'

const scanSource = await readFile(
  new URL('../../../node_modules/@openwallet-foundation/askar-shared/build/store/Scan.js', import.meta.url),
)
assert.ok(
  scanSource.toString().includes('listHandle.free()'),
  'Long benchmarks require the priority-1 native result cleanup prerequisite',
)
const ffiBinary = await readFile(
  new URL('../../../node_modules/@2060.io/ffi-napi/build/Release/ffi_bindings.node', import.meta.url),
)
const nativePrerequisites = {
  ffiSha256: createHash('sha256').update(ffiBinary).digest('hex'),
  scanSha256: createHash('sha256').update(scanSource).digest('hex'),
  note: 'Priority-1 FFI and scan cleanup are shared by every mode; they are not priority-4 changes.',
}
const container = 'codex-priority4-postgres'
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8' }).trim()
assert.match(docker('context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'), /^unix:\/\//)
const inspect = JSON.parse(docker('inspect', container))[0]
assert.equal(inspect.Config.Image, 'postgres:16.13')
const binding = inspect.NetworkSettings.Ports['5432/tcp'][0]
assert.equal(binding.HostIp, '127.0.0.1')
const f = await fixture(Number(binding.HostPort))
const sql = (query) => docker('exec', container, 'psql', '-U', 'fixture', '-d', f.databaseName, '-At', '-c', query)
const stats = () =>
  JSON.parse(
    sql(
      `SELECT json_build_object('calls',coalesce(sum(calls),0),'rows',coalesce(sum(rows),0),'executionMs',coalesce(sum(total_exec_time),0),'planningMs',coalesce(sum(total_plan_time),0),'bufferHits',coalesce(sum(shared_blks_hit),0),'bufferReads',coalesce(sum(shared_blks_read),0)) FROM pg_stat_statements WHERE dbid=(SELECT oid FROM pg_database WHERE datname=current_database()) AND query ~* '^SELECT' AND query ILIKE '%FROM items%'`,
    ),
  )
const count = 2000
const iterations = 20
const pageSize = 100
const results = []
try {
  for (const kind of ['proofs', 'oob']) for (let index = 0; index < count; index++) await f.save(kind, index)
  sql('CREATE EXTENSION pg_stat_statements; ANALYZE')
  for (const kind of ['proofs', 'oob']) {
    const repository = f.repositories[kind]
    const context = f.context()
    const all = await repository.findByQuery(context, {}, { orderBy: 'id' })
    const expected = all.map((row) => row.id)
    for (let trial = 0; trial < 3; trial++) {
      for (const mode of trial % 2 === 0
        ? ['complete-list', 'first-page', 'last-page', 'full-traversal']
        : ['full-traversal', 'last-page', 'first-page', 'complete-list']) {
        const run = async () => {
          if (mode === 'complete-list') {
            const rows = await repository.findByQuery(context, {})
            assert.equal(rows.length, count)
            return { ids: rows.map((row) => row.id), decoded: rows.length }
          }
          const offset = mode === 'last-page' ? count - pageSize : 0
          const rows = await repository.findByQuery(context, {}, { limit: pageSize + 1, offset, orderBy: 'id' })
          let decoded = rows.length
          const ids = rows.slice(0, pageSize).map((row) => row.id)
          if (mode === 'full-traversal') {
            for (let start = pageSize; start < count; start += pageSize) {
              const next = await repository.findByQuery(
                context,
                {},
                { limit: pageSize + 1, offset: start, orderBy: 'id' },
              )
              decoded += next.length
              ids.push(...next.slice(0, pageSize).map((row) => row.id))
            }
          }
          assert.deepEqual(ids, mode === 'full-traversal' ? expected : expected.slice(offset, offset + pageSize))
          return { ids, decoded }
        }
        await run()
        const before = stats()
        const usedCpu = process.cpuUsage()
        const latencies = []
        let decoded = 0
        let responseBytes = 0
        for (let index = 0; index < iterations; index++) {
          const start = performance.now()
          const result = await run()
          latencies.push(performance.now() - start)
          decoded += result.decoded
          responseBytes += Buffer.byteLength(JSON.stringify(result.ids))
        }
        const cpu = process.cpuUsage(usedCpu)
        const after = stats()
        latencies.sort((a, b) => a - b)
        const percentile = (fraction) => latencies[Math.ceil(iterations * fraction) - 1]
        const result = {
          kind,
          trial: trial + 1,
          mode,
          p50Ms: percentile(0.5),
          p95Ms: percentile(0.95),
          p99Ms: percentile(0.99),
          decodedRecords: decoded,
          idArrayBytes: responseBytes,
          clientCpuMs: (cpu.user + cpu.system) / 1000,
          database: Object.fromEntries(Object.entries(after).map(([key, value]) => [key, value - before[key]])),
        }
        results.push(result)
        console.log(JSON.stringify(result))
      }
    }
  }
  await writeFile(
    new URL('./results.json', import.meta.url),
    JSON.stringify(
      {
        nativePrerequisites,
        node: process.version,
        postgres: '16.13',
        countPerCategory: count,
        iterations,
        pageSize,
        concurrency: 1,
        results,
      },
      null,
      2,
    ) + '\n',
  )
} finally {
  await f.close()
}
