/**
 * Regression tests for the did:polygon path of DidController.handlePolygon.
 *
 * The Polygon registrar never throws on failure; it returns didState.state === 'failed' with a
 * reason. handlePolygon must surface that reason as an InternalServerError instead of silently
 * returning an undefined did, so partial-state failures (e.g. ledger write failed) are reported
 * and the caller can safely retry. See fix/polygon-did-creation-idempotent-retry.
 *
 * Runs under Jest's ESM mode (see jest.config.base.ts) because the controller's dependency graph
 * is native ESM. tsyringe and cliAgent are mocked so constructing the controller does not require a
 * real DI container / agent spin-up.
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

const polygonOptions = (overrides: Record<string, unknown> = {}) =>
  ({ method: 'polygon', network: 'polygon:testnet', privatekey: VALID_PRIVATE_KEY, ...overrides }) as never

describe('DidController.handlePolygon', () => {
  let controller: InstanceType<typeof DidController>

  beforeEach(() => {
    controller = new DidController()
  })

  it('throws InternalServerError carrying the registrar reason when didState.state is "failed"', async () => {
    const agent = makeAgent({ didState: { state: 'failed', reason: 'Insufficient balance in wallet' } })

    await expect(controller.handlePolygon(agent as never, polygonOptions())).rejects.toMatchObject({
      message: 'Failed to create did:polygon: Insufficient balance in wallet',
    })
    await expect(controller.handlePolygon(agent as never, polygonOptions())).rejects.toBeInstanceOf(InternalServerError)
  })

  it('falls back to "Unknown error" when a failed didState has no reason', async () => {
    const agent = makeAgent({ didState: { state: 'failed' } })

    await expect(controller.handlePolygon(agent as never, polygonOptions())).rejects.toMatchObject({
      message: 'Failed to create did:polygon: Unknown error',
    })
  })

  it('returns { did, didDocument } when the registrar reports state "finished"', async () => {
    const didDocument = { id: 'did:polygon:testnet:0xabc' }
    const agent = makeAgent({ didState: { state: 'finished', did: 'did:polygon:testnet:0xabc', didDocument } })

    const result = await controller.handlePolygon(agent as never, polygonOptions())

    expect(result).toEqual({ did: 'did:polygon:testnet:0xabc', didDocument })
  })

  it('rejects with BadRequestError for an invalid private key before calling the agent', async () => {
    const agent = makeAgent({ didState: { state: 'finished' } })

    await expect(
      controller.handlePolygon(agent as never, polygonOptions({ privatekey: 'too-short' })),
    ).rejects.toBeInstanceOf(BadRequestError)
    expect(agent.dids.create).not.toHaveBeenCalled()
  })
})
