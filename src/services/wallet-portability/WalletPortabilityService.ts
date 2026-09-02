import type { ExportWalletResult, ImportWalletResult, WalletPortabilityJobRecord } from './WalletPortabilityTypes'
import type { RestMultiTenantAgentModules } from '../../cliAgent'
import type { TsLogger } from '../../utils/logger'
import type { Agent } from '@credo-ts/core'
import type { Readable } from 'stream'

import { AskarStoreManager } from '@credo-ts/askar'
import { KdfMethod, Store, StoreKeyMethod } from '@openwallet-foundation/askar-shared'
import * as AWS from 'aws-sdk'
import { createHash } from 'crypto'
import { createReadStream, createWriteStream, promises as fs } from 'fs'
import fetch from 'node-fetch'
import * as os from 'os'
import * as path from 'path'
import { pipeline } from 'stream/promises'
import { v4 as uuid } from 'uuid'
import { createGunzip, createGzip } from 'zlib'

import { HEARTBEAT_INTERVAL_MS, WalletPortabilityJobStore } from './WalletPortabilityJobStore'
import {
  WalletPortabilityJobConflictError,
  WalletPortabilityJobStatus,
  WalletPortabilityJobType,
} from './WalletPortabilityTypes'

// Short-lived per the plan's requirement — an exported wallet is sensitive, the URL should not
// stay valid longer than a normal download takes.
const PRE_SIGNED_URL_EXPIRY_SECONDS = 15 * 60

// Sanitized codes returned to callers on a Failed job — the real error (which may carry paths,
// bucket names, or stack traces) is logged server-side with the job id instead.
const EXPORT_FAILED_ERROR_CODE = 'EXPORT_FAILED'
const IMPORT_FAILED_ERROR_CODE = 'IMPORT_FAILED'

// Ceiling for a real wallet export, enforced against actual bytes read rather than a trusted
// Content-Length header.
const MAX_DOWNLOAD_BYTES = 2 * 1024 * 1024 * 1024 // 2 GiB
// Same ceiling applied independently to gunzip's decompressed output — capping only the
// compressed size doesn't stop a decompression-bomb artifact from filling disk once expanded.
const MAX_DECOMPRESSED_BYTES = MAX_DOWNLOAD_BYTES

// node-fetch@2 has no default timeout, and this `timeout` option only covers time-to-first-byte
// (cleared once headers arrive) — a stalled body isn't caught by this alone; see
// downloadAndChecksum's inactivity timer for that case.
const DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000

// Deliberately not typed as the real AWS.S3 class — its full type declarations OOM ts-jest's
// type-aware transform when type-checking this file. See WalletPortabilityService.spec.ts.
interface S3Client {
  // upload(), not putObject() — see uploadToS3 for why; no ContentLength needed, the multipart
  // uploader doesn't require it upfront.
  upload(params: { Bucket: string; Key: string; Body: Readable; ServerSideEncryption: string }): {
    promise(): Promise<unknown>
  }
  getSignedUrl(operation: 'getObject', params: { Bucket: string; Key: string; Expires: number }): string
}

/**
 * Native export/import for tenant (cloud) wallets, replacing the legacy per-request raw-NATS
 * call to the separate Python `askar-wallet-tools` service. See project_phase_c_cloud_wallet
 * memory for the full design rationale.
 *
 * Export/import are async jobs: the HTTP endpoint returns a job id immediately and the actual
 * Askar work + S3 upload happens in the background — callers poll getJobStatus(jobId).
 */
export class WalletPortabilityService {
  private readonly logger: TsLogger
  private readonly jobStore: WalletPortabilityJobStore
  private readonly s3: S3Client

  public constructor(logger: TsLogger) {
    this.logger = logger
    this.jobStore = new WalletPortabilityJobStore(logger, process.env.REDIS_URL)
    this.s3 = new AWS.S3({
      accessKeyId: process.env.AWS_ACCESS_KEY,
      secretAccessKey: process.env.AWS_SECRET_KEY,
      region: process.env.AWS_REGION,
    }) as unknown as S3Client
  }

