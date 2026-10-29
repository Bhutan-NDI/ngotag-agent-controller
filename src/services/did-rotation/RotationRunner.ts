import type { RotationService } from './RotationService'
import type { RotationBucket } from './rotationMetadata'
import type { TsLogger } from '../../utils/logger'
import type { Agent } from '@credo-ts/core'
import type { DidCommConnectionRecord } from '@credo-ts/didcomm'

import { DidCommConnectionService, DidCommDidExchangeState } from '@credo-ts/didcomm'
import { randomUUID } from 'crypto'

import { type Leasing, RUNNER_LEASE, RotationLease } from './RotationLease'
import { bucketFor } from './rotationMetadata'

export const DEFAULT_BATCH_SIZE = 50
export const DEFAULT_INTERVAL_MS = 60_000
const PAGE_SIZE = 500
const JOB_RECORD_ID = 'migration-rotation-job'
const STATUS_CACHE_MS = 5_000
// Renewed before each connection, so it only has to outlast one rotation; a task that dies frees the runner soon after.
const RUNNER_LEASE_MS = 90_000

export type JobStatus = 'idle' | 'running' | 'completed'

export interface RotationJob {
  status: JobStatus
  batchSize: number
  intervalMs: number
  startedAt?: string
  completedAt?: string
  // Set once, when the first job starts: a connection created after it is already on this agent and is never rotated.
  cutoff?: string
}

export type RotationCounts = Record<RotationBucket, number> & { total: number }

export interface RotationStatus {
  job: RotationJob
  counts: RotationCounts
}

export interface StartOptions {
  batchSize?: number
  intervalMs?: number
  // Set false to only record the job and leave running batches to the caller.
  autoRun?: boolean
}

const emptyCounts = (): RotationCounts => ({
  total: 0,
  pending: 0,
  retrying: 0,
  failed: 0,
  waiting: 0,
  stale: 0,
  refused: 0,
  updated: 0,
})

/**
 * Walks an organisation's connections and rotates them in bounded batches, most recently active first, so the holders
 * who are most likely online get the change of address first. Progress lives on the connections (see
 * rotationMetadata), so a restart picks up where it stopped; the job record only remembers that it was running.
 */
export class RotationRunner {
  private timer?: NodeJS.Timeout
  private ticking = false
  // Batches never overlap, whether they come from the timer or from a caller.
  private queue: Promise<unknown> = Promise.resolve()
  private stopped = false
  private halted = false
  // Across the tasks of one agent only one runs batches at a time (see RotationLease).
  private readonly owner = randomUUID()
  private cachedStatus?: { at: number; value: RotationStatus }

  public constructor(
    private readonly agent: Agent,
    private readonly rotation: RotationService,
    private readonly logger: TsLogger,
    private readonly now: () => Date = () => new Date(),
    private readonly lease: Leasing = RotationLease.forAgent(agent),
  ) {}

  /** Starts the job, or reports the one already running. */
  public async start(options: StartOptions = {}): Promise<RotationStatus> {
    const current = await this.loadJob()
    if ('running' === current.status) {
      // A running job with nothing scheduled is one whose loop died; this call is what revives it.
      if (false !== options.autoRun && !this.timer && !this.ticking) {
        this.stopped = false
        this.schedule(0)
      }
      return this.status()
    }

    const batchSize = this.validPositive(options.batchSize, DEFAULT_BATCH_SIZE)
    const intervalMs = this.validPositive(options.intervalMs, DEFAULT_INTERVAL_MS)
    await this.saveJob({
      status: 'running',
      batchSize,
      intervalMs,
      startedAt: this.now().toISOString(),
      cutoff: current.cutoff ?? this.now().toISOString(),
    })
    this.stopped = false
    if (false !== options.autoRun) this.schedule(0)
    return this.status()
  }

  /** Continues a job that was running when the agent last stopped. */
  public async resume(): Promise<void> {
    const job = await this.loadJob()
    if ('running' !== job.status) return
    this.stopped = false
    this.schedule(0)
  }

  /** For a shutdown: the batch in progress sends no further connections, so it ends after the one it is on. */
  public halt(): void {
    this.halted = true
  }

  /** Stops scheduling and resolves once the batch in progress has finished, so a shutdown does not cut a send short. */
  public stop(): Promise<void> {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    return this.queue.then(() => undefined)
  }

  /**
   * Rotates the next batch. Returns what it did, and finishes the job when nothing is left to do.
   */
  public runOnce(): Promise<{ rotated: number; remaining: number }> {
    const next = this.queue.then(() => this.runBatch())
    this.queue = next.catch(() => undefined)
    return next
  }

