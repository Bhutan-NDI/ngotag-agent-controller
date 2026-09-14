import 'reflect-metadata'
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { performance } from 'node:perf_hooks'
import { TenantSessionMutex as Baseline } from './baselineMutex.mjs'
import { TenantSessionMutex as Candidate } from '../../../node_modules/@credo-ts/tenants/build/context/TenantSessionMutex.mjs'

// baselineMutex.mjs: @credo-ts/tenants 0.6.2, with develop's patches 001 and 002
// (controller baseline 5eb96175b8e2ef80de0a15334c4ba012d4b9321f). Apache-2.0.
const logger = { debug() {}, warn() {} }
const results = []
for (let trial = 0; trial < 3; trial++) {
  for (const [mode, Mutex] of trial % 2 === 0
    ? [
        ['baseline', Baseline],
        ['candidate', Candidate],
      ]
    : [
        ['candidate', Candidate],
        ['baseline', Baseline],
      ]) {
    const pool = new Mutex(logger, 3, 150)
    let active = 0,
      peak = 0,
      completed = 0,
      rejected = 0
    const latency = []
    const start = performance.now()
    await Promise.all(
      Array.from({ length: 30 }, async () => {
        const began = performance.now()
        try {
          await pool.acquireSession()
        } catch {
          rejected++
          return
        }
        peak = Math.max(peak, ++active)
        try {
          await new Promise((resolve) => setTimeout(resolve, 2))
          completed++
          latency.push(performance.now() - began)
        } finally {
          active--
          pool.releaseSession()
        }
      }),
    )
    latency.sort((a, b) => a - b)
    const result = {
      trial: trial + 1,
      mode,
      completed,
      rejected,
      peak,
      remaining: pool.currentSessions,
      elapsedMs: performance.now() - start,
      successfulP95Ms: latency[Math.ceil(latency.length * 0.95) - 1],
    }
    assert.equal(peak, 3)
    assert.equal(pool.currentSessions, 0)
    if (mode === 'candidate') {
      assert.equal(completed, 30)
      assert.equal(rejected, 0)
    }
    results.push(result)
    console.log(JSON.stringify(result))
  }
}
await writeFile(
  new URL('./results.json', import.meta.url),
  JSON.stringify({ jobs: 30, workMs: 2, limit: 3, acquireTimeoutMs: 150, results }, null, 2) + '\n',
)
