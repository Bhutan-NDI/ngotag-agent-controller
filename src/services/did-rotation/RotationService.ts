import type { TsLogger } from '../../utils/logger'
import type { Agent } from '@credo-ts/core'
import type { DidCommConnectionRecord } from '@credo-ts/didcomm'

import {
  DidCommConnectionService,
  DidCommDidExchangeState,
  DidCommDidRotateService,
  DidCommMessageSender,
  DidCommOutboundMessageContext,
  DidCommRoutingService,
} from '@credo-ts/didcomm'

import {
  MAX_SEND_ATTEMPTS,
  MIGRATION_ROTATION_KEY,
  getPendingCredoRotation,
  getRotation,
  isNeverLeftError,
  retryDelayMs,
} from './rotationMetadata'

export type RotateOutcome =
  | { connectionId: string; outcome: 'sent'; newDid: string; uncertain?: boolean }
  | { connectionId: string; outcome: 'retry' | 'failed'; newDid: string; nextAttemptAt?: string }
  | { connectionId: string; outcome: 'skipped'; reason: string }

export type SkipReason =
  | 'NOT_COMPLETED'
  | 'NO_DID'
  | 'MEDIATOR_CONNECTION'
  | 'ROTATION_IN_FLIGHT'
  | 'ALREADY_ROTATED'
  | 'FAILED'
  | 'RETRY_NOT_DUE'

/**
 * Rotates one connection to a fresh did:peer:4 on this agent's own endpoint (SAD ADR-WM-010). Exactly one new DID is
 * created per connection and it is never re-sent as a routine: a send is repeated only when it provably never left,
 * and then with the same DID.
 *
 * Credo switches its own DID only when the holder's ack arrives, and keeps sending from the old DID until then. The
 * new DID is added to `previousDids` before the message is sent so that anything the holder sends to it, even before
 * the ack, is recognised as belonging to this connection.
 */
export class RotationService {
  // One rotation per connection at a time: a batch and a manual request, or two batches, must not both pass the
  // eligibility check and send two different new DIDs to the same holder.
  private readonly locks = new Map<string, Promise<unknown>>()

