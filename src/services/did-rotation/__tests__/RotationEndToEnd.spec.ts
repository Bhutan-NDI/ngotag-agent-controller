/**
 * Migration rotation between two real agents over HTTP: a dedicated agent rotates a connection to a new did:peer:4 on
 * its own endpoint, and the holder answers (or fails to). Credo 0.6.2 stands in for the phone's 0.5.18 here; the
 * interop test against the real app is a separate QA test (T1).
 */
import { DidCommConnectionService } from '@credo-ts/didcomm'

import { PendingRotationCommitter } from '../PendingRotationCommitter'
import { RotationRunner } from '../RotationRunner'
import { RotationService } from '../RotationService'
import { getPendingCredoRotation, getRotation } from '../rotationMetadata'

import { buildAgent, connect, eventually, logger, plain, type TestAgent } from './rotationHarness'

describe('migration rotation (real agents, real HTTP)', () => {
  let dedicated: TestAgent
  let holder: TestAgent
  let service: RotationService
  let stopCommitter: () => void
  let connectionId: string
  let holderConnectionId: string

  const connection = async () =>
    dedicated.agent.dependencyManager.resolve(DidCommConnectionService).getById(dedicated.agent.context, connectionId)

  beforeEach(async () => {
    dedicated = await buildAgent('dedicated')
    holder = await buildAgent('holder')
    service = new RotationService(dedicated.agent, logger)
    stopCommitter = new PendingRotationCommitter(dedicated.agent, logger).attach()
    await dedicated.agent.initialize()
    await holder.agent.initialize()
    ;({ inviterId: connectionId, inviteeId: holderConnectionId } = await plain(() =>
      connect(dedicated.agent, holder.agent),
    ))
  }, 120000)

  afterEach(async () => {
    stopCommitter()
    await holder.agent.shutdown().catch(() => undefined)
    await dedicated.agent.shutdown().catch(() => undefined)
  })

  it('moves the connection to the new DID when the holder acknowledges', async () => {
    await plain(async () => {
      const before = await connection()
      const oldDid = before.did as string

      const result = await service.rotateConnection(connectionId)
      expect(result).toMatchObject({ outcome: 'sent' })
      const { newDid } = result as { newDid: string }

      await eventually(async () => 'confirmed' === getRotation(await connection())?.state)

      const after = await connection()
      expect(after.did).toBe(newDid)
      expect(after.previousDids).toContain(oldDid)
      expect(after.previousDids).not.toContain(newDid)
      expect(getPendingCredoRotation(after)).toBeNull()
      expect(getRotation(after)).toMatchObject({ state: 'confirmed', confirmedVia: 'ack', newDid, attempts: 1 })

      const holderSide = await (holder.agent.modules as any).didcomm.connections.getById(holderConnectionId)
      expect(holderSide.theirDid).toBe(newDid)
    })
  }, 90000)

  it('accepts a message to the new DID before any ack, and commits the rotation on it', async () => {
    await plain(async () => {
      holder.outbound.dropNext = 1
      const oldDid = (await connection()).did as string

      const { newDid } = (await service.rotateConnection(connectionId)) as { newDid: string }
      // The holder tried to acknowledge, and that ack was swallowed.
      await eventually(() => 0 === holder.outbound.dropNext)
      await eventually(async () => {
        const holderSide = await (holder.agent.modules as any).didcomm.connections.getById(holderConnectionId)
        return holderSide.theirDid === newDid
      })

      const pending = await connection()
      expect(pending.did).toBe(oldDid)
      expect(pending.previousDids).toContain(newDid)
      expect(getRotation(pending)).toMatchObject({ state: 'sent' })
      expect(getPendingCredoRotation(pending)).not.toBeNull()

      await (holder.agent.modules as any).didcomm.basicMessages.sendMessage(holderConnectionId, 'hello on the new DID')

      await eventually(async () => 'confirmed' === getRotation(await connection())?.state)
      const after = await connection()
      expect(after.did).toBe(newDid)
      expect(after.previousDids).toContain(oldDid)
      expect(after.previousDids).not.toContain(newDid)
      expect(getRotation(after)).toMatchObject({ confirmedVia: 'first-message' })

      const received = await (dedicated.agent.modules as any).didcomm.basicMessages.findAllByQuery({})
      expect(received.map((message: any) => message.content)).toContain('hello on the new DID')
    })
  }, 90000)

  it('keeps accepting messages on the old DID after the rotation commits', async () => {
    await plain(async () => {
      await service.rotateConnection(connectionId)
      await eventually(async () => 'confirmed' === getRotation(await connection())?.state)

      await (dedicated.agent.modules as any).didcomm.basicMessages.sendMessage(connectionId, 'still reachable')

      await eventually(async () => {
        const messages = await (holder.agent.modules as any).didcomm.basicMessages.findAllByQuery({})
        return messages.some((message: any) => 'still reachable' === message.content)
      })
    })
  }, 90000)

  it('sends one rotation when asked twice at once, and the holder ends up on that DID', async () => {
    await plain(async () => {
      const results = await Promise.all([
        service.rotateConnection(connectionId),
        service.rotateConnection(connectionId),
      ])

      const sent = results.filter((result) => 'sent' === result.outcome)
      expect(sent).toHaveLength(1)
      expect(results.filter((result) => 'skipped' === result.outcome)).toHaveLength(1)

      const { newDid } = sent[0] as { newDid: string }
      await eventually(async () => 'confirmed' === getRotation(await connection())?.state)
      expect((await connection()).did).toBe(newDid)
      const holderSide = await (holder.agent.modules as any).didcomm.connections.getById(holderConnectionId)
      expect(holderSide.theirDid).toBe(newDid)
    })
  }, 90000)

  it('does not rotate a connection twice', async () => {
    await plain(async () => {
      await service.rotateConnection(connectionId)
      await eventually(async () => 'confirmed' === getRotation(await connection())?.state)

      await expect(service.rotateConnection(connectionId)).resolves.toEqual({
        connectionId,
        outcome: 'skipped',
        reason: 'ALREADY_ROTATED',
      })
    })
  }, 90000)

  it('rotates a whole organisation in batches, most recently active first, and reports progress', async () => {
    await plain(async () => {
      const second = await buildAgent('holder-two')
      await second.agent.initialize()
      try {
        await connect(dedicated.agent, second.agent)
        const connectionService = dedicated.agent.dependencyManager.resolve(DidCommConnectionService)
        const ctx = dedicated.agent.context
        const stateOf = async (id: string) => getRotation(await connectionService.getById(ctx, id))?.state

        const runner = new RotationRunner(dedicated.agent, service, logger)
        await runner.start({ batchSize: 1, autoRun: false })
        runner.stop()

        const [recent, older] = (await connectionService.getAll(ctx)).sort(
          (a, b) => (b.updatedAt?.getTime() ?? 0) - (a.updatedAt?.getTime() ?? 0),
        )
        await expect(runner.runOnce()).resolves.toEqual({ rotated: 1, remaining: 1 })
        await eventually(async () => 'confirmed' === (await stateOf(recent.id)))
        expect(await stateOf(older.id)).toBeUndefined()
        expect((await runner.status()).counts).toMatchObject({ total: 2, updated: 1, pending: 1 })

        await expect(runner.runOnce()).resolves.toEqual({ rotated: 1, remaining: 0 })
        await eventually(async () => 'confirmed' === (await stateOf(older.id)))
        const { counts, job } = await runner.status()
        expect(counts).toMatchObject({ total: 2, updated: 2, pending: 0 })
        expect(job.status).toBe('completed')
      } finally {
        await second.agent.shutdown().catch(() => undefined)
      }
    })
  }, 120000)

  it('retries an unreachable holder with the same new DID, then gives up', async () => {
    await plain(async () => {
      await holder.agent.shutdown()

      const first = await service.rotateConnection(connectionId)
      expect(first).toMatchObject({ outcome: 'retry' })
      const { newDid } = first as { newDid: string }
      const afterFirst = await connection()
      expect(getRotation(afterFirst)).toMatchObject({ state: 'retry', attempts: 1, newDid })
      expect(getPendingCredoRotation(afterFirst)).toBeNull()
      expect(afterFirst.previousDids).toContain(newDid)

      await expect(service.rotateConnection(connectionId)).resolves.toMatchObject({
        outcome: 'skipped',
        reason: 'RETRY_NOT_DUE',
      })

      let outcome = first
      for (let attempt = 2; attempt <= 5; attempt += 1) {
        outcome = await service.rotateConnection(connectionId, { force: true })
        expect((outcome as { newDid: string }).newDid).toBe(newDid)
      }
      expect(outcome).toMatchObject({ outcome: 'failed' })
      expect(getRotation(await connection())).toMatchObject({ state: 'failed', attempts: 5, newDid })
    })
  }, 120000)
})
