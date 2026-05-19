import type { RestMultiTenantAgentModules } from '../cliAgent'
import type { ServerConfig } from '../utils/ServerConfig'
import type { Agent, ProofStateChangedEvent } from '@credo-ts/core'

import { ProofEventTypes, ProofState } from '@credo-ts/core'

import { sendWebSocketEvent } from './WebSocketEvents'
import { sendWebhookEvent } from './WebhookEvent'

export const proofEvents = async (agent: Agent<RestMultiTenantAgentModules>, config: ServerConfig) => {
  agent.events.on(ProofEventTypes.ProofStateChanged, async (event: ProofStateChangedEvent) => {
    const record = event.payload.proofRecord
    const threadId = record.threadId
    const state = record.state

    agent.config.logger.debug(
      `[ProofEvent] Proof state changed event received - threadId=${threadId}, state=${state}, contextCorrelationId=${event.metadata.contextCorrelationId}`
    )

    const body = { ...record.toJSON(), ...event.metadata } as { proofData?: any }

    if (record.state === ProofState.Done) {
      try {
        if (event.metadata.contextCorrelationId !== 'default') {
          await agent.modules.tenants.withTenantAgent(
            { tenantId: event.metadata.contextCorrelationId },
            async (tenantAgent) => {
              const data = await tenantAgent.proofs.getFormatData(record.id)
              body.proofData = data
              agent.config.logger.debug(
                `[ProofEvent] Fetched proof format data for tenant agent - threadId=${threadId}, state=${state}, tenantId=${
                  event.metadata.contextCorrelationId
                }, data=${JSON.stringify(body)}`
              )
            }
          )
        } else {
          const data = await agent.proofs.getFormatData(record.id)
          body.proofData = data
          agent.config.logger.debug(
            `[ProofEvent] Fetched proof format data for default agent - threadId=${threadId}, state=${state}, data=${JSON.stringify(
              body
            )}`
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

    // Only send webhook if webhook url is configured
    if (config.webhookUrl) {
      agent.config.logger.debug(
        `[ProofEvent] Sending webhook event - threadId=${threadId}, state=${state}, webhookUrl=${
          config.webhookUrl + '/proofs'
        }`
      )
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