  public constructor(
    private readonly agent: Agent,
    private readonly logger: TsLogger,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private get connectionService(): DidCommConnectionService {
    return this.agent.dependencyManager.resolve(DidCommConnectionService)
  }

  /** Why a connection should not be rotated now, or undefined when it should. `force` also retries a failed one. */
  public skipReason(connection: DidCommConnectionRecord, force = false): SkipReason | undefined {
    if (DidCommDidExchangeState.Completed !== connection.state) return 'NOT_COMPLETED'
    if (!connection.did || !connection.theirDid) return 'NO_DID'
    if (connection.connectionTypes?.includes('mediator')) return 'MEDIATOR_CONNECTION'

    const rotation = getRotation(connection)
    // rotate() records 'sent' before it sends, so a Credo marker next to any other state was never sent: it is cleared
    // and redone (see rotate).
    if ('sent' === rotation?.state && getPendingCredoRotation(connection)) return 'ROTATION_IN_FLIGHT'
    if (!rotation) return undefined
    if ('sent' === rotation.state || 'confirmed' === rotation.state) return 'ALREADY_ROTATED'
    if ('failed' === rotation.state) return force ? undefined : 'FAILED'
    if (!force && rotation.nextAttemptAt && new Date(rotation.nextAttemptAt) > this.now()) return 'RETRY_NOT_DUE'
    return undefined
  }

  public rotateConnection(connectionId: string, options: { force?: boolean } = {}): Promise<RotateOutcome> {
    const run = (this.locks.get(connectionId) ?? Promise.resolve()).then(() => this.rotate(connectionId, options))
    const settled = run.catch(() => undefined)
    this.locks.set(connectionId, settled)
    void settled.then(() => {
      if (this.locks.get(connectionId) === settled) this.locks.delete(connectionId)
    })
    return run
  }

  private async rotate(connectionId: string, options: { force?: boolean }): Promise<RotateOutcome> {
    const ctx = this.agent.context
    const connection = await this.connectionService.getById(ctx, connectionId)
    const skip = this.skipReason(connection, options.force)
    if (skip) return { connectionId, outcome: 'skipped', reason: skip }

    const previous = getRotation(connection)
    if ('sent' !== previous?.state && getPendingCredoRotation(connection)) {
      await this.agent.dependencyManager.resolve(DidCommDidRotateService).clearDidRotationData(ctx, connection)
    }
    // A retry reuses the DID created for the first attempt.
    const reuseDid =
      previous && ('retry' === previous.state || 'failed' === previous.state) ? previous.newDid : undefined
    const attempts = (previous?.attempts ?? 0) + 1

    const routing = reuseDid
      ? undefined
      : await this.agent.dependencyManager.resolve(DidCommRoutingService).getRouting(ctx, {})
    const message = await this.agent.dependencyManager
      .resolve(DidCommDidRotateService)
      .createRotate(ctx, { connection, toDid: reuseDid, routing })
    const newDid = message.toDid

    if (!connection.previousDids.includes(newDid)) {
      connection.previousDids = [...connection.previousDids, newDid]
    }
    connection.metadata.set(MIGRATION_ROTATION_KEY, {
      state: 'sent',
      newDid,
      attempts,
      sentAt: this.now().toISOString(),
    })
    await this.connectionService.update(ctx, connection)

    try {
      await this.agent.dependencyManager
        .resolve(DidCommMessageSender)
        .sendMessage(new DidCommOutboundMessageContext(message, { agentContext: ctx, connection }))
      return { connectionId, outcome: 'sent', newDid }
    } catch (error) {
      if (isNeverLeftError(error)) {
        return this.scheduleRetry(connectionId, newDid, attempts)
      }
      // It may have been delivered, so it is not re-sent: if the holder applied it the ack or its first message to
      // the new DID will commit it, and if not the connection keeps working on the old DID.
      this.logger.warn(
        `[RotationService] rotation of connection '${connectionId}' sent with an uncertain outcome: ${error}`,
      )
      await this.recordUncertain(connectionId)
      return { connectionId, outcome: 'sent', newDid, uncertain: true }
    }
  }

  private async scheduleRetry(connectionId: string, newDid: string, attempts: number): Promise<RotateOutcome> {
    const ctx = this.agent.context
    const connection = await this.connectionService.getById(ctx, connectionId)
    if (getPendingCredoRotation(connection)) {
      await this.agent.dependencyManager.resolve(DidCommDidRotateService).clearDidRotationData(ctx, connection)
    }

    const exhausted = attempts >= MAX_SEND_ATTEMPTS
    const nextAttemptAt = exhausted ? undefined : new Date(this.now().getTime() + retryDelayMs(attempts)).toISOString()
    connection.metadata.set(MIGRATION_ROTATION_KEY, {
      state: exhausted ? 'failed' : 'retry',
      newDid,
      attempts,
      nextAttemptAt,
      error: 'UNREACHABLE',
    })
    await this.connectionService.update(ctx, connection)
    this.logger.warn(
      `[RotationService] connection '${connectionId}' could not be reached (attempt ${attempts}); ${exhausted ? 'giving up' : `retrying at ${nextAttemptAt}`}`,
    )
    return exhausted
      ? { connectionId, outcome: 'failed', newDid }
      : { connectionId, outcome: 'retry', newDid, nextAttemptAt }
  }

  private async recordUncertain(connectionId: string): Promise<void> {
    const ctx = this.agent.context
    const connection = await this.connectionService.getById(ctx, connectionId)
    const rotation = getRotation(connection)
    if (!rotation) return
    connection.metadata.set(MIGRATION_ROTATION_KEY, { ...rotation, error: 'SEND_UNCERTAIN' })
    await this.connectionService.update(ctx, connection)
  }
}