  public async getJobStatus(jobId: string): Promise<WalletPortabilityJobRecord | undefined> {
    const job = await this.jobStore.get(jobId)
    if (!job) return undefined

    // Mint the pre-signed URL fresh on every read rather than freezing it at completion —
    // PRE_SIGNED_URL_EXPIRY_SECONDS (15m) is far shorter than the job's 24h TTL, so a URL minted
    // at completion would already be dead for a slow-polling client. downloadUrl is never
    // persisted; only s3Key is.
    if (job.status === WalletPortabilityJobStatus.Completed && job.s3Key) {
      return { ...job, downloadUrl: this.getPresignedUrl(job.s3Key) }
    }
    return job
  }

  /**
   * @param passKey Caller-supplied passphrase for the exported artifact — matches the legacy
   *   `POST /export/:tenantId { passKey, walletID }` contract. The controller enforces a minimum
   *   length (MIN_PASSKEY_LENGTH in MultiTenancyController) before this is ever reached; below
   *   that, it is run through Argon2i key derivation (KdfMethod.Argon2IMod) rather than passed to
   *   Askar's raw KDF, which only accepts a base58-encoded 32-byte key and would reject a normal
   *   passphrase outright (see runExport below). The caller must retain this to import the
   *   artifact later; it is never generated or persisted server-side, and never logged.
   */
  public async exportWallet(
    agent: Agent<RestMultiTenantAgentModules>,
    tenantId: string,
    passKey: string,
  ): Promise<ExportWalletResult> {
    const jobId = uuid()

    // Export and import both rename the tenant's Askar profile for their copy — two concurrent
    // jobs on the same tenant can wedge it with no working profile, or drop a result. Reserve the
    // slot first so a conflicting caller gets a clean 409 instead of a job doomed to race.
    const conflictingJobId = await this.jobStore.tryReserveActiveJob(tenantId, jobId)
    if (conflictingJobId) {
      throw new WalletPortabilityJobConflictError(tenantId, conflictingJobId)
    }

    // Started before the Pending save below, not after InProgress — Pending relies on the same
    // refreshed lease InProgress does, so heartbeating must begin before a Pending record even
    // exists. Passed into runExport rather than started there, since its own try block runs after
    // this window has already passed.
    const heartbeat = this.startHeartbeat(jobId, tenantId)

    const now = new Date().toISOString()
    await this.jobStore.save({
      jobId,
      tenantId,
      type: WalletPortabilityJobType.Export,
      status: WalletPortabilityJobStatus.Pending,
      createdAt: now,
      updatedAt: now,
    })

    // Fire-and-forget async job. Best-effort mark Failed here too, in case setJobStatus(InProgress)
    // itself throws before runExport's own try can catch it — otherwise the job is stranded at
    // Pending forever.
    this.runExport(agent, tenantId, jobId, passKey, heartbeat).catch((error) => {
      this.logger.error(`[WalletPortabilityService] export job ${jobId} failed to start: ${error}`)
      this.setJobStatus(
        jobId,
        tenantId,
        WalletPortabilityJobType.Export,
        WalletPortabilityJobStatus.Failed,
        EXPORT_FAILED_ERROR_CODE,
      ).catch((statusError) => {
        this.logger.error(
          `[WalletPortabilityService] export job ${jobId} also failed to record its Failed status: ${statusError}`,
        )
      })
    })

    return { jobId, status: WalletPortabilityJobStatus.Pending }
  }

