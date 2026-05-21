import type { RestMultiTenantAgentModules } from '../cliAgent'
import type { Agent } from '@credo-ts/core'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TenantAgent = any

import { LogLevel } from '@credo-ts/core'

import { emitStructured, makeSpanId, monoNow, durationMs } from '../utils/StructuredLogger'
import { sessionAcquireStart, sessionAcquireEnd, sessionAcquireFailed, sessionReleased } from './metrics'

type TenantCallback<T> = (tenantAgent: TenantAgent) => Promise<T>

export async function withInstrumentedTenantAgent<T>(
  agent: Agent<RestMultiTenantAgentModules>,
  tenantId: string,
  flow: 'issuance' | 'verification',
  callback: TenantCallback<T>
): Promise<T> {
  const resolveSpanId = makeSpanId()
  const resolveStart = monoNow()

  emitStructured(LogLevel.debug, {
    hop: 'controller.tenant.resolve.start',
    flow,
    span_id: resolveSpanId,
    tenant_id: tenantId,
    outer_msg_id: '',
  })

  // Session acquire timing starts before withTenantAgent (which blocks on the semaphore)
  const acquireSpanId = makeSpanId()
  const acquireStart = monoNow()
  sessionAcquireStart()

  emitStructured(LogLevel.info, {
    hop: 'controller.session.acquire.start',
    flow,
    span_id: acquireSpanId,
    tenant_id: tenantId,
    outer_msg_id: '',
  })

  // Tracks whether withTenantAgent entered the callback. If it throws before
  // doing so (timeout, invalid tenant), we must call sessionAcquireFailed()
  // instead of sessionReleased() to avoid phantom in-flight counts.
  let callbackEntered = false

  try {
    const result = await agent.modules.tenants.withTenantAgent({ tenantId }, async (tenantAgent) => {
      callbackEntered = true
      const waitMs = durationMs(acquireStart)
      sessionAcquireEnd(waitMs)

      emitStructured(LogLevel.info, {
        hop: 'controller.session.acquire.end',
        flow,
        span_id: acquireSpanId,
        tenant_id: tenantId,
        outer_msg_id: '',
        duration_ms: waitMs,
      })
      emitStructured(LogLevel.debug, {
        hop: 'controller.tenant.resolve.end',
        flow,
        span_id: resolveSpanId,
        tenant_id: tenantId,
        outer_msg_id: '',
        duration_ms: durationMs(resolveStart),
      })

      return callback(tenantAgent)
    })
    return result
  } catch (err) {
    if (!callbackEntered) {
      // withTenantAgent failed before the session was acquired (semaphore timeout,
      // invalid tenant, etc.). Decrement waiting without touching in-flight.
      sessionAcquireFailed()
      emitStructured(LogLevel.info, {
        hop: 'controller.session.acquire.end',
        flow,
        span_id: acquireSpanId,
        tenant_id: tenantId,
        outer_msg_id: '',
        duration_ms: durationMs(acquireStart),
        notes: `acquire_failed: ${String(err)}`,
      })
    }
    throw err
  } finally {
    if (callbackEntered) sessionReleased()
  }
}
