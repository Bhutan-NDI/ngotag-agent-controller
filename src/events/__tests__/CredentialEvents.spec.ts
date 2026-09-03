/**
 * Regression tests for CredentialEvents.ts. Locks in:
 *
 *   1. Tenant-session-leak fix — the tenant format-data / connection lookup goes through
 *      withTenantAgent() (session scoped to the callback, released on exit), never getTenantAgent().
 *
 *   2. The webhook/socket payload gates `credentialData` and `outOfBandId` on the terminal `Done`
 *      state: both are `null` (and no getFormatData / findById call is made) for every non-Done
 *      state, and only populated on `Done`. Webhook emission is fire-and-forget.
 *
 * Runs under Jest ESM mode (see jest.config.base.ts). WebhookEvent and WebSocketEvents are stubbed
 * so no network I/O occurs.
 */
import { jest } from '@jest/globals'

jest.unstable_mockModule('../WebhookEvent', () => ({
  sendWebhookEvent: jest.fn(async () => {}),
}))

jest.unstable_mockModule('../WebSocketEvents', () => ({
  sendWebSocketEvent: jest.fn(),
}))

const { credentialEvents } = await import('../CredentialEvents')
const { sendWebhookEvent } = await import('../WebhookEvent')
const { sendWebSocketEvent } = await import('../WebSocketEvents')
const { DidCommCredentialState } = await import('@credo-ts/didcomm')

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TENANT_FORMAT_DATA = { credential: 'tenant-credential' }
const DEFAULT_FORMAT_DATA = { credential: 'default-credential' }
const TENANT_OOB_ID = 'oob-tenant'
const DEFAULT_OOB_ID = 'oob-default'
const WEBHOOK_URL = 'http://example.com/webhook'
const DONE = DidCommCredentialState.Done
const NON_DONE = DidCommCredentialState.CredentialReceived // any pre-terminal state

// The handler reads `record.state` (property) for the gate and spreads `record.toJSON()` into the
// body, so both carry the same state.
function makeCredentialEvent(contextCorrelationId: string | undefined, state: string = NON_DONE) {
  return {
    metadata: { contextCorrelationId },
    payload: {
      credentialExchangeRecord: {
        id: 'cred-record-id',
        state,
        connectionId: 'conn-1',
        toJSON: () => ({ id: 'cred-record-id', state }),
      },
    },
  }
}

type TenantAgent = {
  modules: {
    didcomm: {
      credentials: { getFormatData: jest.Mock }
      connections: { findById: jest.Mock }
    }
  }
}

const makeTenantAgent = (formatData: unknown, oobId: string): TenantAgent => ({
  modules: {
    didcomm: {
      credentials: { getFormatData: jest.fn(async () => formatData) as jest.Mock },
      connections: { findById: jest.fn(async () => ({ outOfBandId: oobId })) as jest.Mock },
    },
  },
})

type MockAgent = {
  events: { on: jest.Mock }
  modules: {
    tenants: { withTenantAgent: jest.Mock; getTenantAgent: jest.Mock }
    didcomm: {
      credentials: { getFormatData: jest.Mock }
      connections: { findById: jest.Mock }
    }
  }
  config: { logger: { info: jest.Mock; warn: jest.Mock; error: jest.Mock; debug: jest.Mock } }
}

