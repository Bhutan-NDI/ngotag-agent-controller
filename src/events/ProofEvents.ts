import type { RestMultiTenantAgentModules } from '../cliAgent'
import type { ServerConfig } from '../utils/ServerConfig'
import type { Agent, ProofStateChangedEvent } from '@credo-ts/core'

import { ProofEventTypes, ProofState, LogLevel } from '@credo-ts/core'

import { emitStructured, makeSpanId, monoNow, durationMs } from '../utils/StructuredLogger'
import { withInstrumentedTenantAgent } from '../instrumentation/tenantInstrumented'
import { recordWebhookFire } from '../instrumentation/metrics'
import { sendWebSocketEvent } from './WebSocketEvents'
import { sendWebhookEvent } from './WebhookEvent'

export const proofEvents = async (agent: Agent<RestMultiTenantAgentModules>, config: ServerConfig) => {
  agent.events.on(ProofEventTypes.ProofStateChanged, async (event: ProofStateChangedEvent) => {
    const record = event.payload.proofRecord
    const threadId = record.threadId
    const state = record.state
    const tenantId = event.metadata.contextCorrelationId ?? 'default'

    agent.config.logger.debug(
      `[ProofEvent] Proof state changed event received - threadId=${threadId}, state=${state}, contextCorrelationId=${tenantId}`
    )

    emitStructured(LogLevel.info, {
      hop: 'controller.event.proof.state',
      flow: 'verification',
      thread_id: threadId ?? '',
      outer_msg_id: '',
      tenant_id: tenantId,
      conn_id: record.connectionId ?? '',
      proof_state: state,
    })

    const handlerSpanId = makeSpanId()
    const handlerStart = monoNow()
    emitStructured(LogLevel.info, {
      hop: 'controller.handler.entry',
      flow: 'verification',
      thread_id: threadId ?? '',
      outer_msg_id: '',
      span_id: handlerSpanId,
      tenant_id: tenantId,
      conn_id: record.connectionId ?? '',
    })

    const body = { ...record.toJSON(), ...event.metadata } as { proofData?: any }

    if (record.state === ProofState.Done) {
      try {
        if (tenantId !== 'default') {
          await withInstrumentedTenantAgent(agent, tenantId, 'verification', async (tenantAgent) => {
            const data = await tenantAgent.proofs.getFormatData(record.id)
            body.proofData = data
            agent.config.logger.debug(
              `[ProofEvent] Fetched proof format data for tenant agent - threadId=${threadId}, state=${state}, tenantId=${tenantId}, data=${JSON.stringify(body)}`
            )
          })
        } else {
          const data = await agent.proofs.getFormatData(record.id)
          body.proofData = data
          agent.config.logger.debug(
            `[ProofEvent] Fetched proof format data for default agent - threadId=${threadId}, state=${state}, data=${JSON.stringify(body)}`
          )
        }
      } catch (error) {
        agent.config.logger.error(
          `Failed to get proof format data for record ${record.id}, continuing with base record`,
          { cause: error }
        )
        body.proofData = null
      }
    }

    emitStructured(LogLevel.info, {
      hop: 'controller.handler.exit',
      flow: 'verification',
      thread_id: threadId ?? '',
      outer_msg_id: '',
      span_id: handlerSpanId,
      tenant_id: tenantId,
      conn_id: record.connectionId ?? '',
      duration_ms: durationMs(handlerStart),
      proof_state: state,
    })

    // Only send webhook if webhook url is configured
    if (config.webhookUrl) {
      agent.config.logger.debug(
        `[ProofEvent] Sending webhook event - threadId=${threadId}, state=${state}, webhookUrl=${config.webhookUrl + '/proofs'}`
      )
      const webhookSpanId = makeSpanId()
      const webhookStart = monoNow()
      emitStructured(LogLevel.info, {
        hop: 'controller.webhook.fire.start',
        flow: 'verification',
        thread_id: threadId ?? '',
        span_id: webhookSpanId,
        tenant_id: tenantId,
        target_url: config.webhookUrl + '/proofs',
      })
      recordWebhookFire()
      sendWebhookEvent(config.webhookUrl + '/proofs', body, agent.config.logger)
      emitStructured(LogLevel.info, {
        hop: 'controller.webhook.fire.end',
        flow: 'verification',
        thread_id: threadId ?? '',
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
          proofRecord: body,
        },
      })
    }
  })
}
