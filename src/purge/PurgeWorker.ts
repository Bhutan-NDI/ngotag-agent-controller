import type { PurgeJob } from './PurgeTypes'
import type { PurgeRecordType } from './PurgeTypes'
import type { Agent } from '@credo-ts/core'
import type { Consumer } from 'nats'

import { RecordNotFoundError } from '@credo-ts/core'
import { StringCodec } from 'nats'

import { PURGE_CONSUMER_MAX_DELIVER, PURGE_WORKER_RESTART_DELAY_MS } from './PurgeConstants'
import {
  RECORD_TYPES_WITH_DIDCOMM_MESSAGE_CHILDREN,
  deleteDidCommMessageChildren,
  deletePurgeRecord,
  findDidCommMessageChildIds,
} from './PurgeDeleteRecord'
import { sendPurgeWebhook, PurgeDeletionStatus } from './PurgeWebhook'

const sc = StringCodec()

/**
 * @deprecated Consumer for the dormant NATS schedule-at-create flow. See `NatsPurgeScheduler` for
 * why that flow is deprecated, and INTEGRATION-PLAN-develop.md §4.4.
 *
 * It shares the cron path's deletion primitives, so a purge here neither destroys the stored holder
 * credential nor orphans DIDComm messages — the children-before-parent cascade runs here too. What
 * it still does not do is re-read the record's state before deleting: the job names a record id
 * fixed at creation time, so this flow remains state-blind and can delete an exchange that is still
 * in flight. That is the reason it is deprecated and gated behind PURGE_NATS_ACK_STATE_BLIND.
 */
export class PurgeWorker {
  private recordType: PurgeRecordType
  private consumerName: string
  private webhookUrl: string | undefined
  private stopped = false

  public constructor(recordType: PurgeRecordType, consumerName: string, webhookUrl?: string) {
    this.recordType = recordType
    this.consumerName = consumerName
    this.webhookUrl = webhookUrl
  }

  public stop(): void {
    this.stopped = true
  }

  public async start(agent: Agent, consumer: Consumer): Promise<void> {
    agent.config.logger.info('[Purge] Worker started', { consumer: this.consumerName })

    while (!this.stopped) {
      try {
        const messages = await consumer.consume()
        for await (const msg of messages) {
          await this.processMessage(msg, agent)
        }
        agent.config.logger.warn('[Purge] Consume loop ended — restarting', { consumer: this.consumerName })
      } catch (err: any) {
        if (this.stopped) return
        agent.config.logger.error('[Purge] Consume loop error — restarting after delay', {
          consumer: this.consumerName,
          error: err?.message,
        })
        await new Promise((resolve) => setTimeout(resolve, PURGE_WORKER_RESTART_DELAY_MS))
      }
    }
  }

  /**
   * Children-before-parent, matching the cron engine. `deletePurgeRecord` is parent-only, so without
   * this every credential/proof purged through the NATS path would leave its `DidCommMessageRecord`s
   * permanently orphaned — findable only by a full-wallet sweep that the steady-state job never runs.
   */
  private async deleteWithCascade(agent: Agent, recordId: string): Promise<void> {
    if (RECORD_TYPES_WITH_DIDCOMM_MESSAGE_CHILDREN.has(this.recordType)) {
      const childIds = await findDidCommMessageChildIds(agent, recordId)
      if (childIds.length > 0) await deleteDidCommMessageChildren(agent, childIds)
    }
    await deletePurgeRecord(agent, this.recordType, recordId)
  }

  private async processMessage(msg: any, agent: Agent): Promise<void> {
    let job: PurgeJob | undefined

    try {
      job = JSON.parse(sc.decode(msg.data)) as PurgeJob
    } catch {
      agent.config.logger.error('[Purge] Failed to parse job — discarding', { consumer: this.consumerName })
      msg.ack()
      return
    }

    const { recordId, recordType, tenantId, agentMode } = job
    const logger = agent.config.logger
    const deliveryCount: number = msg.info.deliveryCount

    if (recordType !== this.recordType) {
      logger.error('[Purge] Job record type mismatch — discarding', {
        expected: this.recordType,
        received: recordType,
        recordId,
      })
      msg.ack()
      return
    }

    logger.info('[Purge] Job received', { recordId, recordType, tenantId, deliveryCount })

    try {
      if (agentMode === 'shared') {
        await (agent as any).modules.tenants.withTenantAgent({ tenantId }, async (tenantAgent: Agent) => {
          await this.deleteWithCascade(tenantAgent, recordId)
        })
      } else {
        await this.deleteWithCascade(agent, recordId)
      }

      logger.info('[Purge] Record deleted', { recordId, recordType, tenantId })
      msg.ack()

      if (this.webhookUrl) {
        try {
          await sendPurgeWebhook(
            this.webhookUrl,
            recordId,
            this.recordType,
            tenantId,
            PurgeDeletionStatus.DELETED,
            logger,
          )
        } catch (webhookErr: any) {
          logger.warn('[Purge] Webhook delivery failed after deletion', {
            recordId,
            recordType,
            error: webhookErr?.message,
          })
        }
      }
    } catch (err: any) {
      if (err instanceof RecordNotFoundError) {
        logger.warn('[Purge] Record already absent — treating as success', { recordId, recordType })
        msg.ack()

        if (this.webhookUrl) {
          try {
            await sendPurgeWebhook(
              this.webhookUrl,
              recordId,
              this.recordType,
              tenantId,
              PurgeDeletionStatus.ALREADY_ABSENT,
              logger,
            )
          } catch (webhookErr: any) {
            logger.warn('[Purge] Webhook delivery failed for already-absent record', {
              recordId,
              recordType,
              error: webhookErr?.message,
            })
          }
        }
        return
      }

      logger.warn('[Purge] Job failed', { recordId, recordType, deliveryCount, error: err?.message })

      if (deliveryCount >= PURGE_CONSUMER_MAX_DELIVER) {
        logger.error('[Purge] Job dropped after max retries', { recordId, recordType, tenantId, deliveryCount })
        msg.ack()
      } else {
        msg.nak()
      }
    }
  }
}