const makeAgent = (): MockAgent => ({
  events: { on: jest.fn() },
  modules: {
    tenants: {
      withTenantAgent: jest.fn(async ({ tenantId }: { tenantId: string }, cb: (a: TenantAgent) => Promise<void>) => {
        await cb(makeTenantAgent(TENANT_FORMAT_DATA, TENANT_OOB_ID))
      }) as jest.Mock,
      // Deliberately present so we can assert it is NEVER called.
      getTenantAgent: jest.fn(),
    },
    didcomm: {
      credentials: { getFormatData: jest.fn(async () => DEFAULT_FORMAT_DATA) as jest.Mock },
      connections: { findById: jest.fn(async () => ({ outOfBandId: DEFAULT_OOB_ID })) as jest.Mock },
    },
  },
  config: {
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  },
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('credentialEvents', () => {
  let agent: MockAgent
  let capturedListener: (event: ReturnType<typeof makeCredentialEvent>) => Promise<void>

  beforeEach(async () => {
    jest.clearAllMocks()
    agent = makeAgent()
    agent.events.on.mockImplementation((_eventType, listener) => {
      capturedListener = listener as typeof capturedListener
    })
    await credentialEvents(agent as never, { port: 3000, webhookUrl: WEBHOOK_URL })
  })

  it('registers a listener for DidCommCredentialStateChanged', () => {
    expect(agent.events.on).toHaveBeenCalledWith('DidCommCredentialStateChanged', expect.any(Function))
  })

  describe('gate: non-Done state (credential-received)', () => {
    it('tenant — emits null credentialData/outOfBandId and never fetches format data', async () => {
      await capturedListener(makeCredentialEvent('tenant-abc123', NON_DONE))

      expect(agent.modules.tenants.withTenantAgent).not.toHaveBeenCalled()
      expect(agent.modules.tenants.getTenantAgent).not.toHaveBeenCalled()
      expect(jest.mocked(sendWebhookEvent)).toHaveBeenCalledWith(
        `${WEBHOOK_URL}/credentials`,
        expect.objectContaining({ credentialData: null, outOfBandId: null }),
        expect.anything(),
      )
    })

    it('default — emits null credentialData/outOfBandId and does not call getFormatData/findById', async () => {
      await capturedListener(makeCredentialEvent('default', NON_DONE))

      expect(agent.modules.didcomm.credentials.getFormatData).not.toHaveBeenCalled()
      expect(agent.modules.didcomm.connections.findById).not.toHaveBeenCalled()
      expect(jest.mocked(sendWebhookEvent)).toHaveBeenCalledWith(
        `${WEBHOOK_URL}/credentials`,
        expect.objectContaining({ credentialData: null, outOfBandId: null }),
        expect.anything(),
      )
    })
  })

  describe('Done state — tenant event (contextCorrelationId = "tenant-abc123")', () => {
    beforeEach(async () => {
      await capturedListener(makeCredentialEvent('tenant-abc123', DONE))
    })

    it('uses withTenantAgent to scope the session — never getTenantAgent', () => {
      expect(agent.modules.tenants.withTenantAgent).toHaveBeenCalledTimes(1)
      expect(agent.modules.tenants.getTenantAgent).not.toHaveBeenCalled()
    })

    it('strips the "tenant-" prefix before passing tenantId to withTenantAgent', () => {
      expect(agent.modules.tenants.withTenantAgent).toHaveBeenCalledWith({ tenantId: 'abc123' }, expect.any(Function))
    })

    it('emits the webhook payload with credentialData and outOfBandId populated', () => {
      expect(jest.mocked(sendWebhookEvent)).toHaveBeenCalledWith(
        `${WEBHOOK_URL}/credentials`,
        expect.objectContaining({ credentialData: TENANT_FORMAT_DATA, outOfBandId: TENANT_OOB_ID }),
        expect.anything(),
      )
    })

    it('does not call the default-agent getFormatData', () => {
      expect(agent.modules.didcomm.credentials.getFormatData).not.toHaveBeenCalled()
    })
  })

  describe('Done state — default agent event (contextCorrelationId = "default")', () => {
    beforeEach(async () => {
      await capturedListener(makeCredentialEvent('default', DONE))
    })

    it('calls getFormatData and connections.findById directly', () => {
      expect(agent.modules.didcomm.credentials.getFormatData).toHaveBeenCalledWith('cred-record-id')
      expect(agent.modules.didcomm.connections.findById).toHaveBeenCalledWith('conn-1')
    })

    it('does not open a tenant session', () => {
      expect(agent.modules.tenants.withTenantAgent).not.toHaveBeenCalled()
      expect(agent.modules.tenants.getTenantAgent).not.toHaveBeenCalled()
    })

    it('emits the webhook payload with credentialData and outOfBandId populated', () => {
      expect(jest.mocked(sendWebhookEvent)).toHaveBeenCalledWith(
        `${WEBHOOK_URL}/credentials`,
        expect.objectContaining({ credentialData: DEFAULT_FORMAT_DATA, outOfBandId: DEFAULT_OOB_ID }),
        expect.anything(),
      )
    })
  })

  describe('webhook and socket emission', () => {
    it('skips the webhook when webhookUrl is not configured', async () => {
      await credentialEvents(agent as never, { port: 3000 })
      await capturedListener(makeCredentialEvent('default', DONE))

      expect(jest.mocked(sendWebhookEvent)).not.toHaveBeenCalled()
    })

    it('emits a socket event when socketServer is configured', async () => {
      const socketServer = {} as never
      await credentialEvents(agent as never, { port: 3000, webhookUrl: WEBHOOK_URL, socketServer })
      await capturedListener(makeCredentialEvent('default', DONE))

      expect(jest.mocked(sendWebSocketEvent)).toHaveBeenCalledWith(
        socketServer,
        expect.objectContaining({
          payload: expect.objectContaining({
            credentialRecord: expect.objectContaining({ credentialData: DEFAULT_FORMAT_DATA }),
          }),
        }),
      )
    })

    it('skips the socket event when socketServer is not configured', async () => {
      await capturedListener(makeCredentialEvent('default', DONE))

      expect(jest.mocked(sendWebSocketEvent)).not.toHaveBeenCalled()
    })

    it('is fire-and-forget — the handler resolves without awaiting the webhook', async () => {
      jest.mocked(sendWebhookEvent).mockImplementationOnce(() => new Promise<void>(() => {}))

      await expect(capturedListener(makeCredentialEvent('default', DONE))).resolves.toBeUndefined()
    })
  })
})
