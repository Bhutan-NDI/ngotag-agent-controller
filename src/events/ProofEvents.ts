import type { RestMultiTenantAgentModules } from '../cliAgent'
import type { ServerConfig } from '../utils/ServerConfig'
import type { Agent, ProofStateChangedEvent } from '@credo-ts/core'

import { ProofEventTypes, ProofState } from '@credo-ts/core'

import { sendWebSocketEvent } from './WebSocketEvents'
import { sendWebhookEvent } from './WebhookEvent'

export const proofEvents = async (agent: Agent<RestMultiTenantAgentModules>, config: ServerConfig) => {
  agent.events.on(ProofEventTypes.ProofStateChanged, async (event: ProofStateChangedEvent) => {
    const record = event.payload.proofRecord
    const body = { ...record.toJSON(), ...event.metadata } as { proofData?: any }

    if (record.state === ProofState.Done) {
      if (event.metadata.contextCorrelationId !== 'default') {
        await agent.modules.tenants.withTenantAgent(
          { tenantId: event.metadata.contextCorrelationId },
          async (tenantAgent) => {
            const data = await tenantAgent.proofs.getFormatData(record.id)
            body.proofData = data
          }
        )
      } else {
        const data = await agent.proofs.getFormatData(record.id)
        body.proofData = data
      }
    }

    // Only send webhook if webhook url is configured
    if (config.webhookUrl) {
      sendWebhookEvent(config.webhookUrl + '/proofs', body, agent.config.logger)
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
