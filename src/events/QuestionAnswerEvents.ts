import type { ServerConfig } from '../utils/ServerConfig'
import type { Agent } from '@credo-ts/core'
import type { QuestionAnswerStateChangedEvent } from '@credo-ts/question-answer'

import { QuestionAnswerEventTypes } from '@credo-ts/question-answer'

import { sendWebSocketEvent } from './WebSocketEvents'
import { sendWebhookEvent } from './WebhookEvent'

export const questionAnswerEvents = async (agent: Agent, config: ServerConfig) => {
  agent.events.on(
    QuestionAnswerEventTypes.QuestionAnswerStateChanged,
    async (event: QuestionAnswerStateChangedEvent) => {
      const record = event.payload.questionAnswerRecord
      const body = { ...record.toJSON(), ...event.metadata }

      // Only send webhook if webhook url is configured
      if (config.webhookUrl) {
        void sendWebhookEvent(config.webhookUrl + '/question-answer', body, agent.config.logger)
      }

      if (config.socketServer) {
        // Always emit websocket event to clients (could be 0)
        sendWebSocketEvent(config.socketServer, {
          ...event,
          payload: {
            message: event.payload.questionAnswerRecord.toJSON(),
            questionAnswerRecord: body,
          },
        })
      }
    },
  )
}
