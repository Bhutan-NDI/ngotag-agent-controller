/**
 * Regression tests for ProofEvents.ts. Two behaviours are locked in here:
 *
 *   1. Tenant-session-leak fix — the tenant format-data fetch goes through withTenantAgent()
 *      (session scoped to the callback and released on exit), never getTenantAgent().
 *
 *   2. The webhook/socket payload gates `proofData` on the terminal `Done` state: it is `null`
 *      (and no getFormatData call is made) for every non-Done state, and only populated on `Done`.
 *      Webhook emission is fire-and-forget (not awaited).
 *
 * Runs under Jest ESM mode (see jest.config.base.ts) because the event module's dependency graph
 * is native ESM. WebhookEvent and WebSocketEvents are stubbed so no network I/O occurs.
 */
import { jest } from '@jest/globals'

jest.unstable_mockModule('../WebhookEvent', () => ({
  sendWebhookEvent: jest.fn(async () => {}),
}))

jest.unstable_mockModule('../WebSocketEvents', () => ({
  sendWebSocketEvent: jest.fn(),
}))

const { proofEvents } = await import('../ProofEvents')
const { sendWebhookEvent } = await import('../WebhookEvent')
const { sendWebSocketEvent } = await import('../WebSocketEvents')
const { DidCommProofState } = await import('@credo-ts/didcomm')

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TENANT_FORMAT_DATA = { presentation: 'tenant-presentation' }
const DEFAULT_FORMAT_DATA = { presentation: 'default-presentation' }
const WEBHOOK_URL = 'http://example.com/webhook'
const DONE = DidCommProofState.Done
const NON_DONE = DidCommProofState.PresentationReceived // any pre-terminal state

// The handler reads `record.state` (property) for the gate and spreads `record.toJSON()` into the
// body, so both carry the same state.
function makeProofEvent(contextCorrelationId: string | undefined, state: string = NON_DONE) {
  return {
    metadata: { contextCorrelationId },
    payload: {
      proofRecord: {
        id: 'proof-record-id',
        state,
        toJSON: () => ({ id: 'proof-record-id', state }),
      },
    },
  }
}

type TenantAgent = { modules: { didcomm: { proofs: { getFormatData: jest.Mock } } } }

const makeTenantAgent = (formatData: unknown): TenantAgent => ({
  modules: { didcomm: { proofs: { getFormatData: jest.fn(async () => formatData) as jest.Mock } } },
})

type MockAgent = {
  events: { on: jest.Mock }
  modules: {
    tenants: { withTenantAgent: jest.Mock; getTenantAgent: jest.Mock }
    didcomm: { proofs: { getFormatData: jest.Mock } }
  }
  config: { logger: { info: jest.Mock; warn: jest.Mock; error: jest.Mock; debug: jest.Mock } }
}

