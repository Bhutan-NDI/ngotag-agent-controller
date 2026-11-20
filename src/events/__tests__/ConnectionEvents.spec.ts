/**
 * ConnectionEvents: a connection state change is published as before, and a DID rotation to its own
 * `/connections/did-rotated` endpoint with a `didRotated` field. WebhookEvent and WebSocketEvents are stubbed so no network I/O occurs.
 */
import { jest } from '@jest/globals'

jest.unstable_mockModule('../WebhookEvent', () => ({ sendWebhookEvent: jest.fn(async () => {}) }))
jest.unstable_mockModule('../WebSocketEvents', () => ({ sendWebSocketEvent: jest.fn() }))

const { connectionEvents } = await import('../ConnectionEvents')
const { sendWebhookEvent } = await import('../WebhookEvent')
const { sendWebSocketEvent } = await import('../WebSocketEvents')
const { DidCommConnectionEventTypes } = await import('@credo-ts/didcomm')

const WEBHOOK_URL = 'http://platform.example/wh/org-1'

const record = (overrides: object = {}) => ({
  toJSON: () => ({ id: 'conn-1', state: 'completed', did: 'did:peer:ours', theirDid: 'did:peer:theirs', ...overrides }),
})

const setup = async (config: { webhookUrl?: string; socketServer?: object }) => {
  const handlers = new Map<string, (event: unknown) => Promise<void>>()
  const agent = {
    config: { logger: {} },
    events: { on: (type: string, handler: (event: unknown) => Promise<void>) => handlers.set(type, handler) },
  }
  await connectionEvents(agent as never, config as never)
  return { fire: (type: string, event: unknown) => handlers.get(type)?.(event) }
}

describe('connectionEvents', () => {
  beforeEach(() => {
    jest.mocked(sendWebhookEvent).mockClear()
    jest.mocked(sendWebSocketEvent).mockClear()
  })

  it('publishes a state change exactly as before: the record plus the event metadata, with no didRotated field', async () => {
    const { fire } = await setup({ webhookUrl: WEBHOOK_URL })

    await fire(DidCommConnectionEventTypes.DidCommConnectionStateChanged, {
      metadata: { contextCorrelationId: 'ctx-1' },
      payload: { connectionRecord: record(), previousState: 'request-sent' },
    })

    expect(sendWebhookEvent).toHaveBeenCalledWith(
      `${WEBHOOK_URL}/connections`,
      {
        id: 'conn-1',
        state: 'completed',
        did: 'did:peer:ours',
        theirDid: 'did:peer:theirs',
        contextCorrelationId: 'ctx-1',
      },
      expect.anything(),
    )
  })

  it('publishes a DID rotation to its own endpoint, carrying the connection as it now is and the old and new DID', async () => {
    const { fire } = await setup({ webhookUrl: WEBHOOK_URL })

    await fire(DidCommConnectionEventTypes.DidCommConnectionDidRotated, {
      metadata: { contextCorrelationId: 'ctx-1' },
      payload: {
        connectionRecord: record({ did: 'did:peer:new' }),
        ourDid: { from: 'did:peer:ours', to: 'did:peer:new' },
      },
    })

    expect(sendWebhookEvent).toHaveBeenCalledWith(
      `${WEBHOOK_URL}/connections/did-rotated`,
      {
        id: 'conn-1',
        state: 'completed',
        did: 'did:peer:new',
        theirDid: 'did:peer:theirs',
        contextCorrelationId: 'ctx-1',
        didRotated: { ourDid: { from: 'did:peer:ours', to: 'did:peer:new' }, theirDid: undefined },
      },
      expect.anything(),
    )
  })

  it('never publishes a DID rotation, or anything about one, to /connections', async () => {
    const { fire } = await setup({ webhookUrl: WEBHOOK_URL })

    await fire(DidCommConnectionEventTypes.DidCommConnectionDidRotated, {
      metadata: {},
      payload: { connectionRecord: record(), ourDid: { from: 'a', to: 'b' } },
    })

    const urls = jest.mocked(sendWebhookEvent).mock.calls.map(([url]) => url)
    expect(urls).toEqual([`${WEBHOOK_URL}/connections/did-rotated`])
  })

  it('publishes a hangup, which Credo reports with neither DID, on the rotation endpoint with an empty didRotated', async () => {
    const { fire } = await setup({ webhookUrl: WEBHOOK_URL })

    await fire(DidCommConnectionEventTypes.DidCommConnectionDidRotated, {
      metadata: { contextCorrelationId: 'ctx-1' },
      payload: { connectionRecord: record({ theirDid: undefined }) },
    })

    expect(sendWebhookEvent).toHaveBeenCalledTimes(1)
    const [url, body] = jest.mocked(sendWebhookEvent).mock.calls[0]
    expect(url).toBe(`${WEBHOOK_URL}/connections/did-rotated`)
    expect(body.didRotated).toEqual({ ourDid: undefined, theirDid: undefined })
  })

  it("reports a rotation of the other side's DID as theirDid", async () => {
    const { fire } = await setup({ webhookUrl: WEBHOOK_URL })

    await fire(DidCommConnectionEventTypes.DidCommConnectionDidRotated, {
      metadata: {},
      payload: { connectionRecord: record(), theirDid: { from: 'did:peer:a', to: 'did:peer:b' } },
    })

    const [, body] = jest.mocked(sendWebhookEvent).mock.calls[0]
    expect(body.didRotated).toEqual({ ourDid: undefined, theirDid: { from: 'did:peer:a', to: 'did:peer:b' } })
  })

  it('sends no webhook when none is configured, but still tells websocket clients', async () => {
    const socketServer = {}
    const { fire } = await setup({ socketServer })

    await fire(DidCommConnectionEventTypes.DidCommConnectionDidRotated, {
      metadata: {},
      payload: { connectionRecord: record(), ourDid: { from: 'a', to: 'b' } },
    })

    expect(sendWebhookEvent).not.toHaveBeenCalled()
    expect(sendWebSocketEvent).toHaveBeenCalledWith(
      socketServer,
      expect.objectContaining({
        payload: expect.objectContaining({
          connectionRecord: expect.objectContaining({ didRotated: expect.any(Object) }),
        }),
      }),
    )
  })
})
