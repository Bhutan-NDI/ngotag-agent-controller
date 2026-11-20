import type { TsLogger } from '../../utils/logger'
import type { Agent, BaseEvent } from '@credo-ts/core'
import type { DidCommConnectionRecord } from '@credo-ts/didcomm'

import { DidRepository, JsonEncoder, Kms, TypedArrayEncoder } from '@credo-ts/core'
import {
  DidCommConnectionEventTypes,
  DidCommConnectionService,
  DidCommDidRotateService,
  DidCommEventTypes,
} from '@credo-ts/didcomm'

import { MIGRATION_ROTATION_KEY, getPendingCredoRotation, getRotation } from './rotationMetadata'

type ProcessedPayload = { connection?: DidCommConnectionRecord; encryptedMessage?: unknown }
type RotatedPayload = { connectionRecord: DidCommConnectionRecord; ourDid?: { from: string; to: string } }

// Public keys a DIDComm v1 envelope is addressed to, read the way Credo's own routing reads them.
const recipientKeys = (encryptedMessage: unknown): Kms.PublicJwk[] => {
  try {
    const header = JsonEncoder.fromBase64((encryptedMessage as { protected: string }).protected)
    const recipients = Array.isArray(header?.recipients) ? header.recipients : []
    return recipients.flatMap((recipient: { header?: { kid?: unknown } }) => {
      const kid = recipient?.header?.kid
      if ('string' !== typeof kid) return []
      return [Kms.PublicJwk.fromPublicKey({ crv: 'Ed25519', kty: 'OKP', publicKey: TypedArrayEncoder.fromBase58(kid) })]
    })
  } catch {
    return []
  }
}

/**
 * Finishes a migration rotation. Credo commits the new DID when the holder's ack arrives; this also commits it when
 * the holder's first message to the new DID arrives first (a lost ack), and in both cases takes the new DID back out
 * of `previousDids` once it is the connection's own DID (SAD ADR-WM-010 F3).
 */
export class PendingRotationCommitter {
  private readonly committingViaMessage = new Set<string>()

  public constructor(
    private readonly agent: Agent,
    private readonly logger: TsLogger,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Starts listening; returns a function that stops. */
  public attach(): () => void {
    const events = this.agent.events
    const processed = (event: BaseEvent): void => {
      this.onMessageProcessed(event.payload as ProcessedPayload).catch((error) =>
        this.logger.error(`[PendingRotationCommitter] could not check a processed message: ${error}`),
      )
    }
    const rotated = (event: BaseEvent): void => {
      // Read now: the flag is cleared as soon as the commit that raised this event returns.
      const viaMessage = this.committingViaMessage.has((event.payload as RotatedPayload).connectionRecord.id)
      this.onDidRotated(event.payload as RotatedPayload, viaMessage).catch((error) =>
        this.logger.error(`[PendingRotationCommitter] could not finalise a rotation: ${error}`),
      )
    }
    events.on(DidCommEventTypes.DidCommMessageProcessed, processed)
    events.on(DidCommConnectionEventTypes.DidCommConnectionDidRotated, rotated)
    return () => {
      events.off(DidCommEventTypes.DidCommMessageProcessed, processed)
      events.off(DidCommConnectionEventTypes.DidCommConnectionDidRotated, rotated)
    }
  }

  // A message the holder addressed to the pending new DID proves it applied the rotation, so commit it now.
  private async onMessageProcessed(payload: ProcessedPayload): Promise<void> {
    // Most connections have no rotation pending: decide from the record Credo already loaded, without another read.
    if (!payload.connection || !payload.encryptedMessage || !getPendingCredoRotation(payload.connection)) return

    const ctx = this.agent.context
    const connectionService = this.agent.dependencyManager.resolve(DidCommConnectionService)
    const connection = await connectionService.findById(ctx, payload.connection.id)
    const pending = connection && getPendingCredoRotation(connection)
    const rotation = connection && getRotation(connection)
    if (!connection || !pending || !rotation || 'sent' !== rotation.state || rotation.newDid !== pending.did) return

    const didRepository = this.agent.dependencyManager.resolve(DidRepository)
    let addressedToPendingDid = false
    for (const key of recipientKeys(payload.encryptedMessage)) {
      const record = await didRepository.findCreatedDidByRecipientKey(ctx, key)
      const alternatives = (record?.getTag('alternativeDids') as string[] | undefined) ?? []
      if (record && (record.did === pending.did || alternatives.includes(pending.did))) {
        addressedToPendingDid = true
        break
      }
    }
    if (!addressedToPendingDid) return

    // Credo's own ack handling does the commit, so the stored record changes exactly as it would for an ack.
    this.committingViaMessage.add(connection.id)
    try {
      await this.agent.dependencyManager.resolve(DidCommDidRotateService).processRotateAck({
        agentContext: ctx,
        message: { threadId: pending.threadId },
        assertReadyConnection: () => connection,
      } as never)
    } catch (error) {
      // Another message or the ack committed it first.
      this.logger.debug(`[PendingRotationCommitter] connection '${connection.id}' was already committed: ${error}`)
    } finally {
      this.committingViaMessage.delete(connection.id)
    }
  }

  private async onDidRotated(payload: RotatedPayload, viaMessage: boolean): Promise<void> {
    if (!payload.ourDid) return

    const ctx = this.agent.context
    const connectionService = this.agent.dependencyManager.resolve(DidCommConnectionService)
    const connection = await connectionService.findById(ctx, payload.connectionRecord.id)
    const rotation = connection && getRotation(connection)
    if (!connection || !rotation || 'sent' !== rotation.state || rotation.newDid !== payload.ourDid.to) return

    connection.previousDids = connection.previousDids.filter((did) => did !== rotation.newDid)
    connection.metadata.set(MIGRATION_ROTATION_KEY, {
      ...rotation,
      state: 'confirmed',
      confirmedAt: this.now().toISOString(),
      confirmedVia: viaMessage ? 'first-message' : 'ack',
      error: undefined,
    })
    await connectionService.update(ctx, connection)
  }
}