const makeAgent = (): MockAgent => ({
  events: { on: jest.fn() },
  modules: {
    tenants: {
      withTenantAgent: jest.fn(async ({ tenantId }: { tenantId: string }, cb: (a: TenantAgent) => Promise<void>) => {
        await cb(makeTenantAgent(TENANT_FORMAT_DATA))
      }) as jest.Mock,
      // Deliberately present so we can assert it is NEVER called.
      getTenantAgent: jest.fn(),
    },
    didcomm: {
      proofs: { getFormatData: jest.fn(async () => DEFAULT_FORMAT_DATA) as jest.Mock },
    },
  },
  config: {
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  },
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('proofEvents', () => {
  let agent: MockAgent
  // Populated by agent.events.on so individual tests can fire events directly.
  let capturedListener: (event: ReturnType<typeof makeProofEvent>) => Promise<void>

  beforeEach(async () => {
    jest.clearAllMocks()
    agent = makeAgent()
    agent.events.on.mockImplementation((_eventType, listener) => {
      capturedListener = listener as typeof capturedListener
    })
    await proofEvents(agent as never, { port: 3000, webhookUrl: WEBHOOK_URL })
  })

  it('registers a listener for ProofStateChanged', () => {
    expect(agent.events.on).toHaveBeenCalledWith('DidCommProofStateChanged', expect.any(Function))
  })

  describe('gate: non-Done state (presentation-received)', () => {
    it('tenant — emits proofData: null and never fetches format data', async () => {
      await capturedListener(makeProofEvent('tenant-abc123', NON_DONE))

      expect(agent.modules.tenants.withTenantAgent).not.toHaveBeenCalled()
      expect(agent.modules.tenants.getTenantAgent).not.toHaveBeenCalled()
      expect(jest.mocked(sendWebhookEvent)).toHaveBeenCalledWith(
        `${WEBHOOK_URL}/proofs`,
        expect.objectContaining({ proofData: null }),
        expect.anything(),
      )
    })

    it('default — emits proofData: null and does not call getFormatData', async () => {
      await capturedListener(makeProofEvent('default', NON_DONE))

      expect(agent.modules.didcomm.proofs.getFormatData).not.toHaveBeenCalled()
      expect(jest.mocked(sendWebhookEvent)).toHaveBeenCalledWith(
        `${WEBHOOK_URL}/proofs`,
        expect.objectContaining({ proofData: null }),
        expect.anything(),
      )
    })
  })

  describe('Done state — tenant event (contextCorrelationId = "tenant-abc123")', () => {
    beforeEach(async () => {
      await capturedListener(makeProofEvent('tenant-abc123', DONE))
    })

    it('uses withTenantAgent to scope the session — never getTenantAgent', () => {
      expect(agent.modules.tenants.withTenantAgent).toHaveBeenCalledTimes(1)
      expect(agent.modules.tenants.getTenantAgent).not.toHaveBeenCalled()
    })

    it('strips the "tenant-" prefix before passing tenantId to withTenantAgent', () => {
      expect(agent.modules.tenants.withTenantAgent).toHaveBeenCalledWith({ tenantId: 'abc123' }, expect.any(Function))
    })

    it('emits the webhook payload with proofData populated', () => {
      expect(jest.mocked(sendWebhookEvent)).toHaveBeenCalledWith(
        `${WEBHOOK_URL}/proofs`,
        expect.objectContaining({ proofData: TENANT_FORMAT_DATA }),
        expect.anything(),
      )
    })

    it('does not call the default-agent getFormatData', () => {
      expect(agent.modules.didcomm.proofs.getFormatData).not.toHaveBeenCalled()
    })
  })

  describe('Done state — default agent event (contextCorrelationId = "default")', () => {
    beforeEach(async () => {
      await capturedListener(makeProofEvent('default', DONE))
    })

    it('calls agent.modules.didcomm.proofs.getFormatData directly', () => {
      expect(agent.modules.didcomm.proofs.getFormatData).toHaveBeenCalledWith('proof-record-id')
    })

    it('does not open a tenant session', () => {
      expect(agent.modules.tenants.withTenantAgent).not.toHaveBeenCalled()
      expect(agent.modules.tenants.getTenantAgent).not.toHaveBeenCalled()
    })

    it('emits the webhook payload with proofData populated', () => {
      expect(jest.mocked(sendWebhookEvent)).toHaveBeenCalledWith(
        `${WEBHOOK_URL}/proofs`,
        expect.objectContaining({ proofData: DEFAULT_FORMAT_DATA }),
        expect.anything(),
      )
    })
  })

  describe('webhook and socket emission', () => {
    it('skips the webhook when webhookUrl is not configured', async () => {
      await proofEvents(agent as never, { port: 3000 })
      await capturedListener(makeProofEvent('default', DONE))

      expect(jest.mocked(sendWebhookEvent)).not.toHaveBeenCalled()
    })

    it('emits a socket event when socketServer is configured', async () => {
      const socketServer = {} as never
      await proofEvents(agent as never, { port: 3000, webhookUrl: WEBHOOK_URL, socketServer })
      await capturedListener(makeProofEvent('default', DONE))

      expect(jest.mocked(sendWebSocketEvent)).toHaveBeenCalledWith(
        socketServer,
        expect.objectContaining({
          payload: expect.objectContaining({
            proofRecord: expect.objectContaining({ proofData: DEFAULT_FORMAT_DATA }),
          }),
        }),
      )
    })

    it('skips the socket event when socketServer is not configured', async () => {
      await capturedListener(makeProofEvent('default', DONE))

      expect(jest.mocked(sendWebSocketEvent)).not.toHaveBeenCalled()
    })

    it('is fire-and-forget — the handler resolves without awaiting the webhook', async () => {
      // A webhook that never settles must not block the handler (emission uses `void`).
      jest.mocked(sendWebhookEvent).mockImplementationOnce(() => new Promise<void>(() => {}))

      await expect(capturedListener(makeProofEvent('default', DONE))).resolves.toBeUndefined()
    })
  })
})
