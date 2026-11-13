// Combines bench.mjs trial files into one result file and prints a Markdown table of the medians of
// the per-trial values (not pooled percentiles).
//
// usage: node summarize.mjs <out.json> <trial.json>...
import { readFile, writeFile } from 'node:fs/promises'

const [outPath, ...trialPaths] = process.argv.slice(2)
if (!outPath || trialPaths.length === 0) throw new Error('usage: node summarize.mjs <out.json> <trial.json>...')

const trials = await Promise.all(trialPaths.map(async (path) => JSON.parse(await readFile(path, 'utf8'))))
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

const groups = new Map()
for (const trial of trials) {
  for (const result of trial.results) {
    const key = `${result.shape}|${result.planning}|${result.storage}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(result)
  }
}
const summary = [...groups.values()].map((results) => ({
  shape: results[0].shape,
  planning: results[0].planning,
  storage: results[0].storage,
  trials: results.length,
  lookups: results.reduce((sum, result) => sum + result.iterations, 0),
  mismatches: results.reduce((sum, result) => sum + result.mismatches, 0),
  p50Ms: median(results.map((result) => result.p50Ms)),
  p95Ms: median(results.map((result) => result.p95Ms)),
  buffersPerLookup: median(results.map((result) => result.buffersPerLookup)),
  statementsPerLookup: median(results.map((result) => result.statementsPerLookup)),
  execMsPerLookup: median(results.map((result) => result.execMsPerLookup)),
}))

await writeFile(outPath, JSON.stringify({ fixture: trials[0].fixture, summary, trials }, null, 2))

const shapes = [...new Set(summary.map((row) => row.shape))]
const cell = (shape, planning, storage, field) =>
  summary.find((row) => row.shape === shape && row.planning === planning && row.storage === storage)?.[field]
for (const planning of ['cache100', 'cache0', 'generic']) {
  process.stdout.write(`\n${planning}\n\n`)
  process.stdout.write(
    '| Query | Stock p50 / p95 ms | Stock buffers | Planned p50 / p95 ms | Planned buffers | Statements |\n',
  )
  process.stdout.write('| --- | ---: | ---: | ---: | ---: | ---: |\n')
  for (const shape of shapes) {
    process.stdout.write(
      `| ${shape} | ${cell(shape, planning, 'stock', 'p50Ms')} / ${cell(shape, planning, 'stock', 'p95Ms')} | ` +
        `${cell(shape, planning, 'stock', 'buffersPerLookup')} | ${cell(shape, planning, 'planned', 'p50Ms')} / ` +
        `${cell(shape, planning, 'planned', 'p95Ms')} | ${cell(shape, planning, 'planned', 'buffersPerLookup')} | ` +
        `${cell(shape, planning, 'planned', 'statementsPerLookup')} |\n`,
    )
  }
}
const mismatches = summary.reduce((sum, row) => sum + row.mismatches, 0)
const lookups = summary.reduce((sum, row) => sum + row.lookups, 0)
process.stdout.write(`\n${lookups} measured lookups, ${mismatches} result-count mismatches\n`)
