import 'reflect-metadata'
import {
  DidCommConnectionRecord,
  DidCommConnectionService,
  DidCommDidExchangeRole,
  DidCommDidExchangeState,
  DidCommDidRotateService,
  DidCommMessageSender,
  DidCommRoutingService,
} from '@credo-ts/didcomm'
import { jest } from '@jest/globals'
import '@openwallet-foundation/askar-nodejs'
import { KdfMethod, Store, StoreKeyMethod } from '@openwallet-foundation/askar-shared'

import { RotationLease } from '../RotationLease'
import { RotationService } from '../RotationService'
import { CREDO_DID_ROTATE_KEY, MIGRATION_ROTATION_KEY } from '../rotationMetadata'

import { grantingLease, silentLogger } from './rotationTestSupport'

const record = (
  options: {
    rotation?: object
    marker?: boolean
    state?: DidCommDidExchangeState
    mediator?: boolean
    did?: string | null
  } = {},
) => {
  const connection = new DidCommConnectionRecord({
    id: 'c1',
    state: options.state ?? DidCommDidExchangeState.Completed,
    role: DidCommDidExchangeRole.Responder,
    did: null === options.did ? undefined : (options.did ?? 'did:peer:ours'),
    theirDid: 'did:peer:theirs',
    connectionTypes: options.mediator ? ['mediator'] : [],
  })
  if (options.rotation) connection.metadata.set(MIGRATION_ROTATION_KEY, options.rotation)
  if (options.marker) connection.metadata.set(CREDO_DID_ROTATE_KEY, { threadId: 't', did: 'n' })
  return connection
}

type Rotatable = { rotate: (id: string, options: object) => Promise<unknown> }

const service = (now = new Date('2026-11-01T00:00:00Z')) => new RotationService({} as never, silentLogger(), () => now)

describe('RotationService.skipReason', () => {
  it('lets a completed connection with both DIDs be rotated', () => {
    expect(service().skipReason(record())).toBeUndefined()
  })

  it.each([
    ['not completed', record({ state: DidCommDidExchangeState.RequestSent }), 'NOT_COMPLETED'],
    ['without our DID', record({ did: null }), 'NO_DID'],
    ['a mediator connection', record({ mediator: true }), 'MEDIATOR_CONNECTION'],
    [
      'a rotation already in flight',
      record({ marker: true, rotation: { state: 'sent', newDid: 'n', attempts: 1 } }),
      'ROTATION_IN_FLIGHT',
    ],
    ['already sent', record({ rotation: { state: 'sent', newDid: 'n', attempts: 1 } }), 'ALREADY_ROTATED'],
    ['already confirmed', record({ rotation: { state: 'confirmed', newDid: 'n', attempts: 1 } }), 'ALREADY_ROTATED'],
    ['failed', record({ rotation: { state: 'failed', newDid: 'n', attempts: 5 } }), 'FAILED'],
    [
      'a retry that is not due',
      record({ rotation: { state: 'retry', newDid: 'n', attempts: 1, nextAttemptAt: '2026-11-01T01:00:00Z' } }),
      'RETRY_NOT_DUE',
    ],
  ])('skips a connection that is %s', (_name, connection, reason) => {
    expect(service().skipReason(connection)).toBe(reason)
  })

  it('lets a retry through once it is due', () => {
    expect(
      service().skipReason(
        record({ rotation: { state: 'retry', newDid: 'n', attempts: 1, nextAttemptAt: '2026-10-31T23:00:00Z' } }),
      ),
    ).toBeUndefined()
  })

  it('force retries a failed connection and a retry that is not due, but never one already rotated', () => {
    const svc = service()

    expect(svc.skipReason(record({ rotation: { state: 'failed', newDid: 'n', attempts: 5 } }), true)).toBeUndefined()
    expect(
      svc.skipReason(
        record({ rotation: { state: 'retry', newDid: 'n', attempts: 1, nextAttemptAt: '2026-11-01T01:00:00Z' } }),
        true,
      ),
    ).toBeUndefined()
    expect(svc.skipReason(record({ rotation: { state: 'sent', newDid: 'n', attempts: 1 } }), true)).toBe(
      'ALREADY_ROTATED',
    )
    expect(svc.skipReason(record({ rotation: { state: 'confirmed', newDid: 'n', attempts: 1 } }), true)).toBe(
      'ALREADY_ROTATED',
    )
    expect(svc.skipReason(record({ marker: true, rotation: { state: 'sent', newDid: 'n', attempts: 1 } }))).toBe(
      'ROTATION_IN_FLIGHT',
    )
  })

  it('force sends a rotation again that was recorded as sent but still has its marker, since a shutdown may have cut it off', () => {
    expect(
      service().skipReason(record({ marker: true, rotation: { state: 'sent', newDid: 'n', attempts: 1 } }), true),
    ).toBeUndefined()
  })

  it('treats a Credo marker we have no record of as a rotation that was never sent, and lets it be redone', () => {
    expect(service().skipReason(record({ marker: true }))).toBeUndefined()
  })

  it('treats a marker next to a retry or failed record the same way, since only a sent record means it was sent', () => {
    const svc = service()

    expect(
      svc.skipReason(
        record({
          marker: true,
          rotation: { state: 'retry', newDid: 'n', attempts: 1, nextAttemptAt: '2026-10-31T23:00:00Z' },
        }),
      ),
    ).toBeUndefined()
    expect(
      svc.skipReason(record({ marker: true, rotation: { state: 'failed', newDid: 'n', attempts: 5 } }), true),
    ).toBeUndefined()
  })
})

