/**
 * Regression tests for the tenant-session-leak fix in ProofEvents.ts.
 *
 * The core regression: getTenantAgent() acquires a wallet session without ever releasing it.
 * withTenantAgent() scopes the session to the callback and releases it on exit — including on
 * error. These tests lock that in so an accidental revert surfaces immediately.
 *
 * Also verifies that the webhook/socket payload is populated with proofData for both the tenant
 * and dedicated-agent code paths.
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TENANT_FORMAT_DATA = { presentation: 'tenant-presentation' }
const DEFAULT_FORMAT_DATA = { presentation: 'default-presentation' }
const WEBHOOK_URL = 'http://example.com/webhook'

function makeProofEvent(contextCorrelationId: string | undefined) {
  return {
    metadata: { contextCorrelationId },
    payload: {
      proofRecord: {
        id: 'proof-record-id',
        toJSON: () => ({ id: 'proof-record-id', state: 'presentation-received' }),
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
    agent.events.on.mockImplementation((_eventType: string, listener: typeof capturedListener) => {
      capturedListener = listener
    })
    await proofEvents(agent as never, { port: 3000, webhookUrl: WEBHOOK_URL })
  })

  it('registers a listener for ProofStateChanged', () => {
    expect(agent.events.on).toHaveBeenCalledWith('DidCommProofStateChanged', expect.any(Function))
  })

  describe('tenant event — contextCorrelationId = "tenant-abc123"', () => {
    beforeEach(async () => {
      await capturedListener(makeProofEvent('tenant-abc123'))
    })

    it('uses withTenantAgent to scope the session — never getTenantAgent', () => {
      expect(agent.modules.tenants.withTenantAgent).toHaveBeenCalledTimes(1)
      expect(agent.modules.tenants.getTenantAgent).not.toHaveBeenCalled()
    })

    it('strips the "tenant-" prefix before passing tenantId to withTenantAgent', () => {
      expect(agent.modules.tenants.withTenantAgent).toHaveBeenCalledWith(
        { tenantId: 'abc123' },
        expect.any(Function),
      )
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

  describe('default agent event — contextCorrelationId = "default"', () => {
    beforeEach(async () => {
      await capturedListener(makeProofEvent('default'))
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
      await capturedListener(makeProofEvent('default'))

      expect(jest.mocked(sendWebhookEvent)).not.toHaveBeenCalled()
    })

    it('emits a socket event when socketServer is configured', async () => {
      const socketServer = {} as never
      await proofEvents(agent as never, { port: 3000, webhookUrl: WEBHOOK_URL, socketServer })
      await capturedListener(makeProofEvent('default'))

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
      await capturedListener(makeProofEvent('default'))

      expect(jest.mocked(sendWebSocketEvent)).not.toHaveBeenCalled()
    })
  })
})
