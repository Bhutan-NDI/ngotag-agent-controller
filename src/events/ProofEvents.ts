import type { RestMultiTenantAgentModules } from '../cliAgent'
import type { ServerConfig } from '../utils/ServerConfig'
import type { Agent } from '@credo-ts/core'
import type { DidCommProofStateChangedEvent } from '@credo-ts/didcomm'

import { DidCommProofEventTypes } from '@credo-ts/didcomm'

import { sendWebSocketEvent } from './WebSocketEvents'
import { sendWebhookEvent } from './WebhookEvent'

export const proofEvents = async (agent: Agent, config: ServerConfig) => {
  agent.events.on(DidCommProofEventTypes.ProofStateChanged, async (event: DidCommProofStateChangedEvent) => {
    const record = event.payload.proofRecord
    const tenantId =
      !event.metadata.contextCorrelationId || event.metadata.contextCorrelationId === 'default'
        ? event.metadata.contextCorrelationId
        : event.metadata.contextCorrelationId.split('tenant-')[1]

    const body: Record<string, unknown> = {
      ...record.toJSON(),
      ...event.metadata,
      contextCorrelationId: tenantId,
      proofData: null,
    }

    if (tenantId && tenantId !== 'default') {
      await (agent as Agent<RestMultiTenantAgentModules>).modules.tenants.withTenantAgent(
        { tenantId },
        async (tenantAgent) => {
          body.proofData = await tenantAgent.modules.didcomm.proofs.getFormatData(record.id)
        },
      )
    } else if (tenantId === 'default') {
      body.proofData = await agent.modules.didcomm.proofs.getFormatData(record.id)
    }

    // Only send webhook if webhook url is configured
    if (config.webhookUrl) {
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
