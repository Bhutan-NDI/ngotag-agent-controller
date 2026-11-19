/**
 * Every webhook send is counted by outcome and timed, and delivery behaves exactly as before: a failed
 * or slow listener is logged and swallowed, never thrown. node-fetch is stubbed so no network I/O occurs.
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

const fetchMock = jest.fn<(...args: unknown[]) => Promise<unknown>>()
jest.unstable_mockModule('node-fetch', () => ({ default: fetchMock }))

const { sendWebhookEvent } = await import('../WebhookEvent')

const logger = { error: jest.fn() }

/** Cumulative counts of credo.webhook.sends by outcome. */
async function sendsByOutcome(): Promise<Record<string, number>> {
  await reader.forceFlush()
  const out: Record<string, number> = {}
  for (const resourceMetrics of exporter.getMetrics()) {
    for (const scope of resourceMetrics.scopeMetrics) {
      for (const metric of scope.metrics) {
        if (metric.descriptor.name !== 'credo.webhook.sends') continue
        for (const point of metric.dataPoints) out[String(point.attributes.outcome)] = point.value as number
      }
    }
  }
  return out
}

describe('sendWebhookEvent metrics', () => {
  beforeEach(() => {
    exporter.reset()
    logger.error.mockClear()
  })

  it('counts a delivered webhook as success', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true })
    await sendWebhookEvent('http://listener.example/hook', { type: 'x' }, logger as never)

    expect((await sendsByOutcome()).success).toBe(1)
  })

  it('counts a listener answering 5xx as http_error, without throwing or logging an error', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 503 })
    await expect(
      sendWebhookEvent('http://listener.example/hook', { type: 'x' }, logger as never),
    ).resolves.toBeUndefined()

    expect((await sendsByOutcome()).http_error).toBe(1)
    expect(logger.error).not.toHaveBeenCalled()
  })

  it('counts an aborted request as timeout and still logs it', async () => {
    fetchMock.mockRejectedValueOnce(Object.assign(new Error('aborted'), { name: 'AbortError' }))
    await sendWebhookEvent('http://listener.example/hook', { type: 'x' }, logger as never)

    expect((await sendsByOutcome()).timeout).toBe(1)
    expect(logger.error).toHaveBeenCalledTimes(1)
  })

  it('counts any other failure as error', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'))
    await sendWebhookEvent('http://listener.example/hook', { type: 'x' }, logger as never)

    expect((await sendsByOutcome()).error).toBe(1)
  })
})
