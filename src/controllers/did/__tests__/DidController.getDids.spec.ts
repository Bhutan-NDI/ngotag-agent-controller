/**
 * Regression tests for GET /dids' isDefault query filter — the #75 review's follow-up finding
 * (kinxa0, 2026-08-17) that this repo had no read path at all for the tenant's default DID:
 * @Route('/dids') exposed only /:did, /write, and an unfiltered / (getDids, returning every
 * created DID). Combined with platform #71 not forwarding isDefault either, "fetch my default
 * DID" was broken end to end.
 *
 * Fix: getDids takes an optional isDefault query param; when true, it queries the DidRepository
 * for the isDefault-tagged DidRecord(s) directly (the same tag DidController.writeDid sets)
 * instead of returning request.agent.dids.getCreatedDids()'s full, unfiltered list.
 *
 * Runs under Jest's ESM mode, mirroring the other DidController spec files in this directory.
 */
import { jest } from '@jest/globals'

const noopDecorator = () => () => {}

const mockRootAgent = { config: { logger: { info: jest.fn(), warn: jest.fn() } } }

jest.unstable_mockModule('tsyringe', () => ({
  injectable: noopDecorator,
  singleton: noopDecorator,
  scoped: noopDecorator,
  autoInjectable: noopDecorator,
  inject: noopDecorator,
  injectAll: noopDecorator,
  delay: (fn: unknown) => fn,
  Lifecycle: { Singleton: 0, Transient: 1, ResolutionScoped: 2, ContainerScoped: 3 },
  container: {
    resolve: jest.fn(() => mockRootAgent),
    register: jest.fn(),
    registerInstance: jest.fn(),
    isRegistered: jest.fn(() => false),
  },
}))

jest.unstable_mockModule('../../../cliAgent', () => ({}))

const { DidController } = await import('../DidController')
const { DidRepository } = await import('@credo-ts/core')

const ALL_CREATED_DIDS = [{ did: 'did:key:one' }, { did: 'did:key:two' }, { did: 'did:peer:2.connection' }]
const DEFAULT_TAGGED_RECORD = { did: 'did:key:one', id: 'rec-one' }

const makeAgent = () => {
  const didRepository = {
    findByQuery: jest.fn(async () => [DEFAULT_TAGGED_RECORD]) as jest.Mock,
  }
  return {
    dids: { getCreatedDids: jest.fn(async () => ALL_CREATED_DIDS) as jest.Mock },
    dependencyManager: {
      resolve: jest.fn((token: unknown) => (token === DidRepository ? didRepository : undefined)) as jest.Mock,
    },
    context: { contextCorrelationId: 'test-tenant' },
    _didRepository: didRepository,
  }
}

const makeRequest = (agent: unknown) => ({ agent }) as never

describe('DidController.getDids', () => {
  it('returns every created DID, unfiltered, when isDefault is omitted', async () => {
    const agent = makeAgent()
    const controller = new DidController()

    const result = await controller.getDids(makeRequest(agent))

    expect(result).toBe(ALL_CREATED_DIDS)
    expect(agent.dids.getCreatedDids).toHaveBeenCalledWith()
    expect(agent._didRepository.findByQuery).not.toHaveBeenCalled()
  })

  it('returns only the isDefault-tagged DidRecord(s) when isDefault=true, via the DidRepository tag query', async () => {
    const agent = makeAgent()
    const controller = new DidController()

    const result = await controller.getDids(makeRequest(agent), true)

    expect(result).toEqual([DEFAULT_TAGGED_RECORD])
    expect(agent._didRepository.findByQuery).toHaveBeenCalledWith(agent.context, { isDefault: true })
    expect(agent.dids.getCreatedDids).not.toHaveBeenCalled()
  })

  it('falls back to the full unfiltered list when isDefault=false', async () => {
    const agent = makeAgent()
    const controller = new DidController()

    const result = await controller.getDids(makeRequest(agent), false)

    expect(result).toBe(ALL_CREATED_DIDS)
    expect(agent._didRepository.findByQuery).not.toHaveBeenCalled()
  })
})
