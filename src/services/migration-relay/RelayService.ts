import type { RelayDrainer } from './RelayDrainer'
import type { RelayEntry, RelayMode, RelayStore } from './RelayStore'
import type { RestMultiTenantAgentModules } from '../../cliAgent'
import type { TsLogger } from '../../utils/logger'
import type { Agent, BaseEvent, BaseRecord, GenericRecord, StorageService } from '@credo-ts/core'

import { EventEmitter, InjectionSymbols } from '@credo-ts/core'
import { DidCommEventTypes, DidCommRoutingEventTypes } from '@credo-ts/didcomm'
import { TenantRoutingRecord } from '@credo-ts/tenants'
import { randomUUID } from 'crypto'

import { RelayMirror } from './RelayMirror'
import { MIRROR_REFRESH_MS, PROBE_TIMEOUT_MS, REINJECT_PROCESSED_TIMEOUT_MS } from './relayConfig'
import { TLS_ERROR_CODES } from './relayForwarder'
import { assertValidRelayTarget } from './relayTarget'

type RootAgent = Agent<RestMultiTenantAgentModules>

export type RelayConflictCode =
  | 'RELAY_TRANSITION_NOT_ALLOWED'
  | 'RELAY_NOT_REMOVABLE'
  | 'RELAY_BUFFER_NOT_EMPTY'
  | 'RELAY_NOT_HOLDING'
  | 'RELAY_BUSY'

export class RelayConflictError extends Error {
  public constructor(public readonly code: RelayConflictCode) {
    super(code)
    this.name = 'RelayConflictError'
  }
}

export class RelayNotFoundError extends Error {
  public constructor(tenantId: string) {
    super(`No relay entry for tenant '${tenantId}'.`)
    this.name = 'RelayNotFoundError'
  }
}

export interface RelayServiceOptions {
  probeFetch?: typeof fetch
  probeTimeoutMs?: number
  reinjectTimeoutMs?: number
}

export interface RelayStatus extends RelayEntry {
  holdCount: number
  recipientKeys: number
  forwardedLast30Days: number
}

export type ProbeReason = 'UNREACHABLE' | 'DNS' | 'TLS' | 'TIMEOUT'
export interface ProbeResult {
  reachable: boolean
  status?: number
  reason?: ProbeReason
}

const RECORD_TAG = 'migrationRelay'
const recordId = (tenantId: string): string => `migration-relay-${tenantId}`

/**
 * Admin operations on the migration relay. The relay entry is stored twice on purpose: as a GenericRecord in the base
 * wallet, which is the source of truth and survives a Redis flush, and in Redis, which is what the hot path reads.
 */
export class RelayService {
  public readonly mirror = new RelayMirror()
  private mirrorTimer?: NodeJS.Timeout

  public constructor(
    private readonly store: RelayStore,
    private readonly drainer: RelayDrainer,
    private readonly logger: TsLogger,
    private readonly options: RelayServiceOptions = {},
  ) {}

  public async health(): Promise<{ enabled: true; redisReady: boolean }> {
    return { enabled: true, redisReady: await this.store.isReady() }
  }

