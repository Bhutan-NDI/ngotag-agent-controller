/**
 * withSpan wraps a step of a request in its own span without changing what the step returns or
 * throws, and what reaches the span on failure is name, message and stack only -- HTTP libraries hang
 * bearer tokens and bodies off their errors, and spans leave the process like logs do.
 */
import { trace } from '@opentelemetry/api'
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base'

const exporter = new InMemorySpanExporter()
trace.setGlobalTracerProvider(new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }))

const { withSpan, tagRequestSpan } = await import('../telemetry')

describe('withSpan', () => {
  beforeEach(() => exporter.reset())

  it('returns the step result and ends a span carrying the name and attributes', async () => {
    const result = await withSpan('didcomm.oob.create_invitation', async () => 'invitation', { 'credo.test': 'x' })

    expect(result).toBe('invitation')
    const [span] = exporter.getFinishedSpans()
    expect(span.name).toBe('didcomm.oob.create_invitation')
    expect(span.attributes['credo.test']).toBe('x')
    expect(span.status.code).not.toBe(2) // not ERROR
  })

  it('rethrows the very same error and marks the span failed', async () => {
    const failure = new Error('wallet not found')

    await expect(
      withSpan('tenant.session.open', async () => {
        throw failure
      }),
    ).rejects.toBe(failure)

    const [span] = exporter.getFinishedSpans()
    expect(span.status.code).toBe(2) // ERROR
    expect(span.status.message).toBeUndefined()
    expect(span.events.map((e) => e.name)).toEqual(['exception'])
    expect(span.events[0].attributes?.['exception.message']).toBe('wallet not found')
  })

  it('records name, message and stack only: request state hung off an error never reaches the span', async () => {
    const leaky = Object.assign(new Error('upstream failed'), {
      config: { headers: { Authorization: 'Bearer SECRET_TOKEN' } },
      response: { data: 'SECRET_BODY' },
    })

    await expect(
      withSpan('x', async () => {
        throw leaky
      }),
    ).rejects.toThrow('upstream failed')

    expect(JSON.stringify(exporter.getFinishedSpans()[0].events)).not.toMatch(/SECRET/)
  })

  it('ends the span even when the step throws something that is not an Error', async () => {
    await expect(
      withSpan('x', async () => {
        throw 'just a string'
      }),
    ).rejects.toBe('just a string')

    expect(exporter.getFinishedSpans()).toHaveLength(1)
    expect(exporter.getFinishedSpans()[0].events).toHaveLength(0)
  })
})

describe('tagRequestSpan', () => {
  it('does nothing, and does not throw, when there is no active span', () => {
    expect(() => tagRequestSpan('credo.tenant.id', 't-1')).not.toThrow()
  })
})
