import type { ServerConfig } from '../utils/ServerConfig'
import type { Agent, ProofStateChangedEvent } from '@credo-ts/core'

import { ProofEventTypes } from '@credo-ts/core'

import { sendWebSocketEvent } from './WebSocketEvents'
import { sendWebhookEvent } from './WebhookEvent'

export const proofEvents = async (agent: Agent, config: ServerConfig) => {
  agent.events.on(ProofEventTypes.ProofStateChanged, async (event: ProofStateChangedEvent) => {
    const record = event.payload.proofRecord
    const body = { ...record.toJSON(), ...event.metadata } as { proofData?: any }

    if (record.state === 'done') {
      if (event.metadata.contextCorrelationId !== 'default') {
        const tenantAgent = await agent.modules.tenants.getTenantAgent({
          tenantId: event.metadata.contextCorrelationId,
        })
        body.proofData = await tenantAgent.proofs.getFormatData(record.id)
      } else {
        body.proofData = await agent.proofs.getFormatData(record.id)
      }
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

    // Only send webhook if webhook url is configured. Do not block proof state handling on webhook delivery.
    if (config.webhookUrl) {
      void sendWebhookEvent(config.webhookUrl + '/proofs', body, agent.config.logger)
    }
  })
}
