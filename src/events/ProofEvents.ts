import type { ServerConfig } from '../utils/ServerConfig'
import type { Agent, ProofStateChangedEvent } from '@credo-ts/core'

import { ProofEventTypes } from '@credo-ts/core'

import { sendWebSocketEvent } from './WebSocketEvents'
import { sendWebhookEvent } from './WebhookEvent'

export const proofEvents = async (agent: Agent, config: ServerConfig) => {
  agent.events.on(ProofEventTypes.ProofStateChanged, async (event: ProofStateChangedEvent) => {
    const record = event.payload.proofRecord
    const body = { ...record.toJSON(), ...event.metadata } as { proofData?: any; contextCorrelationId?:any }
    if (event.metadata.contextCorrelationId !== 'default' && record.state === 'done') {
      const tenantAgent = await agent.modules.tenants.getTenantAgent({
        tenantId: event.metadata.contextCorrelationId,
      })
      const data = await tenantAgent.proofs.getFormatData(record.id)
      body.proofData = data
    }

    //Emit webhook for dedicated agent
    if (event.metadata.contextCorrelationId === 'default') {
      const data = await agent.proofs.getFormatData(record.id)
      body.proofData = data
    }

    // Only send webhook if webhook url is configured
    if (config.webhookUrl) {
      // Split the URL by '/'
      const parts = config.webhookUrl.split('/');
      // Extract the last value
      const orgId = parts[parts.length - 1];
      body.contextCorrelationId = orgId;
      // TODO: Remove the above lines after the update
      await sendWebhookEvent(config.webhookUrl + '/proofs', body, agent.config.logger)  
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
