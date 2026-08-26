/**
 * Regression tests for the did:ethr path of DidController.handleEthereum.
 *
 * Covers the pre-agent-call validation (network must be mainnet/sepolia, a private key must be
 * present and 64 hex chars), the request/response shape sent to and read from agent.dids.create
 * (including the mainnet network name being sent as an empty string, matching the Ethereum
 * registrar's convention), and that a "failed" didState is surfaced as an InternalServerError
 * instead of a silent { did: undefined } success — mirroring DidController.polygon.spec.ts, since
 * the Ethereum registrar has the same never-throws-on-failure behavior as the Polygon one.
 *
 * Runs under Jest's ESM mode (see jest.config.base.ts) for the same reasons as
 * DidController.polygon.spec.ts — tsyringe and cliAgent are mocked so constructing the controller
 * does not require a real DI container / agent spin-up.
 */
import { jest } from '@jest/globals'

const noopDecorator = () => () => {}

// DidController resolves an Agent from the tsyringe container in a field initializer; stub the
// container so construction succeeds without a real DI graph. Keep the decorators as no-ops.
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
    resolve: jest.fn(() => ({})),
    register: jest.fn(),
    registerInstance: jest.fn(),
    isRegistered: jest.fn(() => false),
  },
}))

// Avoid spinning up the agent module graph (express + native bindings) on import.
jest.unstable_mockModule('../../../cliAgent', () => ({}))

const { DidController } = await import('../DidController')
const { BadRequestError, InternalServerError } = await import('../../../errors')
const { RecordNotFoundError } = await import('@credo-ts/core')

const VALID_PRIVATE_KEY = 'a'.repeat(64)

type MockAgent = {
  dids: { create: jest.Mock }
  dependencyManager: { resolve: jest.Mock }
  context: unknown
  _didRepository: { findByQuery: jest.Mock; delete: jest.Mock }
}

// By default, findByQuery reports exactly the one record the create() call itself just made --
// the "no duplicate" case every pre-existing test in this file implicitly relies on now that
// handleEthereum always checks after a successful create. Pass existingRecords to model a
// wallet that already had a DidRecord for this exact derived did:ethr identity before this call.
const makeAgent = (
  createResult: unknown,
  existingRecords?: { did: string; createdAt: Date; id?: string }[],
): MockAgent => {
  const createdDid = (createResult as { didState?: { did?: string } })?.didState?.did
  const findByQuery = jest.fn(
    async () => existingRecords ?? (createdDid ? [{ did: createdDid, createdAt: new Date() }] : []),
  ) as jest.Mock
  const deleteRecord = jest.fn(async () => undefined) as jest.Mock
  return {
    dids: { create: jest.fn(async () => createResult) as unknown as jest.Mock },
    dependencyManager: { resolve: jest.fn(() => ({ findByQuery, delete: deleteRecord })) as jest.Mock },
    context: {},
    _didRepository: { findByQuery, delete: deleteRecord },
  }
}

const ethereumOptions = (overrides: Record<string, unknown> = {}) =>
  ({
    method: 'ethr',
    network: 'ethr:sepolia',
    privatekey: VALID_PRIVATE_KEY,
    endpoint: 'https://example.test',
    ...overrides,
  }) as never