  // Export never touches the tenant's live profile — copyProfile only reads from it into a temp
  // store, so the tenant stays available for ordinary traffic throughout. Contrast runImport,
  // which does rename the live profile away for the copy's duration.
  private async runExport(
    agent: Agent<RestMultiTenantAgentModules>,
    tenantId: string,
    jobId: string,
    passKey: string,
    heartbeat: NodeJS.Timeout,
  ): Promise<void> {
    let tempStore: Store | undefined
    let tempDbPath: string | undefined
    let gzipPath: string | undefined
    // Hoisted so cleanup can remove the whole temp directory — Askar's sqlite backend leaves
    // -shm/-wal sidecars next to the .db file, which removing only the explicit .db/.db.gz paths
    // would leave behind.
    let workDir: string | undefined

    try {
      // If this throws (e.g. Redis flapping), the job must land in the catch below and mark
      // Failed, not stay stuck at Pending forever.
      await this.setJobStatus(jobId, tenantId, WalletPortabilityJobType.Export, WalletPortabilityJobStatus.InProgress)

      workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wallet-export-'))
      tempDbPath = path.join(workDir, `${jobId}.db`)

      // Do the copy fully inside withTenantAgent so the tenant session releases on exit — never
      // hold a tenant-scoped handle outside the callback.
      await agent.modules.tenants.withTenantAgent({ tenantId }, async (tenantAgent) => {
        const { store: baseStore, profile } = await tenantAgent.context.dependencyManager
          .resolve(AskarStoreManager)
          .getInitializedStoreWithProfile(tenantAgent.context)

        if (!profile) {
          throw new Error(`No Askar profile resolved for tenant '${tenantId}'`)
        }

        tempStore = await Store.provision({
          uri: `sqlite://${tempDbPath}`,
          // Argon2IMod, not Raw: Askar's raw KDF only accepts a base58-encoded 32-byte key and
          // would reject a normal passphrase outright; Argon2i derives a real key from the
          // caller's passKey.
          keyMethod: new StoreKeyMethod(KdfMethod.Argon2IMod),
          passKey,
          recreate: true,
          profile,
        })

        await baseStore.copyProfile({ toStore: tempStore, fromProfile: profile, toProfile: profile })
      })

      await tempStore?.close()
      tempStore = undefined

      gzipPath = `${tempDbPath}.gz`
      const checksum = await this.gzipAndChecksum(tempDbPath, gzipPath)

      const s3Key = `wallet-exports/${tenantId}/${jobId}.db.gz`
      await this.uploadToS3(gzipPath, s3Key)

      // s3Key is persisted, not a downloadUrl — getJobStatus mints a fresh short-lived URL on
      // every read so a job read long after completion still returns a live link.
      const existing = await this.jobStore.get(jobId)
      await this.jobStore.save({
        jobId,
        tenantId,
        type: WalletPortabilityJobType.Export,
        status: WalletPortabilityJobStatus.Completed,
        createdAt: existing?.createdAt ?? new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        s3Key,
        checksum,
      })
    } catch (error) {
      this.logger.error(`[WalletPortabilityService] export job ${jobId} failed: ${error}`)
      await this.setJobStatus(
        jobId,
        tenantId,
        WalletPortabilityJobType.Export,
        WalletPortabilityJobStatus.Failed,
        EXPORT_FAILED_ERROR_CODE,
      )
    } finally {
      // Stop the heartbeat first — no point touching updatedAt once cleanup has started.
      clearInterval(heartbeat)
      // Remove the whole workDir (not just the individual paths) so plaintext wallet data and
      // Askar's -shm/-wal sidecars never linger on disk.
      if (tempStore) {
        await tempStore.close().catch(() => undefined)
      }
      if (workDir) {
        await fs.rm(workDir, { recursive: true, force: true }).catch(() => undefined)
      }
      // Release the tenant's active-job slot regardless of outcome, exactly once per job.
      await this.jobStore.releaseActiveJob(tenantId, jobId).catch(() => undefined)
    }
  }

  // Hashes the uploaded gzip artifact, not the plaintext source — the checksum returned to
  // callers must match what they'll actually download and verify.
  private async gzipAndChecksum(sourcePath: string, destPath: string): Promise<string> {
    const hash = createHash('sha256')
    const source = createReadStream(sourcePath)
    const gzip = createGzip()
    const dest = createWriteStream(destPath)
    gzip.on('data', (chunk) => hash.update(chunk))
    await pipeline(source, gzip, dest)
    return hash.digest('hex')
  }

  private getExportBucket(): string {
    const bucket = process.env.AWS_WALLET_EXPORT_BUCKET
    if (!bucket) {
      throw new Error('AWS_WALLET_EXPORT_BUCKET is not configured')
    }
    return bucket
  }

  // Streams the artifact rather than buffering it fully in memory — this process also serves
  // other tenants' traffic and nothing caps concurrent exports, so buffering is a real OOM risk.
  private async uploadToS3(filePath: string, key: string): Promise<void> {
    // s3.upload(), not putObject(): aws-sdk v2's putObject retries transient failures by
    // re-sending the body, but a ReadStream is one-shot and already (partially) consumed — the
    // retry sends a short body while ContentLength still claims the full size, so S3 rejects with
    // IncompleteBody instead of recovering. upload()'s managed multipart uploader re-reads only
    // the failed part from its own buffered chunks, and removes the 5GB single-PUT ceiling too.
    await this.s3
      .upload({
        Bucket: this.getExportBucket(),
        Key: key,
        Body: createReadStream(filePath),
        ServerSideEncryption: 'AES256',
      })
      .promise()
  }

