import type { RelayEntry } from './RelayStore'

interface MirroredRelay {
  entry: RelayEntry
  fingerprints: Set<string>
  seenAt: number
}

/**
 * This process's copy of which recipient keys belong to a tenant with a relay, read from the base wallet. The hot path
 * asks Redis first; when Redis is down or has lost the entry, this tells it a message must still be relayed, not
 * handed to a wallet that has moved.
 */
export class RelayMirror {
  private readonly byTenant = new Map<string, MirroredRelay>()

  public find(fingerprints: string[]): RelayEntry | undefined {
    for (const relay of this.byTenant.values()) {
      if (fingerprints.some((fingerprint) => relay.fingerprints.has(fingerprint))) return relay.entry
    }
    return undefined
  }

  public has(tenantId: string): boolean {
    return this.byTenant.has(tenantId)
  }

  public set(entry: RelayEntry, fingerprints: string[], now: number = Date.now()): void {
    this.byTenant.set(entry.tenantId, { entry, fingerprints: new Set(fingerprints), seenAt: now })
  }

  public setEntry(entry: RelayEntry, now: number = Date.now()): void {
    const current = this.byTenant.get(entry.tenantId)
    this.byTenant.set(entry.tenantId, { entry, fingerprints: current?.fingerprints ?? new Set(), seenAt: now })
  }

  public addFingerprint(tenantId: string, fingerprint: string): void {
    this.byTenant.get(tenantId)?.fingerprints.add(fingerprint)
  }

  public remove(tenantId: string): void {
    this.byTenant.delete(tenantId)
  }

  /**
   * Takes in what a refresh read from the base wallet. A tenant whose relay was set or changed after the refresh
   * started is left alone, so a refresh never undoes a change made while it was reading.
   */
  public merge(loaded: Array<{ entry: RelayEntry; fingerprints: string[] }>, startedAt: number): void {
    const present = new Set<string>()
    for (const { entry, fingerprints } of loaded) {
      present.add(entry.tenantId)
      const current = this.byTenant.get(entry.tenantId)
      if (current && current.seenAt >= startedAt) continue
      this.set(entry, fingerprints, startedAt)
    }
    for (const [tenantId, relay] of this.byTenant) {
      if (!present.has(tenantId) && relay.seenAt < startedAt) this.byTenant.delete(tenantId)
    }
  }
}
