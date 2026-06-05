import type { ServerConfig } from '../utils/ServerConfig'
import type { Agent } from '@credo-ts/core'
import type { QuestionAnswerStateChangedEvent } from '@credo-ts/question-answer'

import { QuestionAnswerEventTypes, QuestionAnswerRole, QuestionAnswerState } from '@credo-ts/question-answer'

import { sendWebSocketEvent } from './WebSocketEvents'
import { sendWebhookEvent } from './WebhookEvent'

export const questionAnswerEvents = async (agent: Agent, config: ServerConfig) => {
  agent.events.on(
    QuestionAnswerEventTypes.QuestionAnswerStateChanged,
    async (event: QuestionAnswerStateChangedEvent) => {
      const record = event.payload.questionAnswerRecord
      const body = { ...record.toJSON(), ...event.metadata }

      const tenantId = event.metadata.contextCorrelationId ?? 'default'

      agent.config.logger.debug(
        `[QuestionAnswerEvent] State changed - id=${record.id}, threadId=${record.threadId}, ` +
          `role=${record.role}, state=${record.state}, connectionId=${record.connectionId}, ` +
          `response=${record.response ?? 'none'}, contextCorrelationId=${tenantId}`
      )

      // The answer coming back from the wallet shows up as state "answer-received" on the questioner side
      if (record.role === QuestionAnswerRole.Questioner && record.state === QuestionAnswerState.AnswerReceived) {
        agent.config.logger.debug(
          `[QuestionAnswerEvent] Answer received from wallet - threadId=${record.threadId}, ` +
            `response=${record.response}, body=${JSON.stringify(body)}`
        )
      }

      // Only send webhook if webhook url is configured
      if (config.webhookUrl) {
        sendWebhookEvent(config.webhookUrl + '/question-answer', body, agent.config.logger)
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
    }
  )
}