  private getPresignedUrl(key: string): string {
    return this.s3.getSignedUrl('getObject', {
      Bucket: this.getExportBucket(),
      Key: key,
      Expires: PRE_SIGNED_URL_EXPIRY_SECONDS,
    })
  }

  private async setJobStatus(
    jobId: string,
    tenantId: string,
    type: WalletPortabilityJobType,
    status: WalletPortabilityJobStatus,
    error?: string,
    backupProfile?: string,
  ): Promise<void> {
    const existing = await this.jobStore.get(jobId)
    await this.jobStore.save({
      jobId,
      tenantId,
      type,
      status,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      error,
      // Carried forward, not dropped — this rebuilds the whole record; a future caller marking an
      // already-completed job Failed/InProgress without this would silently erase the download
      // pointer, orphaning the artifact in the bucket.
      s3Key: existing?.s3Key,
      checksum: existing?.checksum,
      // Preserves a backupProfile written on an earlier InProgress/Completed save for this job if
      // this particular call doesn't pass one explicitly (export callers never do).
      backupProfile: backupProfile ?? existing?.backupProfile,
    })
  }

  // Touches the job record's updatedAt on HEARTBEAT_INTERVAL_MS so MAX_IN_PROGRESS_DURATION_MS
  // reclaim means "this process stopped heartbeating", not "started more than N ago" — a
  // long-running transfer must not be falsely reclaimed mid-run.
  //
  // Delegates to jobStore.touchIfActive (an atomic check-and-write) rather than a separate
  // get()+setJobStatus(), which left a window where an in-flight tick could clobber a terminal
  // write back to non-terminal.
  //
  // Also refreshes the tenant's active-job reservation, not just the job record — the
  // reservation's own TTL is set once at reserve time and was never otherwise refreshed, so a
  // still-alive transfer could have its reservation silently expire while the job record stays
  // alive, letting a second caller's reservation succeed against a job that never actually died.
  private startHeartbeat(jobId: string, tenantId: string): NodeJS.Timeout {
    return setInterval(() => {
      Promise.all([this.jobStore.touchIfActive(jobId), this.jobStore.touchActiveJobReservation(tenantId, jobId)]).catch(
        (error) => {
          this.logger.error(`[WalletPortabilityService] heartbeat failed for job ${jobId}: ${error}`)
        },
      )
    }, HEARTBEAT_INTERVAL_MS)
  }

  // ---------------------------------------------------------------------------
  // Import
  // ---------------------------------------------------------------------------

  /**
   * @param exportUrl The pre-signed S3 URL returned by a prior exportWallet() job.
   * @param passKey The same passKey the artifact was exported with.
   * @param checksum The SHA-256 checksum returned alongside exportUrl — verified before anything
   *   live is touched.
   *
   * Import never deletes the tenant's current wallet data outright: their existing profile is
   * renamed aside (not removed) before the imported profile takes its place, so a bad import
   * always leaves a recovery path. See project_phase_c_cloud_wallet memory for the rationale.
   */
  public async importWallet(
    agent: Agent<RestMultiTenantAgentModules>,
    tenantId: string,
    exportUrl: string,
    passKey: string,
    checksum: string,
  ): Promise<ImportWalletResult> {
    const jobId = uuid()

    // Same reservation as exportWallet — export and import share the tenant's profile namespace,
    // so this guards against a concurrent job of either kind.
    const conflictingJobId = await this.jobStore.tryReserveActiveJob(tenantId, jobId)
    if (conflictingJobId) {
      throw new WalletPortabilityJobConflictError(tenantId, conflictingJobId)
    }

    // Same reasoning as exportWallet — started before the Pending save so Pending gets the same
    // refreshed lease InProgress relies on.
    const heartbeat = this.startHeartbeat(jobId, tenantId)

    const now = new Date().toISOString()
    await this.jobStore.save({
      jobId,
      tenantId,
      type: WalletPortabilityJobType.Import,
      status: WalletPortabilityJobStatus.Pending,
      createdAt: now,
      updatedAt: now,
    })

    // Fire-and-forget async job — same reasoning as exportWallet's identical handler above. Best-
    // effort mark Failed and release the reservation here too, in case setJobStatus(InProgress)
    // itself throws — otherwise the job stays Pending and the tenant's slot never releases,
    // wedging every future export/import until the 24h TTL clears.
    this.runImport(agent, tenantId, jobId, exportUrl, passKey, checksum, heartbeat).catch((error) => {
      this.logger.error(`[WalletPortabilityService] import job ${jobId} failed to start: ${error}`)
      this.setJobStatus(
        jobId,
        tenantId,
        WalletPortabilityJobType.Import,
        WalletPortabilityJobStatus.Failed,
        IMPORT_FAILED_ERROR_CODE,
      ).catch((statusError) => {
        this.logger.error(
          `[WalletPortabilityService] import job ${jobId} also failed to record its Failed status: ${statusError}`,
        )
      })
      this.jobStore.releaseActiveJob(tenantId, jobId).catch(() => undefined)
    })

    return { jobId, status: WalletPortabilityJobStatus.Pending }
  }

