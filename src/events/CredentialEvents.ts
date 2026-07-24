import type { RestMultiTenantAgentModules } from '../cliAgent'
import type { ServerConfig } from '../utils/ServerConfig'
import type { Agent } from '@credo-ts/core'
import type { DidCommCredentialStateChangedEvent } from '@credo-ts/didcomm'

import { DidCommCredentialEventTypes, DidCommCredentialState } from '@credo-ts/didcomm'

import { sendWebSocketEvent } from './WebSocketEvents'
import { sendWebhookEvent } from './WebhookEvent'

export const credentialEvents = async (agent: Agent, config: ServerConfig) => {
  agent.events.on(
    DidCommCredentialEventTypes.DidCommCredentialStateChanged,
    async (event: DidCommCredentialStateChangedEvent) => {
      const record = event.payload.credentialExchangeRecord
      const tenantId =
        !event.metadata.contextCorrelationId || event.metadata.contextCorrelationId === 'default'
          ? event.metadata.contextCorrelationId
          : event.metadata.contextCorrelationId.split('tenant-')[1]

      const body: Record<string, unknown> = {
        ...record.toJSON(),
        ...event.metadata,
        contextCorrelationId: tenantId,
        outOfBandId: null,
        credentialData: null,
      }

      if (record.state === DidCommCredentialState.Done) {
        try {
          if (tenantId && tenantId !== 'default') {
            await (agent as Agent<RestMultiTenantAgentModules>).modules.tenants.withTenantAgent(
              { tenantId: body.contextCorrelationId as string },
              async (tenantAgent) => {
                const [data, connectionRecord] = await Promise.all([
                  tenantAgent.modules.didcomm.credentials.getFormatData(record.id),
                  record.connectionId
                    ? tenantAgent.modules.didcomm.connections.findById(record.connectionId)
                    : Promise.resolve(null),
                ])
                body.credentialData = data
                body.outOfBandId = connectionRecord?.outOfBandId ?? null
              },
            )
          } else {
            const [data, connectionRecord] = await Promise.all([
              agent.modules.didcomm.credentials.getFormatData(record.id),
              record.connectionId
                ? agent.modules.didcomm.connections.findById(record.connectionId)
                : Promise.resolve(null),
            ])
            body.credentialData = data
            body.outOfBandId = connectionRecord?.outOfBandId ?? null
          }
        } catch (error) {
          agent.config.logger.error(
            `Failed to get credential format data for record ${record.id}, continuing with base record`,
            { cause: error },
          )
          body.credentialData = null
          body.outOfBandId = null
        }
      }

      if (config.webhookUrl) {
        void sendWebhookEvent(config.webhookUrl + '/credentials', body, agent.config.logger)
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
    },
  )
}
