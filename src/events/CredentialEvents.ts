import type { RestMultiTenantAgentModules } from '../cliAgent'
import type { ServerConfig } from '../utils/ServerConfig'
import type { Agent, CredentialStateChangedEvent } from '@credo-ts/core'

import { CredentialEventTypes, CredentialState, LogLevel } from '@credo-ts/core'

import { emitStructured, makeSpanId, monoNow, durationMs } from '../utils/StructuredLogger'
import { withInstrumentedTenantAgent } from '../instrumentation/tenantInstrumented'
import { recordWebhookFire } from '../instrumentation/metrics'
import { requestContext } from '../instrumentation/requestContext'
import { sendWebSocketEvent } from './WebSocketEvents'
import { sendWebhookEvent } from './WebhookEvent'

export const credentialEvents = async (agent: Agent<RestMultiTenantAgentModules>, config: ServerConfig) => {
  agent.events.on(CredentialEventTypes.CredentialStateChanged, async (event: CredentialStateChangedEvent) => {
    const record = event.payload.credentialRecord
    const tenantId = event.metadata.contextCorrelationId ?? 'default'
    const threadId = record.threadId ?? ''
    const outerMsgId = requestContext.getStore()?.outerMsgId ?? ''

    emitStructured(LogLevel.info, {
      hop: 'controller.event.credential.state',
      flow: 'issuance',
      thread_id: threadId,
      outer_msg_id: outerMsgId,
      tenant_id: tenantId,
      conn_id: record.connectionId ?? '',
      credential_state: record.state,
    })

    const body: Record<string, unknown> = {
      ...record.toJSON(),
      ...event.metadata,
      outOfBandId: null,
      credentialData: null,
    }
    const handlerSpanId = makeSpanId()

    if (record.state === CredentialState.Done) {
      // For Done state, handler.entry/exit are placed inside (or around) the
      // session-acquire scope so handler.exit.duration_ms reflects only post-acquire
      // work — not the semaphore wait, which is already captured in
      // controller.session.acquire.end.duration_ms.
      try {
        if (tenantId !== 'default') {
          await withInstrumentedTenantAgent(agent, tenantId, 'issuance', async (tenantAgent) => {
            const handlerStart = monoNow()
            emitStructured(LogLevel.info, {
              hop: 'controller.handler.entry',
              flow: 'issuance',
              thread_id: threadId,
              outer_msg_id: outerMsgId,
              span_id: handlerSpanId,
              tenant_id: tenantId,
              conn_id: record.connectionId ?? '',
            })
            const [data, connectionRecord] = await Promise.all([
              tenantAgent.credentials.getFormatData(record.id),
              record.connectionId ? tenantAgent.connections.findById(record.connectionId) : Promise.resolve(null),
            ])
            body.credentialData = data
            body.outOfBandId = connectionRecord?.outOfBandId ?? null
            emitStructured(LogLevel.info, {
              hop: 'controller.handler.exit',
              flow: 'issuance',
              thread_id: threadId,
              outer_msg_id: outerMsgId,
              span_id: handlerSpanId,
              tenant_id: tenantId,
              conn_id: record.connectionId ?? '',
              duration_ms: durationMs(handlerStart),
              credential_state: record.state,
            })
          })
        } else {
          const handlerStart = monoNow()
          emitStructured(LogLevel.info, {
            hop: 'controller.handler.entry',
            flow: 'issuance',
            thread_id: threadId,
            outer_msg_id: outerMsgId,
            span_id: handlerSpanId,
            tenant_id: tenantId,
            conn_id: record.connectionId ?? '',
          })
          const [data, connectionRecord] = await Promise.all([
            agent.credentials.getFormatData(record.id),
            record.connectionId ? agent.connections.findById(record.connectionId) : Promise.resolve(null),
          ])
          body.credentialData = data
          body.outOfBandId = connectionRecord?.outOfBandId ?? null
          emitStructured(LogLevel.info, {
            hop: 'controller.handler.exit',
            flow: 'issuance',
            thread_id: threadId,
            outer_msg_id: outerMsgId,
            span_id: handlerSpanId,
            tenant_id: tenantId,
            conn_id: record.connectionId ?? '',
            duration_ms: durationMs(handlerStart),
            credential_state: record.state,
          })
        }
      } catch (error) {
        agent.config.logger.error(
          `Failed to get credential format data for record ${record.id}, continuing with base record`,
          { cause: error }
        )
        body.credentialData = null
        body.outOfBandId = null
      }
    } else {
      // Non-Done states: no session acquire involved — wrap the full (instant) handler.
      const handlerStart = monoNow()
      emitStructured(LogLevel.info, {
        hop: 'controller.handler.entry',
        flow: 'issuance',
        thread_id: threadId,
        outer_msg_id: outerMsgId,
        span_id: handlerSpanId,
        tenant_id: tenantId,
        conn_id: record.connectionId ?? '',
      })
      emitStructured(LogLevel.info, {
        hop: 'controller.handler.exit',
        flow: 'issuance',
        thread_id: threadId,
        outer_msg_id: outerMsgId,
        span_id: handlerSpanId,
        tenant_id: tenantId,
        conn_id: record.connectionId ?? '',
        duration_ms: durationMs(handlerStart),
        credential_state: record.state,
      })
    }

    // Only send webhook if webhook url is configured
    if (config.webhookUrl) {
      const webhookSpanId = makeSpanId()
      const webhookStart = monoNow()
      emitStructured(LogLevel.info, {
        hop: 'controller.webhook.fire.start',
        flow: 'issuance',
        thread_id: threadId,
        span_id: webhookSpanId,
        tenant_id: tenantId,
        target_url: config.webhookUrl + '/credentials',
      })
      recordWebhookFire()
      sendWebhookEvent(config.webhookUrl + '/credentials', body, agent.config.logger)
      emitStructured(LogLevel.info, {
        hop: 'controller.webhook.fire.end',
        flow: 'issuance',
        thread_id: threadId,
        span_id: webhookSpanId,
        tenant_id: tenantId,
        duration_ms: durationMs(webhookStart),
        notes: 'fire-and-forget — timing is dispatch not delivery',
      })
    }

    if (config.socketServer) {
      // Always emit websocket event to clients (could be 0)
      sendWebSocketEvent(config.socketServer, {
        ...event,
        payload: {
          ...event.payload,
          credentialRecord: body,
        },
      })
    }
  })
}