  /**
   * KNOWN GAP, not yet closed by `WalletPortabilityJobConflictError` below: between
   * `renameProfile` and `copyProfile` completing (seconds to minutes for a real wallet), the
   * tenant's `tenant-<id>` profile does not exist in the base store at all. The agent is still
   * live and multi-tenant for the whole window, so:
   *
   *   - Any concurrent REST call or inbound DIDComm message for this tenant goes through
   *     `withTenantAgent` on a profile that isn't there, and fails with a raw Askar error — the
   *     tenant is effectively down for the duration, with no 503/"import in progress" signal.
   *   - A write whose session opened just before the rename but commits just after can land in
   *     the renamed-aside backup profile and be silently lost once the imported profile takes
   *     the live name.
   *
   * `tryReserveActiveJob`/`WalletPortabilityJobConflictError` (see importWallet above) only
   * serialise portability jobs against *each other* — they say nothing about ordinary tenant
   * traffic landing in this same window. Closing that for real (e.g. gating tenant traffic behind
   * a 503/maintenance flag for the duration of the copy) is follow-up work, not done in this pass.
   */
  private async runImport(
    agent: Agent<RestMultiTenantAgentModules>,
    tenantId: string,
    jobId: string,
    exportUrl: string,
    passKey: string,
    checksum: string,
    heartbeat: NodeJS.Timeout,
  ): Promise<void> {
    let importedStore: Store | undefined
    let gzipPath: string | undefined
    let importedDbPath: string | undefined
    let backupProfile: string | undefined
    let renamedAway = false
    // Tracks whether a profile currently exists at backupProfile's name — not reusable from
    // renamedAway, which the success path clears once copyProfile completes. True from the
    // instant renameProfile lands until rollback restores it or it's cleared on success; read by
    // the Failed-record report so a genuine backup is distinguished from one that never existed.
    let backupExists = false
    // Hoisted so cleanup can remove the whole temp directory — same reasoning as runExport's
    // identical field.
    let workDir: string | undefined

    try {
      // Same reasoning as runExport's identical line: if this throws, the job must land in the
      // catch below and mark Failed, not stay stuck at Pending forever.
      await this.setJobStatus(jobId, tenantId, WalletPortabilityJobType.Import, WalletPortabilityJobStatus.InProgress)

      workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wallet-import-'))
      gzipPath = path.join(workDir, `${jobId}.db.gz`)
      importedDbPath = path.join(workDir, `${jobId}.db`)

      // Verify the checksum BEFORE touching anything live — a corrupt/tampered artifact must
      // never reach the point of renaming the tenant's real profile aside.
      const actualChecksum = await this.downloadAndChecksum(exportUrl, gzipPath)
      if (actualChecksum !== checksum) {
        throw new Error(`Checksum mismatch: expected ${checksum}, got ${actualChecksum}`)
      }

      await this.gunzip(gzipPath, importedDbPath)

      importedStore = await Store.open({
        uri: `sqlite://${importedDbPath}`,
        // Must match the KdfMethod the artifact was provisioned with (Argon2IMod, see runExport)
        // — Store.open rejects a mismatch outright ("Store key method mismatch", verified against
        // the real binding), before ever reaching a wrong-passphrase error.
        keyMethod: new StoreKeyMethod(KdfMethod.Argon2IMod),
        passKey,
      })

      await agent.modules.tenants.withTenantAgent({ tenantId }, async (tenantAgent) => {
        const { store: baseStore, profile } = await tenantAgent.context.dependencyManager
          .resolve(AskarStoreManager)
          .getInitializedStoreWithProfile(tenantAgent.context)

        if (!profile) {
          throw new Error(`No Askar profile resolved for tenant '${tenantId}'`)
        }

        // Take the source profile from the artifact rather than requiring it match the target
        // tenant's id — this supports importing onto a rebuilt agent or a freshly created tenant.
        // Verified only for artifacts this service's own export produces (always exactly one
        // profile); NOT verified for a legacy askar-wallet-tools artifact — Store.open above
        // hardcodes Argon2IMod and would reject one provisioned with a different KDF, and nothing
        // here establishes that askar-wallet-tools' own export always yields exactly one profile.
        //
        // importedStore is always assigned before this callback runs, so this guard isn't
        // reachable today — but it replaces a `?.` that would have silently skipped the
        // destructive copyProfile step while renamedAway/backupExists still claimed success.
        if (!importedStore) {
          throw new Error('Imported store was not opened before the destructive copy step')
        }
        const profilesInArtifact = await importedStore.listProfiles()
        if (profilesInArtifact.length !== 1) {
          throw new Error(
            `Imported artifact must contain exactly one profile (found: ${profilesInArtifact.join(', ')})`,
          )
        }
        const sourceProfile = profilesInArtifact[0]

        backupProfile = `${profile}-pre-import-${jobId}`
        await baseStore.renameProfile({ fromProfile: profile, toProfile: backupProfile })
        renamedAway = true
        // Set the instant the rename lands, independent of renamedAway — tracks whether a backup
        // profile currently exists, not whether rollback would be attempted.
        backupExists = true

        await importedStore.copyProfile({ toStore: baseStore, fromProfile: sourceProfile, toProfile: profile })

        // Past this point the imported profile is live under the tenant's real name — a later
        // failure must not trigger rollback, which would try to rename the backup on top of it
        // and fail with a false "manual intervention required" alert for an import that had, in
        // fact, already succeeded (verified against the real binding: that rename fails outright
        // with a UNIQUE constraint).
        renamedAway = false
        // Cleared here too: from this instant, whatever sits at backupProfile is a stale
        // pre-import copy, not current data — a later throw in this same try must not report
        // backupExists true, or a recovery attempt would overwrite the successfully-imported
        // profile with the stale backup. The -pre-import-<jobId> profile itself is still left in
        // the store; this only stops it being misreported as the recovery path.
        backupExists = false
      })

      const existing = await this.jobStore.get(jobId)
      await this.jobStore.save({
        jobId,
        tenantId,
        type: WalletPortabilityJobType.Import,
        status: WalletPortabilityJobStatus.Completed,
        createdAt: existing?.createdAt ?? new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        backupProfile,
      })
      // Pre-import profile is intentionally never auto-deleted (see docblock above); logged here
      // since the job record itself TTLs out after 24h. No cleanup endpoint yet — known follow-up.
      this.logger.info(
        `[WalletPortabilityService] import job ${jobId} completed for tenant '${tenantId}' — pre-import backup left at profile '${backupProfile}' (not auto-deleted)`,
      )
    } catch (error) {
      this.logger.error(`[WalletPortabilityService] import job ${jobId} failed: ${error}`)

      // Best-effort rollback: if we got as far as renaming the tenant's real profile aside but
      // never completed, put it back rather than leaving the tenant with no working wallet.
      if (renamedAway && backupProfile) {
        try {
          await agent.modules.tenants.withTenantAgent({ tenantId }, async (tenantAgent) => {
            const { store: baseStore, profile } = await tenantAgent.context.dependencyManager
              .resolve(AskarStoreManager)
              .getInitializedStoreWithProfile(tenantAgent.context)
            if (profile) {
              // copyProfile creates the target before copying entries, so a partial failure can
              // leave `profile` present-but-partial — clear it first or the rename-back below
              // hits a UNIQUE error and rollback fails needlessly.
              const currentProfiles = await baseStore.listProfiles()
              if (currentProfiles.includes(profile)) {
                await baseStore.removeProfile(profile)
              }
              await baseStore.renameProfile({ fromProfile: backupProfile as string, toProfile: profile })
              backupExists = false
            } else {
              // Same "manual intervention required" outcome as the catch block below, just
              // reached without renameProfile throwing — must log here too or there's no trail
              // pointing at backupProfile at all.
              this.logger.error(
                `[WalletPortabilityService] import job ${jobId} rollback skipped — tenant '${tenantId}' has no active profile to roll back into, manual intervention required. Tenant's real data may still be at profile '${backupProfile}'.`,
              )
            }
          })
        } catch (rollbackError) {
          // backupProfile is included so an operator doesn't have to reverse-engineer the naming
          // convention to find the tenant's stranded data.
          this.logger.error(
            `[WalletPortabilityService] import job ${jobId} rollback FAILED — tenant '${tenantId}' may be left without a working profile, manual intervention required. Tenant's real data may still be at profile '${backupProfile}': ${rollbackError}`,
          )
        }
      }

      await this.setJobStatus(
        jobId,
        tenantId,
        WalletPortabilityJobType.Import,
        WalletPortabilityJobStatus.Failed,
        IMPORT_FAILED_ERROR_CODE,
        // backupExists, not "!rollbackSucceeded" — when renameProfile itself throws, backupExists
        // never becomes true (no profile was ever created), so reporting backupProfile then would
        // point at a profile that doesn't exist.
        backupExists ? backupProfile : undefined,
      )
    } finally {
      // Stop the heartbeat first, same reasoning as runExport's identical finally.
      clearInterval(heartbeat)
      if (importedStore) {
        await importedStore.close().catch(() => undefined)
      }
      // Remove the whole workDir (not just the individual paths) — see runExport's identical
      // finally.
      if (workDir) {
        await fs.rm(workDir, { recursive: true, force: true }).catch(() => undefined)
      }
      // Release the tenant's active-job slot regardless of outcome.
      await this.jobStore.releaseActiveJob(tenantId, jobId).catch(() => undefined)
    }
  }

