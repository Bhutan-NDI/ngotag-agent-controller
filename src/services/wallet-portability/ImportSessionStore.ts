import { Key, KeyAlgorithm } from '@openwallet-foundation/askar-shared'
import { randomUUID } from 'crypto'

// Same lifetime as the SAD's import-session key: long enough for a rehearsal or move-day import, short enough
// that an abandoned session does not hold a private key in memory for long.
export const IMPORT_SESSION_TTL_MS = 2 * 60 * 60 * 1000
const MAX_SESSIONS = 10

interface ImportSession {
  key: Key
  expiresAt: number
  timer: NodeJS.Timeout
}

export interface CreatedImportSession {
  sessionId: string
  importPublicKey: string
  expiresAt: string
}

// The private half lives only here, in this process's memory.
export class ImportSessionStore {
  private readonly sessions = new Map<string, ImportSession>()

  public create(): CreatedImportSession {
    if (this.sessions.size >= MAX_SESSIONS) {
      const oldest = this.sessions.keys().next().value as string
      this.destroy(oldest)
    }

    const key = Key.generate(KeyAlgorithm.X25519)
    const sessionId = randomUUID()
    const expiresAt = Date.now() + IMPORT_SESSION_TTL_MS
    const timer = setTimeout(() => this.destroy(sessionId), IMPORT_SESSION_TTL_MS)
    timer.unref()
    this.sessions.set(sessionId, { key, expiresAt, timer })

    return {
      sessionId,
      importPublicKey: Buffer.from(key.publicBytes).toString('base64'),
      expiresAt: new Date(expiresAt).toISOString(),
    }
  }

  public get(sessionId: string): Key | undefined {
    const session = this.sessions.get(sessionId)
    if (!session || session.expiresAt <= Date.now()) {
      this.destroy(sessionId)
      return undefined
    }
    return session.key
  }

  public destroy(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    clearTimeout(session.timer)
    session.key.handle.free()
    this.sessions.delete(sessionId)
  }

  public clear(): void {
    for (const sessionId of [...this.sessions.keys()]) this.destroy(sessionId)
  }
}
