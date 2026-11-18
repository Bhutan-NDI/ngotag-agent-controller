import type { Attributes } from '@opentelemetry/api'

import { SpanStatusCode, metrics, trace } from '@opentelemetry/api'

// Both resolve to no-ops until OpenTelemetry is started (and always when OTEL_ENABLED is off), so
// everything here can be called unconditionally.
const tracer = trace.getTracer('credo-controller')
const meter = metrics.getMeter('credo-controller')

/**
 * Puts a failure on a span as name, message and stack only. HTTP and SSI libraries hang request
 * state (bearer tokens, bodies, wallet seeds) off their errors as own properties, and the logger
 * already refuses to serialise those; spans leave the process the same way logs do.
 */
export const recordFailure = (value: unknown, span = trace.getActiveSpan()) => {
  if (!(value instanceof Error)) return
  span?.recordException({ name: value.name, message: value.message, stack: value.stack })
}

/**
 * Runs `fn` inside a child span of whatever request is active, so a step that used to be one opaque
 * block in the request's trace shows up with its own duration. A throw marks the span failed and is
 * rethrown unchanged; the span's status carries no message, as that is where secrets would surface.
 *
 * Keep attribute values to ids and enums: they are exported as-is.
 */
export const withSpan = <T>(name: string, fn: () => Promise<T>, attributes?: Attributes): Promise<T> =>
  tracer.startActiveSpan(name, { attributes }, async (span) => {
    try {
      return await fn()
    } catch (error) {
      recordFailure(error, span)
      span.setStatus({ code: SpanStatusCode.ERROR })
      throw error
    } finally {
      span.end()
    }
  })

/** Tags the request's own (HTTP server) span, e.g. with the tenant it was authenticated as. */
export const tagRequestSpan = (key: string, value: string) => {
  trace.getActiveSpan()?.setAttribute(key, value)
}

// Metrics. Labels are small closed sets (a protocol state, an outcome) -- never a tenant, connection
// or record id, which would create a time series per tenant.

export const connectionStateChanges = meter.createCounter('credo.didcomm.connection.state_changes', {
  description: 'DIDComm connection records moving to a new state',
})

export const credentialStateChanges = meter.createCounter('credo.didcomm.credential.state_changes', {
  description: 'DIDComm credential exchange records moving to a new state',
})

export const proofStateChanges = meter.createCounter('credo.didcomm.proof.state_changes', {
  description: 'DIDComm proof exchange records moving to a new state',
})

export const proofVerifications = meter.createCounter('credo.didcomm.proof.verifications', {
  description: 'Completed proof exchanges, by whether the presentation verified',
})

export const webhookSends = meter.createCounter('credo.webhook.sends', {
  description: 'Webhook deliveries, by outcome (success, http_error, timeout, error)',
})

export const webhookDuration = meter.createHistogram('credo.webhook.duration', {
  description: 'Time to deliver a webhook, by outcome',
  unit: 'ms',
})

export const tenantAdmissionRejections = meter.createCounter('credo.tenant.admission_rejections', {
  description: 'Requests refused with 503 because no tenant session was available',
})

export const purgeRecordsDeleted = meter.createCounter('credo.purge.records_deleted', {
  description: 'Records the purge removed (parents and children), by dry-run or real',
})

export const purgeFailures = meter.createCounter('credo.purge.failures', {
  description: 'Records the purge failed to remove',
})

export const purgeDuration = meter.createHistogram('credo.purge.tenant_duration', {
  description: 'Time the purge spent on one tenant',
  unit: 'ms',
})
