import type { RestMultiTenantAgentModules } from '../cliAgent'
import type { ServerConfig } from '../utils/ServerConfig'
import type { Agent, CredentialStateChangedEvent } from '@credo-ts/core'

import { CredentialEventTypes, CredentialState, LogLevel } from '@credo-ts/core'

import { emitStructured, makeSpanId, monoNow, durationMs } from '../utils/StructuredLogger'
import { withInstrumentedTenantAgent } from '../instrumentation/tenantInstrumented'
import { recordWebhookFire } from '../instrumentation/metrics'
import { sendWebSocketEvent } from './WebSocketEvents'
import { sendWebhookEvent } from './WebhookEvent'

export const credentialEvents = async (agent: Agent<RestMultiTenantAgentModules>, config: ServerConfig) => {
  agent.events.on(CredentialEventTypes.CredentialStateChanged, async (event: CredentialStateChangedEvent) => {
    const record = event.payload.credentialRecord
    const tenantId = event.metadata.contextCorrelationId ?? 'default'
    const threadId = record.threadId ?? ''

    emitStructured(LogLevel.info, {
      hop: 'controller.event.credential.state',
      flow: 'issuance',
      thread_id: threadId,
      outer_msg_id: '',
      tenant_id: tenantId,
      conn_id: record.connectionId ?? '',
      credential_state: record.state,
    })

    const handlerSpanId = makeSpanId()
    const handlerStart = monoNow()
    emitStructured(LogLevel.info, {
      hop: 'controller.handler.entry',
      flow: 'issuance',
      thread_id: threadId,
      outer_msg_id: '',
      span_id: handlerSpanId,
      tenant_id: tenantId,
      conn_id: record.connectionId ?? '',
    })

    const body: Record<string, unknown> = {
      ...record.toJSON(),
      ...event.metadata,
      outOfBandId: null,
      credentialData: null,
    }

    if (record.state === CredentialState.Done) {
      try {
        if (tenantId !== 'default') {
          await withInstrumentedTenantAgent(agent, tenantId, 'issuance', async (tenantAgent) => {
            const [data, connectionRecord] = await Promise.all([
              tenantAgent.credentials.getFormatData(record.id),
              record.connectionId ? tenantAgent.connections.findById(record.connectionId) : Promise.resolve(null),
            ])
            body.credentialData = data
            body.outOfBandId = connectionRecord?.outOfBandId ?? null
          })
        } else {
          const [data, connectionRecord] = await Promise.all([
            agent.credentials.getFormatData(record.id),
            record.connectionId ? agent.connections.findById(record.connectionId) : Promise.resolve(null),
          ])
          body.credentialData = data
          body.outOfBandId = connectionRecord?.outOfBandId ?? null
        }
      } catch (error) {
        agent.config.logger.error(
          `Failed to get credential format data for record ${record.id}, continuing with base record`,
          { cause: error }
        )
        body.credentialData = null
        body.outOfBandId = null
      }
    }

    emitStructured(LogLevel.info, {
      hop: 'controller.handler.exit',
      flow: 'issuance',
      thread_id: threadId,
      outer_msg_id: '',
      span_id: handlerSpanId,
      tenant_id: tenantId,
      conn_id: record.connectionId ?? '',
      duration_ms: durationMs(handlerStart),
      credential_state: record.state,
    })

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
