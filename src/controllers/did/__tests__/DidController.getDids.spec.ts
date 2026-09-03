/**
 * Regression tests for GET /dids' isDefault query filter. This repo had no read path at all for
 * the tenant's default DID: @Route('/dids') exposed only /:did, /write, and an unfiltered /
 * (getDids, returning every created DID).
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
const DEFAULT_TAGGED_RECORD = { did: 'did:key:one', id: 'rec-one', createdAt: new Date('2026-01-01T00:00:00.000Z') }

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

  it('sorts multiple isDefault-tagged records by createdAt descending — not an arbitrary unordered pick that could disagree with issuance', async () => {
    // findByQuery applies no ordering of its own (a plain Askar scan). A wallet migrated from the
    // legacy stack can carry more than one isDefault-tagged DID, and
    // AgentController.createW3cSelfAttestedCredential already sorts this identical query by
    // createdAt descending before picking one. Without the same sort here, this endpoint could
    // return the unsorted list with the superseded, earliest-tagged DID first -- the obvious way
    // to consume a "which DID is default" endpoint -- while issuance signs under a different one.
    const OLD_RECORD = { did: 'did:indy:old-default', id: 'rec-old', createdAt: new Date('2024-01-01T00:00:00.000Z') }
    const RECENT_RECORD = {
      did: 'did:indy:recent-default',
      id: 'rec-recent',
      createdAt: new Date('2025-06-01T00:00:00.000Z'),
    }
    const agent = makeAgent()
    // Deliberately returned in earliest-first order, matching an unordered store scan.
    agent._didRepository.findByQuery = jest.fn(async () => [OLD_RECORD, RECENT_RECORD]) as jest.Mock
    const controller = new DidController()

    const result = await controller.getDids(makeRequest(agent), true)

    expect(result).toEqual([RECENT_RECORD, OLD_RECORD])
  })

  it('falls back to the full unfiltered list when isDefault=false', async () => {
    const agent = makeAgent()
    const controller = new DidController()

    const result = await controller.getDids(makeRequest(agent), false)

    expect(result).toBe(ALL_CREATED_DIDS)
    expect(agent._didRepository.findByQuery).not.toHaveBeenCalled()
  })
})
