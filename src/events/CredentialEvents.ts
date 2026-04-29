import type { RestMultiTenantAgentModules } from '../cliAgent'
import type { ServerConfig } from '../utils/ServerConfig'
import type { Agent, CredentialStateChangedEvent } from '@credo-ts/core'

import { CredentialEventTypes, CredentialState } from '@credo-ts/core'

import { sendWebSocketEvent } from './WebSocketEvents'
import { sendWebhookEvent } from './WebhookEvent'

export const credentialEvents = async (agent: Agent<RestMultiTenantAgentModules>, config: ServerConfig) => {
  agent.events.on(CredentialEventTypes.CredentialStateChanged, async (event: CredentialStateChangedEvent) => {
    const record = event.payload.credentialRecord

    const body: Record<string, unknown> = {
      ...record.toJSON(),
      ...event.metadata,
      outOfBandId: null,
      credentialData: null,
    }

    if (record.state === CredentialState.Done) {
      if (event.metadata.contextCorrelationId !== 'default') {
        await agent.modules.tenants.withTenantAgent(
          { tenantId: event.metadata.contextCorrelationId },
          async (tenantAgent) => {
            const [data, connectionRecord] = await Promise.all([
              tenantAgent.credentials.getFormatData(record.id),
              record.connectionId ? tenantAgent.connections.findById(record.connectionId) : Promise.resolve(null),
            ])
            body.credentialData = data
            body.outOfBandId = connectionRecord?.outOfBandId ?? null
          }
        )
      } else {
        const [data, connectionRecord] = await Promise.all([
          agent.credentials.getFormatData(record.id),
          record.connectionId ? agent.connections.findById(record.connectionId) : Promise.resolve(null),
        ])
        body.credentialData = data
        body.outOfBandId = connectionRecord?.outOfBandId ?? null
      }
    }

    // Only send webhook if webhook url is configured
    if (config.webhookUrl) {
      sendWebhookEvent(config.webhookUrl + '/credentials', body, agent.config.logger)
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
