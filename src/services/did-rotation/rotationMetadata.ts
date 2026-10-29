import type { DidCommConnectionRecord } from '@credo-ts/didcomm'

// Credo's own marker for a rotation that is waiting for its ack. The key is not exported by @credo-ts/didcomm; the
// real-agent tests fail if a Credo upgrade changes it.
export const CREDO_DID_ROTATE_KEY = '_internal/didRotate'

// Our record of where a connection is in the migration rotation, kept on the connection itself so the job's progress
// survives a restart.
export const MIGRATION_ROTATION_KEY = 'migrationRotation'

export type RotationState = 'sent' | 'retry' | 'failed' | 'confirmed'

export interface MigrationRotation {
  state: RotationState
  newDid: string
  attempts: number
  sentAt?: string
  nextAttemptAt?: string
  confirmedAt?: string
  confirmedVia?: 'ack' | 'first-message'
  error?: string
}

export interface PendingCredoRotation {
  threadId: string
  did: string
  mediatorId?: string
}

// After this long without an ack the connection is reported stale. It keeps working through forwarding, and the
// rotation still commits if the holder ever uses the new DID.
export const STALE_AFTER_MS = 30 * 24 * 60 * 60 * 1000
export const MAX_SEND_ATTEMPTS = 5
const RETRY_BACKOFF_BASE_MS = 60_000
const RETRY_BACKOFF_MAX_MS = 60 * 60 * 1000

export const retryDelayMs = (attempts: number): number =>
  Math.min(RETRY_BACKOFF_BASE_MS * 2 ** Math.max(attempts - 1, 0), RETRY_BACKOFF_MAX_MS)

export const getRotation = (connection: DidCommConnectionRecord): MigrationRotation | null =>
  connection.metadata.get<MigrationRotation>(MIGRATION_ROTATION_KEY)

export const getPendingCredoRotation = (connection: DidCommConnectionRecord): PendingCredoRotation | null =>
  connection.metadata.get<PendingCredoRotation>(CREDO_DID_ROTATE_KEY)

const NEVER_LEFT_PATTERN = /ECONNREFUSED|ENOTFOUND|EAI_AGAIN/

/**
 * Whether a failed send provably never reached the other agent, so the same rotation can be sent again. Credo
 * folds the transports' errors into the text of one MessageSendingError, one "- reason" line per service it tried:
 * only when every reason is a refused connection or an unresolvable host is it safe. A timeout, a reset or an HTTP
 * answer could mean the message arrived, and re-sending a rotation the holder already applied is what the design
 * must avoid.
 */
export const isNeverLeftError = (error: unknown): boolean => {
  const message = (error as { message?: unknown })?.message
  if ('string' !== typeof message) return false
  const reasonsStart = message.indexOf('Reasons:')
  if (-1 === reasonsStart) return false
  const reasons = message
    .slice(reasonsStart + 'Reasons:'.length)
    .split('\n')
    .map((line) => line.replace(/^\s*-\s*/, '').trim())
    .filter((line) => '' !== line)
  return 0 < reasons.length && reasons.every((reason) => NEVER_LEFT_PATTERN.test(reason))
}

export type RotationBucket = 'pending' | 'retrying' | 'failed' | 'waiting' | 'stale' | 'refused' | 'updated'

export const bucketFor = (connection: DidCommConnectionRecord, now: Date): RotationBucket => {
  const rotation = getRotation(connection)
  if (!rotation) return 'pending'
  switch (rotation.state) {
    case 'confirmed':
      return 'updated'
    case 'retry':
      return 'retrying'
    case 'failed':
      return 'failed'
    default: {
      // The connection already moved to the new DID, even if the committer's own update did not land.
      if (connection.did === rotation.newDid) return 'updated'
      // Credo drops its marker when the holder answers the rotation with a problem report.
      if (!getPendingCredoRotation(connection)) return 'refused'
      const age = now.getTime() - new Date(rotation.sentAt ?? now).getTime()
      return age >= STALE_AFTER_MS ? 'stale' : 'waiting'
    }
  }
}
