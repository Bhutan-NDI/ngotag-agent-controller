import { DidCommConnectionRecord, DidCommDidExchangeRole, DidCommDidExchangeState } from '@credo-ts/didcomm'
import { jest } from '@jest/globals'

import { DEFAULT_BATCH_SIZE, DEFAULT_INTERVAL_MS, RotationRunner } from '../RotationRunner'
import { RotationService } from '../RotationService'
import { CREDO_DID_ROTATE_KEY, MIGRATION_ROTATION_KEY } from '../rotationMetadata'

import { eventually, silentLogger } from './rotationTestSupport'

const connection = (
  id: string,
  options: {
    updatedAt?: number
    createdAt?: number
    state?: DidCommDidExchangeState
    rotation?: object
    marker?: boolean
    mediator?: boolean
  } = {},
): DidCommConnectionRecord => {
  const record = new DidCommConnectionRecord({
    id,
    state: options.state ?? DidCommDidExchangeState.Completed,
    role: DidCommDidExchangeRole.Responder,
    did: `did:peer:${id}`,
    theirDid: `did:peer:their-${id}`,
    connectionTypes: options.mediator ? ['mediator'] : [],
  })
  record.updatedAt = new Date(options.updatedAt ?? 0)
  if (undefined !== options.createdAt) record.createdAt = new Date(options.createdAt)
  if (options.rotation) record.metadata.set(MIGRATION_ROTATION_KEY, options.rotation)
  if (options.marker) record.metadata.set(CREDO_DID_ROTATE_KEY, { threadId: 't', did: 'n' })
  return record
}

const build = (connections: DidCommConnectionRecord[], rotateImpl?: (id: string) => Promise<unknown>) => {
  const records = new Map<string, { id: string; content: Record<string, unknown> }>()
  const agent = {
    context: {},
    genericRecords: {
      findById: async (id: string) => records.get(id) ?? null,
      save: async (record: { id: string; content: Record<string, unknown> }) => void records.set(record.id, record),
      update: async (record: { id: string; content: Record<string, unknown> }) => void records.set(record.id, record),
    },
    dependencyManager: {
      resolve: () => ({
        findAllByQuery: async (_ctx: unknown, query: { state: string }, options: { limit: number; offset: number }) =>
          connections.filter((c) => c.state === query.state).slice(options.offset, options.offset + options.limit),
      }),
    },
  }
  const service = new RotationService(agent as never, silentLogger())
  const rotated: string[] = []
  jest.spyOn(service, 'rotateConnection').mockImplementation((async (id: string) => {
    rotated.push(id)
    if (rotateImpl) return rotateImpl(id)
    connections
      .find((c) => c.id === id)
      ?.metadata.set(MIGRATION_ROTATION_KEY, {
        state: 'sent',
        newDid: `new-${id}`,
        attempts: 1,
        sentAt: new Date().toISOString(),
      })
    connections.find((c) => c.id === id)?.metadata.set(CREDO_DID_ROTATE_KEY, { threadId: 't', did: `new-${id}` })
    return { connectionId: id, outcome: 'sent' }
  }) as never)
  const runner = new RotationRunner(agent as never, service, silentLogger())
  return { runner, rotated, records, agent, service }
}

