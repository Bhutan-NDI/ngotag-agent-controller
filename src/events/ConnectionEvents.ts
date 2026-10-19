import type { ServerConfig } from '../utils/ServerConfig'
import type { Agent } from '@credo-ts/core'
import type { DidCommConnectionDidRotatedEvent, DidCommConnectionStateChangedEvent } from '@credo-ts/didcomm'

import { DidCommConnectionEventTypes } from '@credo-ts/didcomm'

import { sendWebSocketEvent } from './WebSocketEvents'
import { sendWebhookEvent } from './WebhookEvent'

export const connectionEvents = async (agent: Agent, config: ServerConfig) => {
  const publish = (
    event: DidCommConnectionStateChangedEvent | DidCommConnectionDidRotatedEvent,
    body: Record<string, unknown>,
  ) => {
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
  }

  agent.events.on(
    DidCommConnectionEventTypes.DidCommConnectionStateChanged,
    async (event: DidCommConnectionStateChangedEvent) => {
      publish(event, { ...event.payload.connectionRecord.toJSON(), ...event.metadata })
    },
  )

  // A DID change goes to the same endpoint as a state change, carrying the connection as it now is plus a
  // `didRotated` field with the old and new DID of whichever side changed.
  agent.events.on(
    DidCommConnectionEventTypes.DidCommConnectionDidRotated,
    async (event: DidCommConnectionDidRotatedEvent) => {
      const { connectionRecord, ourDid, theirDid } = event.payload
      publish(event, { ...connectionRecord.toJSON(), ...event.metadata, didRotated: { ourDid, theirDid } })
    },
  )
}
