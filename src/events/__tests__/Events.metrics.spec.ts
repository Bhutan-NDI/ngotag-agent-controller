/**
 * The DIDComm event handlers count every state change by state, and a finished proof exchange by
 * whether the presentation verified. Labels are the state and the verdict only -- never a tenant,
 * connection or record id. WebhookEvent and WebSocketEvents are stubbed so no network I/O occurs.
 */
import { jest } from '@jest/globals'
import { metrics } from '@opentelemetry/api'
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics'

const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE)
const reader = new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 3_600_000 })
metrics.setGlobalMeterProvider(new MeterProvider({ readers: [reader] }))

jest.unstable_mockModule('../WebhookEvent', () => ({ sendWebhookEvent: jest.fn(async () => {}) }))
jest.unstable_mockModule('../WebSocketEvents', () => ({ sendWebSocketEvent: jest.fn() }))

const { connectionEvents } = await import('../ConnectionEvents')
const { credentialEvents } = await import('../CredentialEvents')
const { proofEvents } = await import('../ProofEvents')
const { DidCommConnectionEventTypes, DidCommCredentialEventTypes, DidCommProofEventTypes, DidCommProofState } =
  await import('@credo-ts/didcomm')

type Handler = (event: unknown) => Promise<void>

const makeAgent = () => {
  const handlers = new Map<string, Handler>()
  const agent = {
    config: { logger: { warn: jest.fn(), error: jest.fn() } },
    events: { on: (type: string, handler: Handler) => handlers.set(type, handler) },
    modules: {
      didcomm: { proofs: { getFormatData: async () => ({}) }, credentials: { getFormatData: async () => ({}) } },
    },
  }
  return { agent, fire: (type: string, event: unknown) => handlers.get(type)?.(event) }
}

const config = { webhookUrl: 'http://platform.example/wh' }
const metadata = { contextCorrelationId: 'default' }

/** Cumulative value of one counter, keyed by its attributes. */
async function counter(name: string): Promise<Record<string, number>> {
  await reader.forceFlush()
  const out: Record<string, number> = {}
  for (const resourceMetrics of exporter.getMetrics()) {
    for (const scope of resourceMetrics.scopeMetrics) {
      for (const metric of scope.metrics) {
        if (metric.descriptor.name !== name) continue
        for (const point of metric.dataPoints) out[JSON.stringify(point.attributes)] = point.value as number
      }
    }
  }
  return out
}

describe('event metrics', () => {
  beforeEach(() => exporter.reset())

  it('counts connection state changes by state', async () => {
    const { agent, fire } = makeAgent()
    await connectionEvents(agent as never, config as never)
    const event = (state: string) => ({
      metadata,
      payload: { connectionRecord: { state, toJSON: () => ({ id: 'c-1', state }) } },
    })

    await fire(DidCommConnectionEventTypes.DidCommConnectionStateChanged, event('request-sent'))
    await fire(DidCommConnectionEventTypes.DidCommConnectionStateChanged, event('completed'))
    await fire(DidCommConnectionEventTypes.DidCommConnectionStateChanged, event('completed'))

    expect(await counter('credo.didcomm.connection.state_changes')).toEqual({
      '{"state":"request-sent"}': 1,
      '{"state":"completed"}': 2,
    })
  })

  it('counts credential exchange state changes by state', async () => {
    const { agent, fire } = makeAgent()
    await credentialEvents(agent as never, config as never)

    await fire(DidCommCredentialEventTypes.DidCommCredentialStateChanged, {
      metadata,
      payload: { credentialExchangeRecord: { id: 'x', state: 'offer-sent', toJSON: () => ({ id: 'x' }) } },
    })

    expect(await counter('credo.didcomm.credential.state_changes')).toEqual({ '{"state":"offer-sent"}': 1 })
  })

  it('counts a finished proof by whether it verified, and leaves unfinished ones out of that count', async () => {
    const { agent, fire } = makeAgent()
    await proofEvents(agent as never, config as never)
    const event = (state: string, isVerified?: boolean) => ({
      metadata,
      payload: { proofRecord: { id: 'p-1', state, isVerified, toJSON: () => ({ id: 'p-1', state }) } },
    })

    await fire(DidCommProofEventTypes.ProofStateChanged, event(DidCommProofState.PresentationReceived))
    await fire(DidCommProofEventTypes.ProofStateChanged, event(DidCommProofState.Done, true))
    await fire(DidCommProofEventTypes.ProofStateChanged, event(DidCommProofState.Done, false))
    await fire(DidCommProofEventTypes.ProofStateChanged, event(DidCommProofState.Done, undefined))

    expect(await counter('credo.didcomm.proof.verifications')).toEqual({
      '{"verified":true}': 1,
      '{"verified":false}': 1,
    })
    expect(Object.values(await counter('credo.didcomm.proof.state_changes')).reduce((a, b) => a + b, 0)).toBe(4)
  })
})
