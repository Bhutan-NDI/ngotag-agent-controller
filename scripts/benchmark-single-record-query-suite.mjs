import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

// One child at a time: avoid competing benchmark workers and require both a
// completed report and a clean process exit. A printed report alone is not a pass.
const run = promisify(execFile)
const script = fileURLToPath(new URL('./benchmark-single-record-query.mjs', import.meta.url))
const results = []
async function measure(mode, scenario, operations, warmup, repeat, extended = false) {
  const identity = { mode, scenario, operations, warmup, repeat, extended }
  try {
    const { stdout } = await run(process.execPath, [script, mode, scenario, `${operations}`, `${warmup}`], {
      timeout: 120000,
      killSignal: 'SIGKILL',
      maxBuffer: 1024 * 1024,
    })
    const measurement = JSON.parse(stdout)
    if (measurement.mode !== mode || measurement.scenario !== scenario || measurement.operations !== operations)
      throw new Error('Unexpected benchmark report')
    results.push({ ...identity, completed: true, measurement })
  } catch (error) {
    // Do not turn a native abort, timeout or incomplete JSON into a latency sample.
    results.push({ ...identity, completed: false, exitCode: error.code ?? null, signal: error.signal ?? null })
  }
  process.stderr.write(`${mode} ${scenario} repeat ${repeat}: ${results.at(-1).completed ? 'passed' : 'FAILED'}\n`)
}
for (let repeat = 1; repeat <= 3; repeat++) {
  for (const scenario of ['unique', 'missing', 'duplicate']) {
    for (const mode of repeat % 2 ? ['before', 'after'] : ['after', 'before']) {
      await measure(mode, scenario, scenario === 'duplicate' ? 200 : 2000, scenario === 'duplicate' ? 20 : 1000, repeat)
    }
  }
}
// Do not amplify the deliberately retained baseline leak into an OOM test.
// Separately stress the fixed duplicate path at the longer iteration count.
for (let repeat = 1; repeat <= 3; repeat++) await measure('after', 'duplicate', 2000, 1000, repeat, true)
console.log(
  JSON.stringify(
    {
      runtime: {
        node: process.version,
        libuv: process.versions.uv,
        platform: process.platform,
        architecture: process.arch,
      },
      nativeCallbackRaceFixAppliedToBothModes: true,
      results,
    },
    null,
    2,
  ),
)
if (results.some((result) => !result.completed)) process.exitCode = 1