  /**
   * Sets the relay for a tenant. none -> HOLD -> FORWARD only: a FORWARD relay never goes back to HOLD, because the
   * tenant's data has by then moved. Re-sending the same mode re-indexes the tenant's recipient keys.
   */
  public async put(
    agent: RootAgent,
    tenantId: string,
    request: { mode: RelayMode; target?: string },
  ): Promise<RelayStatus> {
    const target = 'FORWARD' === request.mode ? assertValidRelayTarget(request.target) : undefined
    if ('FORWARD' !== request.mode && undefined !== request.target) {
      throw new RelayConflictError('RELAY_TRANSITION_NOT_ALLOWED')
    }

    await agent.modules.tenants.getTenantById(tenantId)

    const existing = await this.findRecord(agent, tenantId)
    if (existing?.content.mode === 'FORWARD' && 'HOLD' === request.mode) {
      throw new RelayConflictError('RELAY_TRANSITION_NOT_ALLOWED')
    }
    if (existing && 'FORWARD' === existing.content.mode && target && existing.content.target !== target) {
      this.logger.warn(`[RelayService] retargeting the FORWARD relay of tenant '${tenantId}'`)
    }

    const entry: RelayEntry = { tenantId, mode: request.mode, target, updatedAt: new Date().toISOString() }

    await this.saveRecord(agent, existing, entry)
    this.mirror.setEntry(entry)
    await this.store.clearRemoved(tenantId)
    await this.store.setEntry(entry)
    // Listed only after the entry exists, so a key created in between is indexed by the routing-key watcher.
    const fingerprints = await this.listFingerprints(agent, tenantId)
    for (const fingerprint of fingerprints) this.mirror.addFingerprint(tenantId, fingerprint)
    await this.store.indexKeys(tenantId, fingerprints)
    if ('FORWARD' === entry.mode) this.drainer.ensureDraining(tenantId)

    return this.status(entry, fingerprints.length)
  }

  public async get(agent: RootAgent, tenantId: string): Promise<RelayStatus> {
    const record = await this.findRecord(agent, tenantId)
    if (!record) throw new RelayNotFoundError(tenantId)
    const entry = record.content as unknown as RelayEntry
    return this.status(entry, (await this.listFingerprints(agent, tenantId)).length)
  }

  /** Removes a HOLD relay (an aborted move). A FORWARD relay is permanent, and a buffer must be re-injected first. */
  public async remove(agent: RootAgent, tenantId: string): Promise<void> {
    const record = await this.findRecord(agent, tenantId)
    if (!record) {
      // An earlier call may have deleted the record and then failed before clearing Redis: finish that.
      if (!(await this.store.getEntry(tenantId))) throw new RelayNotFoundError(tenantId)
      if (0 < (await this.store.holdLength(tenantId))) throw new RelayConflictError('RELAY_BUFFER_NOT_EMPTY')
      await this.dropFromRedis(agent, tenantId)
      return
    }
    if ('HOLD' !== record.content.mode) throw new RelayConflictError('RELAY_NOT_REMOVABLE')
    if (0 < (await this.store.holdLength(tenantId))) throw new RelayConflictError('RELAY_BUFFER_NOT_EMPTY')

    // The record goes first: a task still restoring this entry from an older read then finds no record and backs out.
    await agent.genericRecords.delete(record)
    await this.dropFromRedis(agent, tenantId)
  }

  // The tombstone tells other tasks, whose mirror still holds the entry for up to a refresh, to let the message through.
  private async dropFromRedis(agent: RootAgent, tenantId: string): Promise<void> {
    await this.store.markRemoved(tenantId)
    await this.store.removeKeys(await this.listFingerprints(agent, tenantId))
    await this.store.deleteEntry(tenantId)
    this.mirror.remove(tenantId)
  }

  /**
   * Feeds the HOLD buffer back to Credo as if the messages had just arrived (an aborted move). Returns how many were
   * processed and how many did not finish within the timeout.
   */
  public async reinject(agent: RootAgent, tenantId: string): Promise<{ injected: number; failed: number }> {
    const record = await this.findRecord(agent, tenantId)
    if (!record) throw new RelayNotFoundError(tenantId)
    if ('HOLD' !== record.content.mode) throw new RelayConflictError('RELAY_NOT_HOLDING')

    const token = randomUUID()
    if (!(await this.store.acquireDrainLock(tenantId, token))) throw new RelayConflictError('RELAY_BUSY')
    try {
      const eventEmitter = agent.dependencyManager.resolve(EventEmitter)
      let injected = 0
      let failed = 0
      for (;;) {
        const envelope = await this.store.holdPeek(tenantId)
        if (!envelope) break
        try {
          const message = JSON.parse(envelope.body)
          const processed = this.waitForProcessed(eventEmitter, message)
          eventEmitter.emit(agent.context, { type: DidCommEventTypes.DidCommMessageReceived, payload: { message } })
          await processed
          injected += 1
        } catch (error) {
          failed += 1
          this.logger.error(`[RelayService] re-injecting a held message for tenant '${tenantId}' failed: ${error}`)
        }
        await this.store.holdPop(tenantId)
        if (!(await this.store.refreshDrainLock(tenantId, token))) throw new RelayConflictError('RELAY_BUSY')
      }
      return { injected, failed }
    } finally {
      await this.store.releaseDrainLock(tenantId, token).catch(() => undefined)
    }
  }