  // exportUrl is caller-supplied and goes straight into a server-side fetch — without these
  // checks this is an SSRF primitive (e.g. reaching the cloud metadata endpoint) and a
  // content-confirmation oracle (checksum-mismatch echoes sha256(body) back). Only a pre-signed
  // URL for this deployment's own export bucket is legitimate.
  //
  // Both URL shapes aws-sdk v2 can emit are accepted: virtual-hosted-style, and path-style (used
  // whenever the bucket name isn't DNS-compatible over TLS, e.g. contains a dot). The endpoint
  // suffix stays permissive across standard/dualstack/FIPS/China-partition forms so a
  // legitimately configured deployment isn't rejected — only the bucket name itself is fixed.
  private isTrustedExportHost(hostname: string, pathname: string): boolean {
    const bucket = this.getExportBucket()
    const escapedBucket = bucket.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const endpointSuffix = `s3(-fips)?(\\.dualstack)?([.-][a-z0-9-]+)?\\.amazonaws\\.com(\\.cn)?`
    // Virtual-hosted style: <bucket>.s3.<region>.amazonaws.com
    if (new RegExp(`^${escapedBucket}\\.${endpointSuffix}$`, 'i').test(hostname)) {
      return true
    }
    // Path style: s3.<region>.amazonaws.com/<bucket>/... — a legitimate shape for a URL this
    // service minted itself, not an SSRF attempt.
    if (new RegExp(`^${endpointSuffix}$`, 'i').test(hostname)) {
      return pathname.startsWith(`/${bucket}/`)
    }
    return false
  }

