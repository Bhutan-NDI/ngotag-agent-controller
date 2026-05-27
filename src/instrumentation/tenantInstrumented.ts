import type { RestMultiTenantAgentModules } from '../cliAgent'
import type { Agent } from '@credo-ts/core'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TenantAgent = any

import { LogLevel } from '@credo-ts/core'

import { emitStructured, makeSpanId, monoNow, durationMs } from '../utils/StructuredLogger'
import { sessionAcquireStart, sessionAcquireEnd, sessionAcquireFailed, sessionReleased, getSessionPoolStats } from './metrics'
import { requestContext } from './requestContext'

type TenantCallback<T> = (tenantAgent: TenantAgent) => Promise<T>

export async function withInstrumentedTenantAgent<T>(
  agent: Agent<RestMultiTenantAgentModules>,
  tenantId: string,
  flow: 'issuance' | 'verification',
  callback: TenantCallback<T>
): Promise<T> {
  const resolveSpanId = makeSpanId()
  const resolveStart = monoNow()

  const jweFp = requestContext.getStore()?.jweFp ?? ''

  emitStructured(LogLevel.trace, {
    hop: 'controller.tenant.resolve.start',
    flow,
    span_id: resolveSpanId,
    tenant_id: tenantId,
    jwe_fp: jweFp,
  })

  // Session acquire timing starts before withTenantAgent (which blocks on the semaphore)
  const acquireSpanId = makeSpanId()
  const acquireStart = monoNow()
  sessionAcquireStart()

  emitStructured(LogLevel.trace, {
    hop: 'controller.session.acquire.start',
    flow,
    span_id: acquireSpanId,
    tenant_id: tenantId,
    jwe_fp: jweFp,
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
      const { sessionsInFlight, sessionsWaiting } = getSessionPoolStats()

      emitStructured(LogLevel.trace, {
        hop: 'controller.session.acquire.end',
        flow,
        span_id: acquireSpanId,
        tenant_id: tenantId,
        jwe_fp: jweFp,
        wait_ms: waitMs,
        duration_ms: waitMs,
        sessions_in_use: sessionsInFlight,
        sessions_waiting: sessionsWaiting,
      })
      emitStructured(LogLevel.trace, {
        hop: 'controller.tenant.resolve.end',
        flow,
        span_id: resolveSpanId,
        tenant_id: tenantId,
        jwe_fp: jweFp,
        duration_ms: durationMs(resolveStart),
      })

      // Measure first Askar access (wallet open / profile attach) for H8.
      const walletSpanId = makeSpanId()
      const walletStart = monoNow()
      emitStructured(LogLevel.trace, {
        hop: 'controller.wallet.open.start',
        flow,
        span_id: walletSpanId,
        tenant_id: tenantId,
      })
      // The first awaited operation in the callback triggers the wallet open.
      // We ping genericRecords as the lightest available read that forces it.
      try {
        await tenantAgent.genericRecords.getAll()
      } catch {
        // ignore — only measuring timing; the callback may not need genericRecords
      }
      emitStructured(LogLevel.trace, {
        hop: 'controller.wallet.open.end',
        flow,
        span_id: walletSpanId,
        tenant_id: tenantId,
        duration_ms: durationMs(walletStart),
      })

      return callback(tenantAgent)
    })
    return result
  } catch (err) {
    if (!callbackEntered) {
      // withTenantAgent failed before the session was acquired (semaphore timeout,
      // invalid tenant, etc.). Decrement waiting without touching in-flight.
      sessionAcquireFailed()
      emitStructured(LogLevel.trace, {
        hop: 'controller.session.acquire.end',
        flow,
        span_id: acquireSpanId,
        tenant_id: tenantId,
        jwe_fp: jweFp,
        duration_ms: durationMs(acquireStart),
        notes: `acquire_failed: ${String(err)}`,
      })
    }
    throw err
  } finally {
    if (callbackEntered) sessionReleased()
  }
}