  // Same completion signal the HTTP inbound transport waits for before it answers a request.
  private waitForProcessed(eventEmitter: EventEmitter, message: unknown): Promise<void> {
    return new Promise((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined
      const listener = (event: BaseEvent): void => {
        if ((event.payload as { encryptedMessage?: unknown }).encryptedMessage === message) {
          if (timer) clearTimeout(timer)
          eventEmitter.off(DidCommEventTypes.DidCommMessageProcessed, listener)
          resolve()
        }
      }
      timer = setTimeout(() => {
        eventEmitter.off(DidCommEventTypes.DidCommMessageProcessed, listener)
        reject(new Error('Timed out waiting for the message to be processed'))
      }, this.options.reinjectTimeoutMs ?? REINJECT_PROCESSED_TIMEOUT_MS)
      eventEmitter.on(DidCommEventTypes.DidCommMessageProcessed, listener)
    })
  }

  /** Whether the target's DIDComm address can be reached over HTTPS with a valid certificate. */
  public async probe(target: string): Promise<ProbeResult> {
    const url = assertValidRelayTarget(target)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.options.probeTimeoutMs ?? PROBE_TIMEOUT_MS)
    try {
      const response = await (this.options.probeFetch ?? fetch)(url, {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
      })
      await response.body?.cancel().catch(() => undefined)
      return { reachable: true, status: response.status }
    } catch (error) {
      const code = (error as { cause?: { code?: unknown } })?.cause?.code
      if (controller.signal.aborted) return { reachable: false, reason: 'TIMEOUT' }
      if ('string' === typeof code && TLS_ERROR_CODES.has(code)) return { reachable: false, reason: 'TLS' }
      if ('ENOTFOUND' === code || 'EAI_AGAIN' === code) return { reachable: false, reason: 'DNS' }
      return { reachable: false, reason: 'UNREACHABLE' }
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Indexes a recipient key the moment Credo creates it for a tenant that has a relay. Without this, a key created
   * after the relay was set (an in-flight exchange, a new invitation) would be missing from the index, and messages
   * addressed to it would bypass the relay. Call once at startup; returns a function that stops watching.
   */
  public watchRoutingKeys(agent: RootAgent): () => void {
    const eventEmitter = agent.dependencyManager.resolve(EventEmitter)
    const listener = (event: BaseEvent): void => {
      const contextCorrelationId = event.metadata?.contextCorrelationId
      if ('string' !== typeof contextCorrelationId || !contextCorrelationId.startsWith('tenant-')) return
      const tenantId = contextCorrelationId.replace('tenant-', '')
      const fingerprint = (event.payload as { routing?: { recipientKey?: { fingerprint?: string } } }).routing
        ?.recipientKey?.fingerprint
      if (!fingerprint) return

      this.mirror.addFingerprint(tenantId, fingerprint)
      this.store
        .getEntry(tenantId)
        .then((entry) => (entry ? this.store.indexKeys(tenantId, [fingerprint]) : undefined))
        .catch((error) =>
          this.logger.error(`[RelayService] could not index a new recipient key for '${tenantId}': ${error}`),
        )
    }
    eventEmitter.on(DidCommRoutingEventTypes.RoutingCreatedEvent, listener)
    return () => eventEmitter.off(DidCommRoutingEventTypes.RoutingCreatedEvent, listener)
  }

  /** Rebuilds the Redis state of every relay from the base wallet, at startup and after a Redis flush. */
  public async rehydrate(agent: RootAgent): Promise<number> {
    const startedAt = Date.now()
    const loaded = await this.loadRelays(agent)
    this.mirror.merge(loaded, startedAt)
    for (const { entry, fingerprints } of loaded) {
      await this.restoreToRedis(agent, entry, fingerprints)
    }
    return loaded.length
  }

  /**
   * Re-reads the relay entries into this process's mirror and puts back, in Redis, any entry Redis has lost. An entry
   * that is there is left alone, so a change made through another task is never overwritten with an older record.
   */
  public async refreshMirror(agent: RootAgent): Promise<void> {
    const startedAt = Date.now()
    const loaded = await this.loadRelays(agent)
    this.mirror.merge(loaded, startedAt)
    if (!(await this.store.isReady())) return
    for (const { entry, fingerprints } of loaded) {
      if (!(await this.store.getEntry(entry.tenantId))) await this.restoreToRedis(agent, entry, fingerprints)
    }
  }

  /** Keeps the mirror fresh until `stop` is called. */
  public startMirror(agent: RootAgent, intervalMs: number = MIRROR_REFRESH_MS): void {
    this.stop()
    this.mirrorTimer = setInterval(() => {
      this.refreshMirror(agent).catch((error) =>
        this.logger.error(`[RelayService] could not refresh the relay mirror: ${error}`),
      )
    }, intervalMs)
    this.mirrorTimer.unref()
  }

  public stop(): void {
    if (this.mirrorTimer) clearInterval(this.mirrorTimer)
    this.mirrorTimer = undefined
  }

  private async loadRelays(agent: RootAgent): Promise<Array<{ entry: RelayEntry; fingerprints: string[] }>> {
    const records = await agent.genericRecords.findAllByQuery({ [RECORD_TAG]: 'true' })
    const relays = []
    for (const record of records) {
      const entry = record.content as unknown as RelayEntry
      relays.push({ entry, fingerprints: await this.listFingerprints(agent, entry.tenantId) })
    }
    return relays
  }

  // The entry is only set if still absent, and the record is read again afterwards: the snapshot this came from may
  // predate a change or a removal made through another task.
  private async restoreToRedis(agent: RootAgent, entry: RelayEntry, fingerprints: string[]): Promise<void> {
    await this.store.indexKeys(entry.tenantId, fingerprints)
    const created = await this.store.setEntryIfAbsent(entry)
    if (created && !(await this.findRecord(agent, entry.tenantId))) {
      await this.store.deleteEntry(entry.tenantId)
      await this.store.removeKeys(fingerprints)
      return
    }
    const current = created ? entry : await this.store.getEntry(entry.tenantId)
    if ('FORWARD' === current?.mode && 0 < (await this.store.holdLength(entry.tenantId))) {
      this.drainer.ensureDraining(entry.tenantId)
    }
  }

  private async status(entry: RelayEntry, recipientKeys: number): Promise<RelayStatus> {
    return {
      ...entry,
      holdCount: await this.store.holdLength(entry.tenantId),
      recipientKeys,
      forwardedLast30Days: await this.store.messagesInLastDays(entry.tenantId, 30),
    }
  }

  private findRecord(agent: RootAgent, tenantId: string): Promise<GenericRecord | null> {
    return agent.genericRecords.findById(recordId(tenantId))
  }

  private async saveRecord(agent: RootAgent, existing: GenericRecord | null, entry: RelayEntry): Promise<void> {
    if (existing) {
      existing.content = { ...entry }
      await agent.genericRecords.update(existing)
      return
    }
    await agent.genericRecords.save({
      id: recordId(entry.tenantId),
      content: { ...entry },
      tags: { [RECORD_TAG]: 'true', relayTenantId: entry.tenantId },
    })
  }

  private async listFingerprints(agent: RootAgent, tenantId: string): Promise<string[]> {
    const storage = agent.dependencyManager.resolve<StorageService<BaseRecord>>(InjectionSymbols.StorageService)
    const records = await storage.findByQuery(agent.context, TenantRoutingRecord, { tenantId })
    return (records as TenantRoutingRecord[]).map((record) => record.recipientKeyFingerprint)
  }
}