  private async downloadAndChecksum(url: string, destPath: string): Promise<string> {
    // https-only, no redirects followed, and a hard byte cap below so a large/endless response
    // can't fill the host's disk. Host (+ path, for the path-style form) is restricted to this
    // deployment's own export bucket — see isTrustedExportHost.
    const parsedUrl = new URL(url)
    if (parsedUrl.protocol !== 'https:' || !this.isTrustedExportHost(parsedUrl.hostname, parsedUrl.pathname)) {
      throw new Error(`Refusing to download export artifact from untrusted host '${parsedUrl.hostname}'`)
    }

    const response = await fetch(url, { redirect: 'error', timeout: DOWNLOAD_TIMEOUT_MS })
    if (!response.ok || !response.body) {
      // An HTTP-error response still has a body to consume — leaving it undrained can strand its
      // keep-alive socket, since node-fetch's pool only frees a socket once the body is consumed
      // or destroyed. destroy() covers a stream that emits nothing further; resume() drains one
      // still flowing.
      if (response.body) {
        const errorBody = response.body as unknown as Readable
        errorBody.destroy()
        errorBody.resume()
      }
      throw new Error(`Failed to download export artifact: HTTP ${response.status}`)
    }
    // node-fetch v2's Response.body is a real Node Readable at runtime (hence `.on('data', ...)`
    // below) — @types/node-fetch just types it as the DOM ReadableStream interface, which doesn't
    // declare `.destroy()`. Cast to the real runtime type.
    const body = response.body as unknown as Readable
    const hash = createHash('sha256')
    const dest = createWriteStream(destPath)
    let bytesRead = 0

    // node-fetch@2's own `timeout` option only covers time-to-first-byte, cleared once headers
    // arrive — without an inactivity timer here, a stalled body would hang pipeline() forever and
    // leak the job/workDir indefinitely. Reset on every 'data' event so this bounds inactivity,
    // not total transfer time.
    let inactivityTimer: NodeJS.Timeout | undefined
    const resetInactivityTimer = (): void => {
      if (inactivityTimer) clearTimeout(inactivityTimer)
      inactivityTimer = setTimeout(() => {
        body.destroy(new Error(`Export artifact download stalled: no data received for ${DOWNLOAD_TIMEOUT_MS}ms`))
      }, DOWNLOAD_TIMEOUT_MS)
    }
    resetInactivityTimer()

    body.on('data', (chunk: Buffer) => {
      resetInactivityTimer()
      bytesRead += chunk.length
      if (bytesRead > MAX_DOWNLOAD_BYTES) {
        // Aborts the stream; pipeline() below rejects with this same error, which propagates up
        // to runImport's catch — no partial artifact is treated as valid.
        body.destroy(new Error(`Export artifact exceeds the ${MAX_DOWNLOAD_BYTES}-byte download cap`))
        return
      }
      hash.update(chunk)
    })
    try {
      await pipeline(body, dest)
    } finally {
      if (inactivityTimer) clearTimeout(inactivityTimer)
    }
    return hash.digest('hex')
  }

