/**
 * The relay only works if it sits between the inbound transport's body parser and Credo's POST handler, and it must
 * not exist at all on a dedicated agent or when it is switched off. Source guards, like rateLimitOrdering.spec.ts.
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

describe('migration relay wiring in cliAgent', () => {
  it('is built only for a multi-tenant agent', () => {
    expect(source).toContain('const relay = afjConfig.tenancy ? initRelayRuntime(logger) : undefined')
  })

  it('mounts after the transport body parsers and before agent.initialize() registers the POST handler', () => {
    expect(indexOf('transport.app.use(relay.middleware)')).toBeGreaterThan(
      indexOf('transport.app.use(bodyParser.json('),
    )
    expect(indexOf('transport.app.use(relay.middleware)')).toBeLessThan(indexOf('await agent.initialize()'))
  })

  it('watches for new routing keys and restores its state once the agent is initialised', () => {
    expect(indexOf('relay.service.watchRoutingKeys(')).toBeGreaterThan(indexOf('await agent.initialize()'))
    expect(indexOf('.rehydrate(')).toBeGreaterThan(indexOf('await agent.initialize()'))
  })

  it('is shut down with the agent', () => {
    expect(source).toContain('await shutdownRelayRuntime()')
  })
})
