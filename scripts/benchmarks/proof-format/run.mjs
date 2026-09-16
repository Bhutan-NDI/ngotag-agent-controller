import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { writeFile, readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { fixture, protocol, baselineProtocol, kinds } from '../../../src/storage/fixtures/proofFormat.helpers.mjs'

// Never accept a database URL: only this dedicated localhost Docker fixture.
const container = 'codex-priority3-postgres'
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
const count = 5000
const iterations = 600
const concurrency = 8
const results = []
try {
  for (let index = 0; index < count; index++)
    for (const [kind] of kinds) await f.save(kind, { index, kind }, `proof-${index}`)
  sql('CREATE EXTENSION pg_stat_statements; ANALYZE')
  const p = protocol()
  const baseline = baselineProtocol()
  const workload = Array.from({ length: iterations }, (_, index) => (index % 4 === 0 ? -1 : (index * 7919) % count))
  function expected(index) {
    return index < 0 ? {} : Object.fromEntries(kinds.map(([kind]) => [kind, { fixture: { index, kind } }]))
  }
  for (let trial = 0; trial < 3; trial++) {
    const modes = trial % 2 === 0 ? ['baseline', 'candidate'] : ['candidate', 'baseline']
    for (const mode of modes) {
      const runner = mode === 'baseline' ? baseline : p
      for (let index = 0; index < 40; index++) await runner.getFormatData(f.context(), `proof-${index}`)
      f.queries.length = 0
      const before = stats()
      const cpu = process.cpuUsage()
      const latencies = []
      let next = 0
      const started = performance.now()
      await Promise.all(
        Array.from({ length: concurrency }, async () => {
          while (next < workload.length) {
            const index = workload[next++]
            const start = performance.now()
            const actual = await runner.getFormatData(f.context(), index < 0 ? 'absent' : `proof-${index}`)
            latencies.push(performance.now() - start)
            assert.deepEqual(actual, expected(index))
          }
        }),
      )
      const elapsedMs = performance.now() - started
      const usedCpu = process.cpuUsage(cpu)
      const after = stats()
      const database = Object.fromEntries(Object.entries(after).map(([key, value]) => [key, value - before[key]]))
      assert.equal(f.queries.length, iterations * (mode === 'baseline' ? 3 : 1))
      assert.equal(database.calls, f.queries.length)
      latencies.sort((a, b) => a - b)
      const percentile = (fraction) => latencies[Math.ceil(latencies.length * fraction) - 1]
      results.push({
        trial: trial + 1,
        mode,
        elapsedMs,
        throughput: (iterations * 1000) / elapsedMs,
        p50Ms: percentile(0.5),
        p95Ms: percentile(0.95),
        p99Ms: percentile(0.99),
        searches: f.queries.length,
        clientCpuMs: (usedCpu.user + usedCpu.system) / 1000,
        database,
        mismatches: 0,
      })
      console.log(JSON.stringify(results.at(-1)))
    }
  }
  await writeFile(
    new URL('./results.json', import.meta.url),
    JSON.stringify(
      {
        node: process.version,
        postgres: '16.13',
        proofCount: count,
        messageCount: count * 3,
        iterations,
        concurrency,
        missingFraction: 0.25,
        analyzedAfterSeeding: true,
        ffiBinarySha256: createHash('sha256')
          .update(
            await readFile(
              new URL('../../../node_modules/@2060.io/ffi-napi/build/Release/ffi_bindings.node', import.meta.url),
            ),
          )
          .digest('hex'),
        trials: results,
      },
      null,
      2,
    ) + '\n',
  )
} finally {
  await f.close()
}