  // maxBytes defaults to the real cap; runImport never overrides it — the parameter exists so
  // this specific boundary check is unit-testable without allocating a multi-gigabyte fixture.
  private async gunzip(sourcePath: string, destPath: string, maxBytes: number = MAX_DECOMPRESSED_BYTES): Promise<void> {
    const source = createReadStream(sourcePath)
    const gunzip = createGunzip()
    const dest = createWriteStream(destPath)
    // Cap the decompressed output independently of the already-capped compressed input — a small,
    // adversarially crafted gzip artifact can still expand to fill the host's disk once unzipped.
    let bytesDecompressed = 0
    gunzip.on('data', (chunk: Buffer) => {
      bytesDecompressed += chunk.length
      if (bytesDecompressed > maxBytes) {
        // Aborts the stream; pipeline() below rejects with this same error, which propagates up
        // to runImport's catch — no partial artifact is treated as valid.
        gunzip.destroy(new Error(`Decompressed export artifact exceeds the ${maxBytes}-byte cap`))
      }
    })
    await pipeline(source, gunzip, dest)
  }

  /** Graceful shutdown — closes the job store's Redis connection, if any. See shutdownWalletPortabilityService. */
  public async disconnect(): Promise<void> {
    await this.jobStore.disconnect()
  }
}

// ---------------------------------------------------------------------------
// Lazy process-wide singleton
// ---------------------------------------------------------------------------
//
// Previously constructed eagerly at module scope, meaning every process opened a Redis connection
// at import time — including dedicated (non-tenant) agents where /multi-tenancy/* is rejected
// outright — and it was never closed on shutdown. Constructing lazily on first use fixes both;
// wiring shutdownWalletPortabilityService() into cliAgent.ts's shutdown() closes it. A
// module-level function (not tsyringe — no existing precedent here for a plain service) is still
// substitutable via jest.mock() the way an eagerly-created const would not be.
let singleton: WalletPortabilityService | undefined

/** logger is only used to construct the singleton on first call; ignored on subsequent calls. */
export function getWalletPortabilityService(logger: TsLogger): WalletPortabilityService {
  if (!singleton) {
    singleton = new WalletPortabilityService(logger)
  }
  return singleton
}

/** No-ops if the singleton was never constructed (e.g. multi-tenancy/export was never called). */
export async function shutdownWalletPortabilityService(): Promise<void> {
  if (singleton) {
    await singleton.disconnect()
    singleton = undefined
  }
}
