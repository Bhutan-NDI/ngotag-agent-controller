import {
  DidCommConnectionRecord,
  DidCommConnectionEventTypes,
  DidCommDidExchangeRole,
  DidCommDidExchangeState,
  DidCommEventTypes,
} from '@credo-ts/didcomm'
import { jest } from '@jest/globals'

import { PendingRotationCommitter } from '../PendingRotationCommitter'
import { CREDO_DID_ROTATE_KEY, MIGRATION_ROTATION_KEY } from '../rotationMetadata'

import { eventually, silentLogger } from './rotationTestSupport'

const connection = (options: { marker?: boolean; rotation?: object } = {}) => {
  const record = new DidCommConnectionRecord({
    id: 'c1',
    state: DidCommDidExchangeState.Completed,
    role: DidCommDidExchangeRole.Responder,
    did: 'did:peer:old',
    theirDid: 'did:peer:theirs',
    previousDids: ['did:peer:new'],
  })
  if (options.marker) record.metadata.set(CREDO_DID_ROTATE_KEY, { threadId: 't', did: 'did:peer:new' })
  if (options.rotation) record.metadata.set(MIGRATION_ROTATION_KEY, options.rotation)
  return record
}

const harness = (stored: DidCommConnectionRecord | null) => {
  const listeners = new Map<string, ((event: { payload: unknown }) => void)[]>()
  const findById = jest.fn(async () => stored)
  const update = jest.fn(async () => undefined)
  const agent = {
    context: {},
    events: {
      on: (type: string, listener: (event: { payload: unknown }) => void) =>
        listeners.set(type, [...(listeners.get(type) ?? []), listener]),
      off: (type: string, listener: unknown) =>
        listeners.set(
          type,
          (listeners.get(type) ?? []).filter((l) => l !== listener),
        ),
    },
    dependencyManager: { resolve: () => ({ findById, update }) },
  }
  const stop = new PendingRotationCommitter(
    agent as never,
    silentLogger(),
    () => new Date('2026-11-01T00:00:00Z'),
  ).attach()
  const fire = (type: string, payload: unknown) =>
    (listeners.get(type) ?? []).forEach((listener) => listener({ payload }))
  return { fire, findById, update, stop, listeners }
}

describe('PendingRotationCommitter', () => {
  it('does not read the connection for a message on a connection with no rotation pending', async () => {
    const { fire, findById } = harness(connection())

    fire(DidCommEventTypes.DidCommMessageProcessed, { connection: connection(), encryptedMessage: { protected: 'x' } })
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(findById).not.toHaveBeenCalled()
  })

  it('ignores a processed message that carries no encrypted envelope', async () => {
    const { fire, findById } = harness(connection({ marker: true }))

    fire(DidCommEventTypes.DidCommMessageProcessed, { connection: connection({ marker: true }) })
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(findById).not.toHaveBeenCalled()
  })

  it('finishes a rotation when Credo commits it: confirms, and takes the new DID out of previousDids', async () => {
    const stored = connection({ rotation: { state: 'sent', newDid: 'did:peer:new', attempts: 1, sentAt: 'x' } })
    const { fire, update } = harness(stored)

    fire(DidCommConnectionEventTypes.DidCommConnectionDidRotated, {
      connectionRecord: stored,
      ourDid: { from: 'did:peer:old', to: 'did:peer:new' },
    })

    await eventually(() => 1 === update.mock.calls.length)
    expect(stored.previousDids).toEqual([])
    expect(stored.metadata.get(MIGRATION_ROTATION_KEY)).toMatchObject({
      state: 'confirmed',
      confirmedVia: 'ack',
      confirmedAt: '2026-11-01T00:00:00.000Z',
    })
  })

  it.each([
    [
      "a rotation of the holder's DID rather than ours",
      { connectionRecord: connection(), theirDid: { from: 'a', to: 'b' } },
    ],
    [
      'a rotation to a DID this job did not send',
      { connectionRecord: connection(), ourDid: { from: 'did:peer:old', to: 'did:peer:other' } },
    ],
  ])('leaves %s alone', async (_name, payload) => {
    const stored = connection({ rotation: { state: 'sent', newDid: 'did:peer:new', attempts: 1 } })
    const { fire, update } = harness(stored)

    fire(DidCommConnectionEventTypes.DidCommConnectionDidRotated, payload)
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(update).not.toHaveBeenCalled()
    expect(stored.previousDids).toEqual(['did:peer:new'])
  })

  it('leaves a connection this job never rotated alone', async () => {
    const stored = connection()
    const { fire, update } = harness(stored)

    fire(DidCommConnectionEventTypes.DidCommConnectionDidRotated, {
      connectionRecord: stored,
      ourDid: { from: 'did:peer:old', to: 'did:peer:new' },
    })
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(update).not.toHaveBeenCalled()
  })

  it('stops listening when told to', () => {
    const { stop, listeners } = harness(connection())

    stop()

    expect(listeners.get(DidCommEventTypes.DidCommMessageProcessed)).toEqual([])
    expect(listeners.get(DidCommConnectionEventTypes.DidCommConnectionDidRotated)).toEqual([])
  })
})