describe('RotationService.rotateConnection with a leftover Credo marker', () => {
  it.each([
    ['no record', record({ marker: true }), false],
    [
      'a retry record',
      record({ marker: true, rotation: { state: 'retry', newDid: 'did:peer:new', attempts: 1 } }),
      false,
    ],
    [
      'a sent record that is forced',
      record({ marker: true, rotation: { state: 'sent', newDid: 'did:peer:new', attempts: 1 } }),
      true,
    ],
  ])('clears the marker before it creates the rotation, with %s', async (_name, connection, force) => {
    const calls: string[] = []
    const created: unknown[] = []
    const services = new Map<unknown, unknown>([
      [DidCommConnectionService, { getById: async () => connection, update: async () => void calls.push('update') }],
      [DidCommRoutingService, { getRouting: async () => ({}) }],
      [
        DidCommDidRotateService,
        {
          clearDidRotationData: async () => void calls.push('clear'),
          createRotate: async (_ctx: unknown, options: unknown) => {
            calls.push('create')
            created.push(options)
            return { toDid: 'did:peer:new' }
          },
        },
      ],
      [DidCommMessageSender, { sendMessage: async () => void calls.push('send') }],
    ])
    const agent = { context: {}, dependencyManager: { resolve: (token: unknown) => services.get(token) } }

    const hadRecord = Boolean(connection.metadata.get(MIGRATION_ROTATION_KEY))
    const outcome = await new RotationService(
      agent as never,
      silentLogger(),
      undefined,
      grantingLease,
    ).rotateConnection('c1', {
      force,
    })

    expect(outcome).toMatchObject({ outcome: 'sent', newDid: 'did:peer:new' })
    expect(calls).toEqual(['clear', 'create', 'update', 'send'])
    expect(created[0]).toMatchObject({ toDid: hadRecord ? 'did:peer:new' : undefined })
  })
})

describe('RotationService locking', () => {
  it('runs rotations of the same connection one after another and different connections side by side', async () => {
    const svc = service()
    const log: string[] = []
    jest.spyOn(svc as unknown as Rotatable, 'rotate').mockImplementation((async (id: string) => {
      log.push(`start ${id}`)
      await new Promise((resolve) => setTimeout(resolve, 10))
      log.push(`end ${id}`)
      return { connectionId: id, outcome: 'skipped', reason: 'X' }
    }) as never)

    await Promise.all([svc.rotateConnection('a'), svc.rotateConnection('a'), svc.rotateConnection('b')])

    expect(log.indexOf('end a')).toBeLessThan(log.lastIndexOf('start a'))
    expect(log.indexOf('start b')).toBeLessThan(log.indexOf('end a'))
  })

  it('keeps working after a rotation throws', async () => {
    const svc = service()
    const rotate = jest.spyOn(svc as unknown as Rotatable, 'rotate')
    rotate.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce({ connectionId: 'a', outcome: 'sent' })

    await expect(svc.rotateConnection('a')).rejects.toThrow('boom')
    await expect(svc.rotateConnection('a')).resolves.toMatchObject({ outcome: 'sent' })
  })
})

describe('RotationService across two tasks of one agent', () => {
  it('sends one rotation when two tasks pick the same connection at once, and leaves the other with ROTATION_IN_FLIGHT', async () => {
    const store = await Store.provision({
      uri: 'sqlite://:memory:',
      keyMethod: new StoreKeyMethod(KdfMethod.Raw),
      passKey: Store.generateRawKey(),
      recreate: true,
      profile: 'tasks',
    })
    const lease = new RotationLease(async () => ({ store, profile: 'tasks' }))
    const created: string[] = []
    const taskAgent = (taskId: string) => {
      const connection = record()
      const services = new Map<unknown, unknown>([
        [DidCommConnectionService, { getById: async () => connection, update: async () => undefined }],
        [DidCommRoutingService, { getRouting: async () => ({}) }],
        [
          DidCommDidRotateService,
          {
            clearDidRotationData: async () => undefined,
            createRotate: async () => {
              created.push(taskId)
              await new Promise((resolve) => setTimeout(resolve, 50))
              return { toDid: `did:peer:new-${taskId}` }
            },
          },
        ],
        [DidCommMessageSender, { sendMessage: async () => undefined }],
      ])
      return { context: {}, dependencyManager: { resolve: (token: unknown) => services.get(token) } }
    }
    const first = new RotationService(taskAgent('a') as never, silentLogger(), undefined, lease)
    const second = new RotationService(taskAgent('b') as never, silentLogger(), undefined, lease)

    try {
      const outcomes = await Promise.all([first.rotateConnection('c1'), second.rotateConnection('c1')])

      expect(created).toHaveLength(1)
      expect(outcomes.filter((outcome) => 'sent' === outcome.outcome)).toHaveLength(1)
      expect(outcomes).toContainEqual({ connectionId: 'c1', outcome: 'skipped', reason: 'ROTATION_IN_FLIGHT' })
      // Whichever task lost can rotate once the winner has let go of the lease.
      const loser = 'skipped' === outcomes[0].outcome ? first : second
      await expect(loser.rotateConnection('c1')).resolves.toMatchObject({ outcome: 'sent' })
    } finally {
      await store.close().catch(() => undefined)
    }
  }, 30000)

  it('frees the lease when a rotation throws, so the next attempt is not blocked', async () => {
    const acquire = jest.fn(async () => true)
    const release = jest.fn(async () => undefined)
    const svc = new RotationService({} as never, silentLogger(), undefined, { acquire, release })
    jest
      .spyOn(svc as unknown as { rotateLeased: () => Promise<unknown> }, 'rotateLeased')
      .mockRejectedValue(new Error('boom'))

    await expect(svc.rotateConnection('c1')).rejects.toThrow('boom')

    expect(release).toHaveBeenCalledWith('connection:c1', expect.any(String))
  })
})
