import { DidCommConnectionRecord, DidCommDidExchangeRole, DidCommDidExchangeState } from '@credo-ts/didcomm'
import { jest } from '@jest/globals'

import { RotationService } from '../RotationService'
import { CREDO_DID_ROTATE_KEY, MIGRATION_ROTATION_KEY } from '../rotationMetadata'

import { silentLogger } from './rotationTestSupport'

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
    ['a rotation already in flight', record({ marker: true }), 'ROTATION_IN_FLIGHT'],
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
    expect(svc.skipReason(record({ marker: true }), true)).toBe('ROTATION_IN_FLIGHT')
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
