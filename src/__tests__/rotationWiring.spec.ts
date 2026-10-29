/**
 * Source guards for how cliAgent wires the migration rotation: only on a dedicated agent, started after the agent is
 * initialised, shut down with it, and with the network error code surfaced for the "never left" check.
 */
import { readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'cliAgent.ts'), 'utf8')
const indexOf = (needle: string): number => {
  const index = source.indexOf(needle)
  expect(index).toBeGreaterThan(-1)
  return index
}

describe('migration rotation wiring in cliAgent', () => {
  it('starts only on a dedicated (non multi-tenant) agent, after initialize()', () => {
    const start = indexOf('await initRotationRuntime(')
    expect(start).toBeGreaterThan(indexOf('await agent.initialize()'))
    expect(source.slice(source.lastIndexOf('if (', start), start)).toContain('!afjConfig.tenancy')
  })

  it('stops with the agent', () => {
    expect(source).toContain('shutdownRotationRuntime()')
  })

  it('gives Credo a fetch that reports the network error code', () => {
    expect(source).toContain('fetch: withNetworkErrorCodes(agentDependencies.fetch)')
  })
})
