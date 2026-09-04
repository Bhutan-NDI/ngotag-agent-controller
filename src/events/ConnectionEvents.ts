import type { ServerConfig } from '../utils/ServerConfig'
import type { Agent } from '@credo-ts/core'
import type { DidCommConnectionStateChangedEvent } from '@credo-ts/didcomm'

import { DidCommConnectionEventTypes } from '@credo-ts/didcomm'

import { sendWebSocketEvent } from './WebSocketEvents'
import { sendWebhookEvent } from './WebhookEvent'

export const connectionEvents = async (agent: Agent, config: ServerConfig) => {
  agent.events.on(
    DidCommConnectionEventTypes.DidCommConnectionStateChanged,
    async (event: DidCommConnectionStateChangedEvent) => {
      const record = event.payload.connectionRecord
      const tenantId =
        !event.metadata.contextCorrelationId || event.metadata.contextCorrelationId === 'default'
          ? event.metadata.contextCorrelationId
          : event.metadata.contextCorrelationId.split('tenant-')[1]
      const body = { ...record.toJSON(), ...event.metadata, contextCorrelationId: tenantId }

      // Only send webhook if webhook url is configured
      if (config.webhookUrl) {
        void sendWebhookEvent(config.webhookUrl + '/connections', body, agent.config.logger)
      }

      if (config.socketServer) {
        // Always emit websocket event to clients (could be 0)
        sendWebSocketEvent(config.socketServer, {
          ...event,
          payload: {
            ...event.payload,
            connectionRecord: body,
          },
        })
      }
    },
  )
}
