/**
 * OpenTelemetry can only patch http and express if it is registered before they are required, and
 * this package compiles to CommonJS, so import order is load order. cliAgent.ts loads express, so
 * cli.ts must load the tracer first -- a lint autofix that sorts the imports would undo it silently,
 * leaving the controller running with no request spans. Source guard, like rateLimitOrdering.spec.ts.
 */
import { readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'cli.ts'), 'utf8')
const indexOf = (needle: string): number => {
  const index = source.indexOf(needle)
  expect(index).toBeGreaterThan(-1)
  return index
}

describe('cli.ts start-up order', () => {
  it('loads the tracer before cliAgent, which loads express', () => {
    expect(indexOf("from './tracer'")).toBeLessThan(indexOf("from './cliAgent.js'"))
  })

  it('starts telemetry before the agent is built', () => {
    expect(indexOf('await startTelemetry()')).toBeLessThan(indexOf('await parseArguments()'))
  })
})