  private async runBatch(): Promise<{ rotated: number; remaining: number }> {
    const job = await this.loadJob()
    const connections = await this.allCompleted()
    const due = connections
      .filter((connection) => !this.isNative(connection, job) && undefined === this.rotation.skipReason(connection))
      .sort((a, b) => (b.updatedAt?.getTime() ?? 0) - (a.updatedAt?.getTime() ?? 0))

    const batch = due.slice(0, job.batchSize)
    let attempted = 0
    // Another task of this agent running the batch (a deploy overlaps two) means this one leaves it alone.
    if (await this.lease.acquire(RUNNER_LEASE, this.owner, RUNNER_LEASE_MS)) {
      try {
        for (const connection of batch) {
          if (this.halted || !(await this.lease.acquire(RUNNER_LEASE, this.owner, RUNNER_LEASE_MS))) break
          attempted += 1
          try {
            await this.rotation.rotateConnection(connection.id)
          } catch (error) {
            this.logger.error(`[RotationRunner] could not rotate connection '${connection.id}': ${error}`)
          }
        }
      } finally {
        await this.lease.release(RUNNER_LEASE, this.owner).catch(() => undefined)
      }
    }
    this.cachedStatus = undefined

    const remaining = (await this.allCompleted()).filter((connection) => {
      const bucket = this.bucketOf(connection, job)
      return 'pending' === bucket || 'retrying' === bucket
    }).length
    if (0 === remaining && 'running' === job.status) {
      await this.saveJob({ ...job, status: 'completed', completedAt: this.now().toISOString() })
    }
    return { rotated: attempted, remaining }
  }

  public async status(): Promise<RotationStatus> {
    const cached = this.cachedStatus
    if (cached && Date.now() - cached.at < STATUS_CACHE_MS) return cached.value

    const counts = emptyCounts()
    const job = await this.loadJob()
    for (const connection of await this.allCompleted()) {
      counts.total += 1
      counts[this.bucketOf(connection, job)] += 1
    }
    const value = { job, counts }
    this.cachedStatus = { at: Date.now(), value }
    return value
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.tick().catch((error) => this.logger.error(`[RotationRunner] batch failed: ${error}`))
    }, delayMs)
    this.timer.unref()
  }

  private async tick(): Promise<void> {
    if (this.ticking || this.stopped) return
    this.ticking = true
    let intervalMs = DEFAULT_INTERVAL_MS
    try {
      const job = await this.loadJob()
      intervalMs = job.intervalMs
      const { remaining } = await this.runOnce()
      if (0 < remaining && 'running' === (await this.loadJob()).status) this.schedule(intervalMs)
    } catch (error) {
      this.logger.error(`[RotationRunner] batch failed, trying again in ${intervalMs}ms: ${error}`)
      this.schedule(intervalMs)
    } finally {
      this.ticking = false
    }
  }

  // Connections that could be rotated at all: completed, with both DIDs, and not a mediator connection.
  private async allCompleted(): Promise<DidCommConnectionRecord[]> {
    const connectionService = this.agent.dependencyManager.resolve(DidCommConnectionService)
    const all: DidCommConnectionRecord[] = []
    for (let offset = 0; ; offset += PAGE_SIZE) {
      const page = await connectionService.findAllByQuery(
        this.agent.context,
        { state: DidCommDidExchangeState.Completed },
        { limit: PAGE_SIZE, offset },
      )
      all.push(...page.filter((c) => c.did && c.theirDid && !c.connectionTypes?.includes('mediator')))
      if (page.length < PAGE_SIZE) return all
    }
  }

  private isNative(connection: DidCommConnectionRecord, job: RotationJob): boolean {
    return undefined !== job.cutoff && connection.createdAt.getTime() > new Date(job.cutoff).getTime()
  }

  // A connection made on this agent after the job began needs no rotation, so it counts as updated.
  private bucketOf(connection: DidCommConnectionRecord, job: RotationJob): RotationBucket {
    return this.isNative(connection, job) ? 'updated' : bucketFor(connection, this.now())
  }

  private validPositive(value: number | undefined, fallback: number): number {
    return Number.isInteger(value) && (value as number) > 0 ? (value as number) : fallback
  }

  private async loadJob(): Promise<RotationJob> {
    const record = await this.agent.genericRecords.findById(JOB_RECORD_ID)
    return (
      (record?.content as unknown as RotationJob | undefined) ?? {
        status: 'idle',
        batchSize: DEFAULT_BATCH_SIZE,
        intervalMs: DEFAULT_INTERVAL_MS,
      }
    )
  }

  private async saveJob(job: RotationJob): Promise<void> {
    const existing = await this.agent.genericRecords.findById(JOB_RECORD_ID)
    if (existing) {
      existing.content = { ...job }
      await this.agent.genericRecords.update(existing)
      this.cachedStatus = undefined
      return
    }
    await this.agent.genericRecords.save({ id: JOB_RECORD_ID, content: { ...job } })
    this.cachedStatus = undefined
  }
}