describe('RotationRunner', () => {
  describe('runOnce', () => {
    it('rotates one bounded batch, the most recently active connections first', async () => {
      const connections = [1, 2, 3, 4, 5].map((n) => connection(`c${n}`, { updatedAt: n * 1000 }))
      const { runner, rotated } = build(connections)
      await runner.start({ batchSize: 2, autoRun: false })
      runner.stop()

      const result = await runner.runOnce()

      expect(rotated).toEqual(['c5', 'c4'])
      expect(result).toEqual({ rotated: 2, remaining: 3 })
    })

    it('takes the next batch on the next run, and completes the job when nothing is left', async () => {
      const connections = [1, 2, 3].map((n) => connection(`c${n}`, { updatedAt: n }))
      const { runner, rotated } = build(connections)
      await runner.start({ batchSize: 2, autoRun: false })
      runner.stop()

      await runner.runOnce()
      expect((await runner.status()).job.status).toBe('running')
      const second = await runner.runOnce()

      expect(rotated).toEqual(['c3', 'c2', 'c1'])
      expect(second.remaining).toBe(0)
      const { job } = await runner.status()
      expect(job.status).toBe('completed')
      expect(job.completedAt).toBeDefined()
    })

    it('leaves out connections that are not completed, are mediator connections, or are already done', async () => {
      const connections = [
        connection('ok', { updatedAt: 1 }),
        connection('pending-state', { state: DidCommDidExchangeState.RequestSent }),
        connection('mediator', { mediator: true }),
        connection('sent', { rotation: { state: 'sent', newDid: 'n', attempts: 1 } }),
        connection('confirmed', { rotation: { state: 'confirmed', newDid: 'n', attempts: 1 } }),
        connection('failed', { rotation: { state: 'failed', newDid: 'n', attempts: 5 } }),
        connection('in-flight', {
          marker: true,
          rotation: { state: 'sent', newDid: 'n', attempts: 1, sentAt: new Date().toISOString() },
        }),
        connection('retry-later', {
          rotation: {
            state: 'retry',
            newDid: 'n',
            attempts: 1,
            nextAttemptAt: new Date(Date.now() + 3_600_000).toISOString(),
          },
        }),
        connection('retry-due', {
          updatedAt: 0,
          rotation: {
            state: 'retry',
            newDid: 'n',
            attempts: 1,
            nextAttemptAt: new Date(Date.now() - 1000).toISOString(),
          },
        }),
      ]
      const { runner, rotated } = build(connections)
      await runner.start({ batchSize: 100, autoRun: false })
      runner.stop()

      await runner.runOnce()

      expect(rotated.sort()).toEqual(['ok', 'retry-due'])
    })

    it('leaves out connections made after the job began, and keeps that cutoff when the job is started again', async () => {
      const connections = [connection('old', { createdAt: Date.now() - 60_000 })]
      const { runner, rotated } = build(connections)
      await runner.start({ batchSize: 100, autoRun: false })
      const { cutoff } = (await runner.status()).job
      connections.push(connection('native', { createdAt: Date.now() + 60_000 }))

      await runner.runOnce()
      expect(rotated).toEqual(['old'])
      expect((await runner.status()).job.status).toBe('completed')
      expect((await runner.status()).counts).toMatchObject({ pending: 0, waiting: 1, updated: 1, total: 2 })

      const restarted = await runner.start({ autoRun: false })
      expect(restarted.job.cutoff).toBe(cutoff)
      await runner.runOnce()
      expect(rotated).toEqual(['old'])
    })

    it('considers every connection when there are more than one page of them', async () => {
      const connections = Array.from({ length: 1100 }, (_, n) => connection(`c${n}`, { updatedAt: n }))
      const { runner, rotated } = build(connections)
      await runner.start({ batchSize: 5000, autoRun: false })
      runner.stop()

      const result = await runner.runOnce()

      expect(rotated).toHaveLength(1100)
      expect(result.remaining).toBe(0)
    })

    it('never runs two batches at once, so no connection is picked twice', async () => {
      const connections = [1, 2, 3].map((n) => connection(`c${n}`, { updatedAt: n }))
      const { runner, rotated } = build(connections, async (id) => {
        await new Promise((resolve) => setTimeout(resolve, 5))
        const record = connections.find((c) => c.id === id)
        record?.metadata.set(MIGRATION_ROTATION_KEY, {
          state: 'sent',
          newDid: 'n',
          attempts: 1,
          sentAt: new Date().toISOString(),
        })
        record?.metadata.set(CREDO_DID_ROTATE_KEY, { threadId: 't', did: 'n' })
        return { connectionId: id, outcome: 'sent' }
      })
      await runner.start({ batchSize: 10, autoRun: false })

      await Promise.all([runner.runOnce(), runner.runOnce(), runner.runOnce()])

      expect(rotated.sort()).toEqual(['c1', 'c2', 'c3'])
    })

    it('carries on with the batch when one connection fails', async () => {
      const connections = ['a', 'b', 'c'].map((id, n) => connection(id, { updatedAt: 10 - n }))
      const { runner, rotated } = build(connections, async (id) => {
        if ('b' === id) throw new Error('boom')
        return { connectionId: id, outcome: 'sent' }
      })
      await runner.start({ batchSize: 10, autoRun: false })
      runner.stop()

      await expect(runner.runOnce()).resolves.toMatchObject({ rotated: 3 })
      expect(rotated).toEqual(['a', 'b', 'c'])
    })

    it('keeps the job running while a connection still waits for a retry', async () => {
      const connections = [
        connection('a', {
          rotation: {
            state: 'retry',
            newDid: 'n',
            attempts: 1,
            nextAttemptAt: new Date(Date.now() + 3_600_000).toISOString(),
          },
        }),
      ]
      const { runner } = build(connections)
      await runner.start({ autoRun: false })
      runner.stop()

      await expect(runner.runOnce()).resolves.toEqual({ rotated: 0, remaining: 1 })
      expect((await runner.status()).job.status).toBe('running')
    })
  })

  describe('start / resume', () => {
    it('saves the job it starts, with defaults for anything not given or invalid', async () => {
      const { runner } = build([])

      const status = await runner.start({ batchSize: -3, intervalMs: 1.5 })
      runner.stop()

      expect(status.job).toMatchObject({
        status: 'running',
        batchSize: DEFAULT_BATCH_SIZE,
        intervalMs: DEFAULT_INTERVAL_MS,
      })
      expect(status.job.startedAt).toBeDefined()
    })

    it('leaves a running job alone instead of starting a second', async () => {
      const { runner } = build([])
      await runner.start({ batchSize: 7 })
      runner.stop()

      const again = await runner.start({ batchSize: 99 })
      runner.stop()

      expect(again.job.batchSize).toBe(7)
    })

    it('revives a running job whose loop has died when it is started again', async () => {
      const { runner, rotated } = build([connection('a')])
      await runner.start({ autoRun: false })

      await runner.start()
      await eventually(() => 1 === rotated.length)
      runner.stop()
    })

    it('keeps a job going after a batch fails', async () => {
      const { runner, rotated } = build([connection('a')])
      jest.spyOn(runner, 'runOnce').mockRejectedValueOnce(new Error('storage is busy'))

      await runner.start({ intervalMs: 20 })
      await eventually(() => 1 === rotated.length)
      runner.stop()
    })

    it('reports the job as running right after it starts, even if the status was read just before', async () => {
      const { runner } = build([])
      expect((await runner.status()).job.status).toBe('idle')

      const started = await runner.start({ autoRun: false })

      expect(started.job.status).toBe('running')
    })

    it('after a restart, a new runner sees the job and keeps its settings', async () => {
      const connections = [connection('a', { updatedAt: 1 }), connection('b', { updatedAt: 2 })]
      const first = build(connections)
      await first.runner.start({ batchSize: 1, autoRun: false })
      first.runner.stop()
      await first.runner.runOnce()

      const restarted = new RotationRunner(first.agent as never, first.service, silentLogger())
      const status = await restarted.status()
      expect(status.job).toMatchObject({ status: 'running', batchSize: 1 })

      await restarted.runOnce()
      expect(first.rotated).toEqual(['b', 'a'])
      expect((await restarted.status()).job.status).toBe('completed')
    })

    it('resume does nothing unless a job was running', async () => {
      const { runner, rotated } = build([connection('a')])

      await runner.resume()
      await new Promise((resolve) => setTimeout(resolve, 30))
      runner.stop()

      expect(rotated).toEqual([])
    })

    it('resume continues a running job without being told to start it', async () => {
      const { runner, rotated, agent, service } = build([connection('a')])
      await runner.start({ batchSize: 5, intervalMs: 10_000 })
      runner.stop()

      const restarted = new RotationRunner(agent as never, service, silentLogger())
      await restarted.resume()
      await new Promise((resolve) => setTimeout(resolve, 100))
      restarted.stop()

      expect(rotated).toEqual(['a'])
    })
  })

  describe('status', () => {
    it('counts every completed connection in its bucket', async () => {
      const now = Date.now()
      const connections = [
        connection('p1'),
        connection('p2'),
        connection('w', {
          marker: true,
          rotation: { state: 'sent', newDid: 'n', attempts: 1, sentAt: new Date(now).toISOString() },
        }),
        connection('s', {
          marker: true,
          rotation: { state: 'sent', newDid: 'n', attempts: 1, sentAt: new Date(now - 31 * 86_400_000).toISOString() },
        }),
        connection('r', { rotation: { state: 'sent', newDid: 'n', attempts: 1, sentAt: new Date(now).toISOString() } }),
        connection('u1', { rotation: { state: 'confirmed', newDid: 'n', attempts: 1 } }),
        connection('u2', { rotation: { state: 'confirmed', newDid: 'n', attempts: 1 } }),
        connection('t', { rotation: { state: 'retry', newDid: 'n', attempts: 1 } }),
        connection('f', { rotation: { state: 'failed', newDid: 'n', attempts: 5 } }),
        connection('mediator', { mediator: true }),
        connection('not-ready', { state: DidCommDidExchangeState.RequestSent }),
      ]
      const { runner } = build(connections)

      const { counts, job } = await runner.status()

      expect(counts).toEqual({
        total: 9,
        pending: 2,
        waiting: 1,
        stale: 1,
        refused: 1,
        updated: 2,
        retrying: 1,
        failed: 1,
      })
      expect(job.status).toBe('idle')
    })
  })
})
