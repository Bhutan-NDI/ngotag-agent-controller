import { DidCommConnectionRecord, DidCommDidExchangeRole, DidCommDidExchangeState } from '@credo-ts/didcomm'

import {
  CREDO_DID_ROTATE_KEY,
  DEFAULT_STALE_AFTER_MS,
  MIGRATION_ROTATION_KEY,
  bucketFor,
  isNeverLeftError,
  retryDelayMs,
  staleAfterMs,
} from '../rotationMetadata'

const sendError = (...reasons: string[]) =>
  new Error(`Message is undeliverable to connection abc (holder). \n\nReasons:\n\t- ${reasons.join('\n\t-')}`)

const connection = (rotation?: object, credoMarker = false): DidCommConnectionRecord => {
  const record = new DidCommConnectionRecord({
    state: DidCommDidExchangeState.Completed,
    role: DidCommDidExchangeRole.Responder,
    did: 'did:peer:old',
    theirDid: 'did:peer:theirs',
  })
  if (rotation) record.metadata.set(MIGRATION_ROTATION_KEY, rotation)
  if (credoMarker) record.metadata.set(CREDO_DID_ROTATE_KEY, { threadId: 't', did: 'did:peer:new' })
  return record
}

describe('isNeverLeftError', () => {
  it.each([
    ['a refused connection', 'Error sending message to http://a.example.org: fetch failed (ECONNREFUSED)'],
    ['an unknown host', 'Error sending message to https://a.example.org: fetch failed (ENOTFOUND)'],
    ['a temporary DNS failure', 'Error sending message to https://a.example.org: fetch failed (EAI_AGAIN)'],
  ])('is true for %s', (_name, reason) => {
    expect(isNeverLeftError(sendError(reason))).toBe(true)
  })

  it('is true when every service the sender tried was unreachable', () => {
    expect(
      isNeverLeftError(
        sendError('Error sending message to http://a: fetch failed (ECONNREFUSED)', 'getaddrinfo ENOTFOUND b'),
      ),
    ).toBe(true)
  })

  it.each([
    ['a timeout', 'Error sending message to http://a: The operation was aborted (TIMEOUT)'],
    ['a connection reset', 'Error sending message to http://a: fetch failed (ECONNRESET)'],
    ['an unexplained failure', 'Error sending message to http://a: fetch failed'],
    ['a bad envelope', 'DidCommDidExchangeRequestMessage: Failed to validate class.'],
  ])('is false for %s', (_name, reason) => {
    expect(isNeverLeftError(sendError(reason))).toBe(false)
  })

  it('is false if any one service may have received it', () => {
    expect(
      isNeverLeftError(
        sendError(
          'Error sending message to http://a: fetch failed (ECONNREFUSED)',
          'Error sending message to http://b: fetch failed (ECONNRESET)',
        ),
      ),
    ).toBe(false)
  })

  it.each([
    ['an error with no reasons', new Error('something else ECONNREFUSED')],
    ['a non-error', 'ECONNREFUSED'],
    ['undefined', undefined],
  ])('is false for %s', (_name, value) => {
    expect(isNeverLeftError(value)).toBe(false)
  })
})

describe('retryDelayMs', () => {
  it('backs off exponentially and is capped', () => {
    expect([1, 2, 3, 4].map(retryDelayMs)).toEqual([60_000, 120_000, 240_000, 480_000])
    expect(retryDelayMs(30)).toBe(60 * 60 * 1000)
  })
})

describe('staleAfterMs', () => {
  it('is 30 days when the setting is absent', () => {
    expect(staleAfterMs({})).toBe(30 * 24 * 60 * 60 * 1000)
  })

  it('reads the setting in seconds', () => {
    expect(staleAfterMs({ MIGRATION_ROTATION_STALE_AFTER_SECONDS: '3600' })).toBe(3_600_000)
  })

  it.each(['', '0', '-5', '1.5', 'abc', ' '])('keeps the default for %j', (value) => {
    expect(staleAfterMs({ MIGRATION_ROTATION_STALE_AFTER_SECONDS: value })).toBe(DEFAULT_STALE_AFTER_MS)
  })
})

describe('bucketFor', () => {
  const now = new Date('2026-11-20T00:00:00Z')
  const sentAt = (ms: number) => new Date(now.getTime() - ms).toISOString()

  it.each([
    ['no rotation yet', undefined, false, 'pending'],
    ['a confirmed rotation', { state: 'confirmed', newDid: 'n', attempts: 1 }, false, 'updated'],
    ['a retry waiting to be sent again', { state: 'retry', newDid: 'n', attempts: 1 }, false, 'retrying'],
    ['a rotation that gave up', { state: 'failed', newDid: 'n', attempts: 5 }, false, 'failed'],
    [
      'a recently sent rotation awaiting its ack',
      { state: 'sent', newDid: 'n', attempts: 1, sentAt: sentAt(1000) },
      true,
      'waiting',
    ],
    [
      'a rotation with no answer for 30 days',
      { state: 'sent', newDid: 'n', attempts: 1, sentAt: sentAt(DEFAULT_STALE_AFTER_MS) },
      true,
      'stale',
    ],
    [
      'a rotation just under 30 days old',
      { state: 'sent', newDid: 'n', attempts: 1, sentAt: sentAt(DEFAULT_STALE_AFTER_MS - 1) },
      true,
      'waiting',
    ],
    [
      'a sent rotation whose marker was dropped by a problem report',
      { state: 'sent', newDid: 'n', attempts: 1, sentAt: sentAt(1000) },
      false,
      'refused',
    ],
  ])('puts %s in the right bucket', (_name, rotation, marker, bucket) => {
    expect(bucketFor(connection(rotation, marker), now)).toBe(bucket)
  })

  it('uses the stale threshold it is given', () => {
    const unanswered = connection({ state: 'sent', newDid: 'n', attempts: 1, sentAt: sentAt(3_600_000) }, true)

    expect(bucketFor(unanswered, now, 3_600_000)).toBe('stale')
    expect(bucketFor(unanswered, now, 3_600_001)).toBe('waiting')
  })

  it('reads the threshold from MIGRATION_ROTATION_STALE_AFTER_SECONDS when none is given', () => {
    const unanswered = connection({ state: 'sent', newDid: 'n', attempts: 1, sentAt: sentAt(3_600_000) }, true)
    const previous = process.env.MIGRATION_ROTATION_STALE_AFTER_SECONDS
    try {
      process.env.MIGRATION_ROTATION_STALE_AFTER_SECONDS = '3600'
      expect(bucketFor(unanswered, now)).toBe('stale')
      delete process.env.MIGRATION_ROTATION_STALE_AFTER_SECONDS
      expect(bucketFor(unanswered, now)).toBe('waiting')
    } finally {
      if (undefined === previous) delete process.env.MIGRATION_ROTATION_STALE_AFTER_SECONDS
      else process.env.MIGRATION_ROTATION_STALE_AFTER_SECONDS = previous
    }
  })

  it('counts a connection already on the new DID as updated, even though the commit did not land', () => {
    const moved = connection({ state: 'sent', newDid: 'did:peer:moved', attempts: 1, sentAt: sentAt(1000) }, false)
    moved.did = 'did:peer:moved'

    expect(bucketFor(moved, now)).toBe('updated')
  })
})