describe('DidController.handleEthereum', () => {
  let controller: InstanceType<typeof DidController>

  beforeEach(() => {
    controller = new DidController()
  })

  it('throws for a network that is neither mainnet nor sepolia, without calling the agent', async () => {
    const agent = makeAgent({ didState: { state: 'finished' } })

    await expect(
      controller.handleEthereum(agent as never, ethereumOptions({ network: 'ethr:goerli' })),
    ).rejects.toBeInstanceOf(BadRequestError)
    expect(agent.dids.create).not.toHaveBeenCalled()
  })

  it('rejects with BadRequestError for an invalid private key before calling the agent', async () => {
    const agent = makeAgent({ didState: { state: 'finished' } })

    await expect(
      controller.handleEthereum(agent as never, ethereumOptions({ privatekey: 'too-short' })),
    ).rejects.toBeInstanceOf(BadRequestError)
    expect(agent.dids.create).not.toHaveBeenCalled()
  })

  it('throws InternalServerError carrying the registrar reason when didState.state is "failed"', async () => {
    const agent = makeAgent({ didState: { state: 'failed', reason: 'RPC request failed' } })

    await expect(controller.handleEthereum(agent as never, ethereumOptions())).rejects.toMatchObject({
      message: 'Failed to create did:ethr: RPC request failed',
    })
    await expect(controller.handleEthereum(agent as never, ethereumOptions())).rejects.toBeInstanceOf(
      InternalServerError,
    )
  })

  it('falls back to "Unknown error" when a failed didState has no reason', async () => {
    const agent = makeAgent({ didState: { state: 'failed' } })

    await expect(controller.handleEthereum(agent as never, ethereumOptions())).rejects.toMatchObject({
      message: 'Failed to create did:ethr: Unknown error',
    })
  })

  it('sends the sepolia network name as-is and returns { did, didDocument }', async () => {
    const didDocument = { id: 'did:ethr:sepolia:0xabc' }
    const agent = makeAgent({ didState: { state: 'finished', did: 'did:ethr:sepolia:0xabc', didDocument } })

    const result = await controller.handleEthereum(agent as never, ethereumOptions())

    expect(agent.dids.create).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'ethr',
        options: expect.objectContaining({ network: 'sepolia' }),
      }),
    )
    expect(result).toEqual({ did: 'did:ethr:sepolia:0xabc', didDocument })
  })

  it('sends the mainnet network name as an empty string (registrar convention)', async () => {
    const agent = makeAgent({ didState: { state: 'finished', did: 'did:ethr:mainnet:0xabc', didDocument: {} } })

    await controller.handleEthereum(agent as never, ethereumOptions({ network: 'ethr:mainnet' }))

    expect(agent.dids.create).toHaveBeenCalledWith(
      expect.objectContaining({ options: expect.objectContaining({ network: '' }) }),
    )
  })

  it('uses the passed-in agent, not a shared instance field, to create the DID (multi-tenancy)', async () => {
    const agentA = makeAgent({ didState: { state: 'finished', did: 'did:ethr:sepolia:0xaaa', didDocument: {} } })
    const agentB = makeAgent({ didState: { state: 'finished', did: 'did:ethr:sepolia:0xbbb', didDocument: {} } })

    await controller.handleEthereum(agentA as never, ethereumOptions())
    await controller.handleEthereum(agentB as never, ethereumOptions())

    expect(agentA.dids.create).toHaveBeenCalledTimes(1)
    expect(agentB.dids.create).toHaveBeenCalledTimes(1)
  })

  // EthrDidRegistrar.create() unconditionally saves a new DidRecord regardless of whether one
  // already exists for the same derived identity (the same private key always derives the same
  // did:ethr address) -- confirmed in production: this silently left two "created" DidRecord rows
  // for the identical did, invisible until something else looked the DID up later (e.g. schema
  // creation's getPublicKeyFromDid -> Credo's own findCreatedDid), which throws "Multiple records
  // found" since it expects exactly one match.
  it('rolls back and rejects when the wallet already had a DidRecord for this exact derived identity', async () => {
    const did = 'did:ethr:sepolia:0xabc'
    const existingRecord = { did, createdAt: new Date('2026-01-01') }
    const justCreatedRecord = { did, createdAt: new Date('2026-06-01') }
    const agent = makeAgent({ didState: { state: 'finished', did, didDocument: {} } }, [
      existingRecord,
      justCreatedRecord,
    ])

    await expect(controller.handleEthereum(agent as never, ethereumOptions())).rejects.toBeInstanceOf(BadRequestError)

    // Only the newer (just-created) duplicate is rolled back -- the original record is preserved.
    expect(agent._didRepository.delete).toHaveBeenCalledTimes(1)
    expect(agent._didRepository.delete).toHaveBeenCalledWith(agent.context, justCreatedRecord)
  })

  // Two genuinely concurrent duplicate-creation calls can both see the same duplicate set and
  // both try to delete the same record -- whichever loses the race hits Askar's own
  // RecordNotFoundError, not a real failure. That must not leak past the intended 400.
  it('still rejects with BadRequestError, not the underlying error, when a concurrent call already deleted the duplicate', async () => {
    const did = 'did:ethr:sepolia:0xabc'
    const existingRecord = { did, createdAt: new Date('2026-01-01') }
    const justCreatedRecord = { did, createdAt: new Date('2026-06-01') }
    const agent = makeAgent({ didState: { state: 'finished', did, didDocument: {} } }, [
      existingRecord,
      justCreatedRecord,
    ])
    ;(agent._didRepository.delete as jest.Mock<() => Promise<never>>).mockRejectedValueOnce(
      new RecordNotFoundError('already deleted', { recordType: 'DidRecord' }),
    )

    await expect(controller.handleEthereum(agent as never, ethereumOptions())).rejects.toBeInstanceOf(BadRequestError)
  })

  // createdAt has millisecond resolution -- two records created within the same millisecond
  // compare equal, and Askar's scan gives no ordering guarantee, so the same two records can come
  // back as [A, B] from one query and [B, A] from another. Without a deterministic tie-breaker,
  // each racing caller would delete a *different* record, deleting both and leaving the wallet
  // with no created record for this DID at all -- worse than the original bug. `id` must break
  // the tie the same way regardless of the order findByQuery returns records in.
  it('picks the same record to delete regardless of query order, when two records share the exact same createdAt', async () => {
    const did = 'did:ethr:sepolia:0xabc'
    const sameInstant = new Date('2026-06-01T00:00:00.000Z')
    const recordA = { did, createdAt: sameInstant, id: 'aaaa' }
    const recordB = { did, createdAt: sameInstant, id: 'bbbb' }

    const agentQueryOrderAB = makeAgent({ didState: { state: 'finished', did, didDocument: {} } }, [recordA, recordB])
    await expect(controller.handleEthereum(agentQueryOrderAB as never, ethereumOptions())).rejects.toBeInstanceOf(
      BadRequestError,
    )
    expect(agentQueryOrderAB._didRepository.delete).toHaveBeenCalledWith(agentQueryOrderAB.context, recordB)

    const agentQueryOrderBA = makeAgent({ didState: { state: 'finished', did, didDocument: {} } }, [recordB, recordA])
    await expect(controller.handleEthereum(agentQueryOrderBA as never, ethereumOptions())).rejects.toBeInstanceOf(
      BadRequestError,
    )
    expect(agentQueryOrderBA._didRepository.delete).toHaveBeenCalledWith(agentQueryOrderBA.context, recordB)
  })

  it('does not roll back or reject when the create call is the only record for this did (the common case)', async () => {
    const did = 'did:ethr:sepolia:0xdef'
    const agent = makeAgent({ didState: { state: 'finished', did, didDocument: {} } })

    const result = await controller.handleEthereum(agent as never, ethereumOptions())

    expect(agent._didRepository.delete).not.toHaveBeenCalled()
    expect(result).toEqual({ did, didDocument: {} })
  })
})
