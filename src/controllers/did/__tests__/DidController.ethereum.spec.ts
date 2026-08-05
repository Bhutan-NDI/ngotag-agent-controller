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

const VALID_PRIVATE_KEY = 'a'.repeat(64)

type MockAgent = { dids: { create: jest.Mock } }

const makeAgent = (createResult: unknown): MockAgent => ({
  dids: { create: jest.fn(async () => createResult) as unknown as jest.Mock },
})

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
})
