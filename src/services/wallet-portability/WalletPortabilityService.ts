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

// Sanitized codes stored on a Failed job record and returned to callers — the real error (Askar,
// filesystem, or AWS SDK internals) can carry operational details a caller has no business seeing
// (paths, bucket names, stack traces). The full error is still logged server-side with the job id
// at every call site below; these are the only values getJobStatus ever hands back. See the #72
// review.
const EXPORT_FAILED_ERROR_CODE = 'EXPORT_FAILED'
const IMPORT_FAILED_ERROR_CODE = 'IMPORT_FAILED'

// Generous ceiling for a real wallet export. Enforced against actual bytes read, not a trusted
// Content-Length header, so a response that lies about its size still gets capped.
const MAX_DOWNLOAD_BYTES = 2 * 1024 * 1024 * 1024 // 2 GiB
// Same ceiling, applied independently to the *decompressed* output of gunzip. Capping only the
// compressed download above doesn't stop a "decompression bomb" — a small, adversarially crafted
// gzip artifact with an enormous compression ratio can still expand to fill the host's disk once
// gunzipped, and this process also serves DIDComm/every other tenant's traffic.
const MAX_DECOMPRESSED_BYTES = MAX_DOWNLOAD_BYTES

// node-fetch@2 applies no timeout by default -- a stalled response (S3/network blackhole, a
// half-open socket after a NAT/LB idle timeout) leaves this await pending forever. That wedges the
// whole tenant, not just this job: runImport/runExport's finally never runs, releaseActiveJob is
// never called, and the job record stays Pending/InProgress, which is exactly the state
// isReservationStillActive treats as "still running" -- every subsequent export AND import for the
// tenant 409s until the process restarts (activeJobMemoryStore has no TTL) or, at best, the 24h
// Redis TTL expires. `timeout` covers the whole request/response cycle, not just connect, so a
// stalled body (not just a refused connection) still rejects this fetch and reaches runImport's
// catch -> Failed -> finally -> reservation released.
const DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000

// Deliberately NOT typed as the real `AWS.S3` class (only the 2 methods actually used here) —
// referencing that type pulls the entirety of aws-sdk's (famously enormous) type declarations
// into the type-checker's program, which is fine for `tsc` but reliably OOMs ts-jest's type-aware
// transform (isolatedModules: false) when it type-checks this file. See WalletPortabilityService.spec.ts.
interface S3Client {
  // upload(), not putObject() — see uploadToS3's own comment for why a raw ReadStream body isn't
  // retry-safe with putObject in aws-sdk v2. No ContentLength: the managed multipart uploader
  // doesn't need it upfront the way putObject does.
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

    // Mint the pre-signed URL fresh on every read instead of returning one frozen at completion
    // time: PRE_SIGNED_URL_EXPIRY_SECONDS (15m) is far shorter than the job's own TTL (24h), so a
    // URL generated once at completion would already be dead for any client that polls slowly or
    // returns later. downloadUrl is never persisted (see WalletPortabilityJobRecord) — only
    // s3Key is.
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

    // Export and import both rename the tenant's Askar profile away for the duration of their
    // copy — two portability jobs racing on the same tenant (either kind) can wedge it with no
    // working profile, or silently drop one job's result. Reserve the slot before anything else
    // is written, so a conflicting caller gets a clean 409 rather than a job id that's doomed to
    // race. See project_phase_c_cloud_wallet memory / the #73 review for the concurrency finding.
    const conflictingJobId = await this.jobStore.tryReserveActiveJob(tenantId, jobId)
    if (conflictingJobId) {
      throw new WalletPortabilityJobConflictError(tenantId, conflictingJobId)
    }

    // Started before the Pending save lands below, not after InProgress is reached — see
    // WalletPortabilityJobStore's touchIfActive/isReservationStillActive for why: Pending now
    // relies on the exact same refreshed lease InProgress already did, so it has to start ticking
    // before there's even a Pending record to refresh. Passed into runExport rather than started
    // there, since by the time runExport's own try block runs, this Pending window has already
    // passed. See the #73 review.
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

    // Fire-and-forget: matches the plan's "async job with status, not a blocking call" requirement.
    // Best-effort mark the job Failed here too — runExport already marks Failed on any error
    // inside its own try, but if setJobStatus(InProgress) itself is what threw (e.g. Redis was
    // mid-outage), that rejection propagates out to this .catch() instead, and without this the
    // job would otherwise be stranded at Pending forever (the original bug: this handler only
    // logged, never recorded a terminal status).
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

  // Export never touches the tenant's live profile itself — copyProfile below only reads from it
  // into a separate temp store, so the tenant's own profile stays present and available for
  // ordinary REST/DIDComm traffic the whole time. See runImport's docblock for the corresponding
  // known gap on the import side, which does rename the live profile away for the copy's duration.
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
    // Hoisted out of the try/finally split so cleanup can remove the *whole* temp directory —
    // Askar's sqlite backend leaves `-shm`/`-wal` sidecar files alongside the `.db` file while
    // it's open, and those can survive if tempStore.close() itself is what's failing (exactly
    // the case this finally block exists for). Removing only the two explicit paths this
    // service creates (`${jobId}.db`, `${jobId}.db.gz`) left those sidecars — and the mkdtemp
    // directory itself — behind indefinitely.
    let workDir: string | undefined

    try {
      // Inside the try now (was previously outside it): if this itself throws — e.g. Redis is
      // flapping — the job must land in the catch below and be marked Failed, not silently
      // stay at Pending forever.
      await this.setJobStatus(jobId, tenantId, WalletPortabilityJobType.Export, WalletPortabilityJobStatus.InProgress)

      workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wallet-export-'))
      tempDbPath = path.join(workDir, `${jobId}.db`)

      // Do the actual copy fully inside withTenantAgent — the tenant session is released on
      // exit (the same discipline as the #65/tenant-session-release fix elsewhere in this repo);
      // never hold a tenant-scoped handle outside the callback.
      await agent.modules.tenants.withTenantAgent({ tenantId }, async (tenantAgent) => {
        const { store: baseStore, profile } = await tenantAgent.context.dependencyManager
          .resolve(AskarStoreManager)
          .getInitializedStoreWithProfile(tenantAgent.context)

        if (!profile) {
          throw new Error(`No Askar profile resolved for tenant '${tenantId}'`)
        }

        tempStore = await Store.provision({
          uri: `sqlite://${tempDbPath}`,
          // Argon2IMod, not Raw: Askar's raw KDF only accepts a base58-encoded 32-byte key
          // (i.e. Store.generateRawKey() output) and rejects any normal passphrase before
          // copyProfile ever runs. Argon2i derives a real key from whatever passKey the caller
          // supplied, which is what the `passKey`-as-passphrase contract above requires.
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

      // Note: s3Key is persisted, not a minted downloadUrl — getJobStatus mints a fresh
      // short-lived pre-signed URL on every read instead, so a job read long after completion
      // (up to the 24h job TTL) still returns a live link. See WalletPortabilityJobRecord.
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
      // Stop the heartbeat before anything else in this block -- no point touching updatedAt
      // again once cleanup has started. Always defined now — see exportWallet, which starts it
      // before the Pending save and passes it in, rather than this function starting its own.
      clearInterval(heartbeat)
      // Guaranteed cleanup regardless of success/failure — the export key and the plaintext
      // wallet artifact must never linger on local disk. Removing the whole workDir (rather
      // than the individual .db/.db.gz paths) also catches Askar's -shm/-wal sidecars and the
      // mkdtemp directory itself.
      if (tempStore) {
        await tempStore.close().catch(() => undefined)
      }
      if (workDir) {
        await fs.rm(workDir, { recursive: true, force: true }).catch(() => undefined)
      }
      // Release the tenant's active-job slot regardless of outcome — this always runs exactly
      // once per job, whether it completed or failed. See exportWallet's reservation above.
      await this.jobStore.releaseActiveJob(tenantId, jobId).catch(() => undefined)
    }
  }

  // Hashes the *uploaded* artifact (the gzip output), not the plaintext source — the checksum
  // returned to callers must match what they'll actually download and verify (e.g.
  // cloud-wallet-service's backup-wallet import flow), which is the .gz, never the plaintext .db.
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

  // Streams the artifact rather than fs.readFile-ing it into a single Buffer first — this process
  // also serves DIDComm and every other tenant's API traffic, and nothing caps how many exports
  // can run concurrently, so buffering full wallet artifacts in memory here is a real OOM risk
  // (this repo has already fought exactly this failure mode once, see the purge scheduler's
  // paged-scan fix).
  private async uploadToS3(filePath: string, key: string): Promise<void> {
    // s3.upload(), not putObject() — putObject with a raw ReadStream body is not retry-safe in
    // aws-sdk v2. Its request layer retries transient failures (5xx, RequestTimeout, ECONNRESET,
    // throttling; maxRetries defaults to 3), and on retry it re-sends httpRequest.body — but
    // createReadStream(filePath) is a one-shot, non-rewindable stream already (partially or
    // fully) consumed by the first attempt. The retry then sends a short/empty body while
    // ContentLength still claims the full size, so S3 rejects with IncompleteBody (or the request
    // stalls until the socket timeout) instead of the retry actually recovering the upload.
    // s3.upload()'s managed multipart uploader re-reads only the failed part from its own
    // buffered chunks, so a transient error partway through a large export doesn't force the
    // caller to re-run the whole job — and it also removes the 5 GB single-PUT ceiling that came
    // with putObject, since ContentLength/fs.stat are no longer needed at all.
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
      // Carried forward, not dropped -- this rebuilds the whole record, and s3Key/checksum are
      // only ever set by runExport's own inline Completed save, never by this helper. Any future
      // call site that marks an already-completed job Failed/InProgress from outside runExport
      // (a job-level timeout, say) would otherwise silently erase the download pointer:
      // getJobStatus only mints a downloadUrl when job.status === Completed && job.s3Key, so a
      // later re-save missing s3Key orphans the artifact in the bucket with no way to reach it
      // through the API. See the #72 review.
      s3Key: existing?.s3Key,
      checksum: existing?.checksum,
      // Preserves a backupProfile written on an earlier InProgress/Completed save for this job
      // if this particular call doesn't pass one explicitly (export callers never do).
      backupProfile: backupProfile ?? existing?.backupProfile,
    })
  }

  // Touches the job record's updatedAt on HEARTBEAT_INTERVAL_MS while its job is still
  // Pending/InProgress, so WalletPortabilityJobStore's MAX_IN_PROGRESS_DURATION_MS reclaim
  // genuinely means "this process stopped heartbeating", not "this job started more than N ago"
  // -- a real, unbounded-duration transfer (up to MAX_DOWNLOAD_BYTES/MAX_DECOMPRESSED_BYTES) must
  // not be falsely reclaimed mid-run, which would admit a second concurrent job on the same
  // tenant profile. See the #73 review. Callers must clearInterval() the returned handle in
  // their own finally block regardless of outcome.
  //
  // Delegates the actual check-and-write to jobStore.touchIfActive rather than doing its own
  // get() + setJobStatus(): that two-round-trip shape left a window where a tick already in
  // flight when the main flow's terminal write (Completed/Failed) landed would silently clobber
  // it back to non-terminal. touchIfActive does the check and the write as one atomic operation,
  // closing that window outright rather than narrowing it with an extra re-check. See the #73
  // review.
  //
  // Also refreshes the tenant's active-job *reservation* (touchActiveJobReservation), not just
  // the job record -- the reservation's own Redis TTL is set once, at tryReserveActiveJob time,
  // and was never refreshed by anything. A transfer that's still genuinely alive and heartbeating
  // past that TTL (there is no absolute time cap on a transfer, only the byte cap and the
  // heartbeat itself) would otherwise have its reservation silently expire out of Redis while the
  // job record stays alive, letting a second caller's tryReserveActiveJob succeed against a first
  // job that never actually died. See the #73 review.
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

    // See exportWallet's identical reservation for the rationale — export and import share the
    // same tenant profile namespace, so this guards against both a concurrent import *and* a
    // concurrent export for the same tenant, not just a second import.
    const conflictingJobId = await this.jobStore.tryReserveActiveJob(tenantId, jobId)
    if (conflictingJobId) {
      throw new WalletPortabilityJobConflictError(tenantId, conflictingJobId)
    }

    // See exportWallet's identical reasoning — started before the Pending save below, not after
    // InProgress is reached, so Pending gets the same refreshed lease InProgress already relies
    // on. Passed into runImport rather than started there, since by the time runImport's own try
    // block runs, this Pending window has already passed.
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

    // Fire-and-forget: matches the plan's "async job with status, not a blocking call" requirement.
    // Best-effort mark Failed + release the reservation here too — same reasoning as
    // exportWallet's identical handler: if setJobStatus(InProgress) itself is what threw, the job
    // would otherwise be stranded at Pending *and* the tenant's active-job slot would never be
    // released, wedging every future export/import for this tenant until the 24h TTL self-clears.
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
   * KNOWN GAP, not yet closed (raised in the #73 review, not fully addressed by
   * `WalletPortabilityJobConflictError` below): between `renameProfile` and `copyProfile`
   * completing (seconds to minutes for a real wallet), the tenant's `tenant-<id>` profile does
   * not exist in the base store at all. The agent is still live and multi-tenant for the whole
   * window, so:
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
   * a 503/maintenance flag for the duration of the copy) is follow-up work, not done in this pass;
   * this is documented here rather than left as a silent limitation.
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
    // Tracks "does a profile actually exist at backupProfile's name right now" -- deliberately
    // NOT reusable from renamedAway, which the success path clears once copyProfile completes
    // (so a later, unrelated failure — e.g. the job-store write — doesn't wrongly trigger
    // rollback against an already-imported profile). Sits true from the instant renameProfile
    // lands, false again once rollback puts it back; stays false the whole time if renameProfile
    // itself is what throws, since no profile was ever created. Read by the Failed-record report
    // below so a successful rollback and a never-attempted-because-nothing-existed-yet failure
    // are both correctly reported as "no backup to report" -- an earlier version only checked
    // "did rollback succeed", which missed that second case: renameProfile failing outright left
    // backupProfile pointing at a profile name that was never created, handing an operator a
    // recovery pointer to nothing. See the #73 review.
    let backupExists = false
    // Hoisted out of the try (was a local const inside it, out of scope for the finally below) —
    // same reasoning as runExport's identical field: Askar's sqlite backend leaves `-shm`/`-wal`
    // sidecar files next to the `.db` while it's open, which survive if importedStore.close()
    // itself is what's failing (exactly the case the finally exists for). Removing only the two
    // explicit paths this service creates left those sidecars — which hold the imported tenant
    // wallet's contents — and the mkdtemp directory itself behind indefinitely.
    let workDir: string | undefined

    try {
      // Inside the try now (was previously outside it) — same reasoning as runExport: if this
      // itself throws, the job must land in the catch below and be marked Failed, not silently
      // stay at Pending forever.
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
        // Must match the KdfMethod the artifact was provisioned with, or Store.open rejects it
        // outright ("Store key method mismatch", verified against the real binding) before ever
        // reaching a wrong-passphrase error. Export provisions with Argon2IMod (see runExport) —
        // this was still Raw here, left over from before that fix; every real import would have
        // failed on this line for any artifact produced by the fixed export path.
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

        // Take the source profile FROM the artifact rather than requiring it to already equal
        // the target tenant's profile name. The old "must match" guard hard-coupled an artifact
        // to the exact tenant id it was exported from — it would reject the main restore
        // scenario (importing onto a rebuilt agent / a freshly created tenant with a new uuid).
        // An artifact produced by this service's own export always contains exactly one profile
        // (see runExport), so asserting that and using it as fromProfile is verified to work for
        // that case. NOT verified: a legacy askar-wallet-tools artifact. Two things would need
        // checking against a real one before that claim could be made — Store.open above
        // hardcodes KdfMethod.Argon2IMod, which Askar rejects outright (before this guard is ever
        // reached) if the legacy artifact was provisioned with a different KDF; and nothing here
        // establishes that askar-wallet-tools' own export always yields exactly one profile
        // (e.g. no leftover default profile alongside it) the way this service's export does. See
        // the #73 review — trimmed the claim rather than assert compatibility that isn't tested.
        // Asserted once, then used unconditionally below — importedStore is always assigned
        // (from an awaited Store.open) before this callback runs, so this isn't reachable
        // today. But the `?.` it replaces made that assumption silently: a nullish
        // importedStore would have skipped copyProfile entirely while renamedAway/backupExists
        // still say the rename succeeded, completing the job with the tenant's live profile
        // gone. listProfiles() above already threw loudly on its own nullish case; this makes
        // the one destructive step (copyProfile) fail the same way instead of silently no-op.
        // See the #73 review.
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
        // Set the instant the rename lands, independent of renamedAway (which the success path
        // below clears once copyProfile completes) -- this tracks "does a backup profile exist
        // right now", not "would rollback be attempted". See the backupExists reporting fix below.
        backupExists = true

        await importedStore.copyProfile({ toStore: baseStore, fromProfile: sourceProfile, toProfile: profile })

        // Past this point the imported profile is in place under the tenant's real name — a
        // later failure (e.g. the job-store write below) must NOT trigger the rollback, which
        // would otherwise try to rename the backup on top of the now-successfully-imported
        // profile. Verified against the real binding: that rename fails outright (UNIQUE
        // constraint), so the practical effect was a false "manual intervention required" alert
        // for an import that had, in fact, already succeeded.
        renamedAway = false
        // Cleared at the same point, for the same reason: from this instant, whatever sits at
        // backupProfile is a stale pre-import copy, not the tenant's current data. A later throw
        // in this same try (e.g. withTenantAgent's own endSession() rejecting under load) used to
        // still report this Failed record with backupExists left true, so an operator following
        // the documented recovery path ("the tenant's real data may still be at profile X") would
        // rename the stale backup back over the successfully-imported profile, destroying it. The
        // -pre-import-<jobId> profile itself is still left in the store either way -- this only
        // stops it being named in a Failed record as though it were the recovery path. See the
        // #73 review.
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
      // The pre-import profile is intentionally never auto-deleted (see the docblock above) —
      // but it needs to be discoverable somewhere other than a 24h-TTL'd job record. Logging it
      // at info gives an operator a durable trail to reap it later. There is no cleanup
      // endpoint yet; that's a known follow-up, not something silently dropped.
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
              // copyProfile creates the target profile before it starts copying entries, so a
              // failure partway through a copy can leave `profile` present-but-partial in the
              // base store — the rename back below would then hit a Duplicate/UNIQUE error
              // against that half-copied profile. Clear it first so the rollback can actually
              // succeed instead of landing in the "manual intervention required" branch below
              // for a failure it could have recovered from on its own.
              const currentProfiles = await baseStore.listProfiles()
              if (currentProfiles.includes(profile)) {
                await baseStore.removeProfile(profile)
              }
              await baseStore.renameProfile({ fromProfile: backupProfile as string, toProfile: profile })
              backupExists = false
            }
          })
        } catch (rollbackError) {
          // backupProfile is included here so an operator doesn't have to reverse-engineer the
          // `${profile}-pre-import-${jobId}` naming convention from source to find the tenant's
          // stranded data — and it's threaded into the job record below for the same reason.
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
        // backupExists, not "!rollbackSucceeded" -- the earlier check covered a successful
        // rollback correctly, but missed its mirror: when renameProfile itself is what throws,
        // backupExists (like renamedAway) never becomes true, so no profile was ever created at
        // all, and reporting backupProfile here would hand an operator a recovery pointer to a
        // profile that doesn't exist. backupExists means exactly "a profile currently sits at
        // this name", true from the instant the rename lands and cleared again only once
        // rollback successfully puts it back. See the #73 review.
        backupExists ? backupProfile : undefined,
      )
    } finally {
      // Stop the heartbeat before anything else in this block, same reasoning as runExport's
      // identical finally. Always defined now — see importWallet, which starts it before the
      // Pending save and passes it in, rather than this function starting its own.
      clearInterval(heartbeat)
      if (importedStore) {
        await importedStore.close().catch(() => undefined)
      }
      // Guaranteed cleanup regardless of success/failure — removing the whole workDir (rather
      // than the individual gzipPath/importedDbPath paths) also catches Askar's -shm/-wal
      // sidecars and the mkdtemp directory itself. See runExport's identical finally.
      if (workDir) {
        await fs.rm(workDir, { recursive: true, force: true }).catch(() => undefined)
      }
      // Release the tenant's active-job slot regardless of outcome. See importWallet's
      // reservation above and runExport's identical release for the export side.
      await this.jobStore.releaseActiveJob(tenantId, jobId).catch(() => undefined)
    }
  }

  // exportUrl is caller-supplied and goes straight into a server-side fetch — without these checks
  // this endpoint is an SSRF primitive (any base-wallet token holder can make the agent GET an
  // arbitrary internal URL, e.g. the cloud metadata endpoint) plus a content-confirmation oracle
  // (the checksum-mismatch error echoes sha256(response body) back to the caller). The only
  // legitimate input is a pre-signed URL for the bucket *this deployment itself* wrote to — scoped
  // to that specific bucket, not "any S3 bucket", since a caller-supplied exportUrl pointing at a
  // different, attacker-controlled bucket must not be trusted just because it's *an* S3 host.
  //
  // Both URL shapes aws-sdk v2 can emit for a real presigned URL are accepted, not just
  // virtual-hosted-style: `getSignedUrl` switches to *path-style* (`s3.<region>.amazonaws.com/
  // <bucket>/<key>`, no bucket in the hostname at all) whenever the bucket name isn't
  // DNS-compatible over TLS — notably, any bucket name containing a dot, which is common when a
  // bucket mirrors a domain (see aws-sdk's own pathStyleBucketName()). An earlier version of this
  // check assumed virtual-hosted-style always applied and would have rejected every presigned URL
  // this service itself minted for such a bucket, with an SSRF-flavored error that gives no hint
  // the real cause is bucket naming. The endpoint suffix stays permissive across the standard/
  // dualstack/FIPS/China-partition forms, so a legitimately configured deployment (any
  // AWS_REGION, including cn-north-1/cn-northwest-1) isn't spuriously rejected either way — only
  // the bucket name itself is fixed, not the whole domain shape.
  private isTrustedExportHost(hostname: string, pathname: string): boolean {
    const bucket = this.getExportBucket()
    const escapedBucket = bucket.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const endpointSuffix = `s3(-fips)?(\\.dualstack)?([.-][a-z0-9-]+)?\\.amazonaws\\.com(\\.cn)?`
    // Virtual-hosted style: <bucket>.s3.<region>.amazonaws.com
    if (new RegExp(`^${escapedBucket}\\.${endpointSuffix}$`, 'i').test(hostname)) {
      return true
    }
    // Path style: s3.<region>.amazonaws.com/<bucket>/... — a legitimate shape for a URL this
    // service minted itself (see this method's own docblock), not an SSRF attempt.
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
      // An HTTP-error response (a 403/404 from S3, typically with a small XML error body) still
      // has bytes to consume -- abandoning it unread without draining or destroying it can leave
      // its underlying keep-alive socket stuck open rather than freed back to node-fetch's
      // connection pool, since the pool doesn't consider a socket free for reuse until the body
      // is fully consumed or explicitly destroyed. destroy() covers a stream that never emits
      // further data on its own; resume() drains one that's still flowing. See the #73 review.
      if (response.body) {
        const errorBody = response.body as unknown as Readable
        errorBody.destroy()
        errorBody.resume()
      }
      throw new Error(`Failed to download export artifact: HTTP ${response.status}`)
    }
    // node-fetch v2's Response.body is a real Node Readable at runtime (hence the existing
    // `.on('data', ...)` below) — @types/node-fetch just types it as the DOM ReadableStream
    // interface, which doesn't declare `.destroy()`. Cast to the real runtime type.
    const body = response.body as unknown as Readable
    const hash = createHash('sha256')
    const dest = createWriteStream(destPath)
    let bytesRead = 0

    // node-fetch@2's own `timeout` option (passed to fetch() above) only covers time-to-first-byte
    // -- it's cleared the instant response headers arrive (verified against the installed
    // node-fetch@2.7.0 source: the request timer is armed on the 'socket' event and cleared in
    // the 'response' handler; the only body-level timer lives inside Body.consumeBody(), which
    // this code deliberately bypasses by streaming response.body directly). Without an inactivity
    // timer here, a stalled body (S3/an LB returns headers, then the socket goes half-open) never
    // rejects: pipeline() below hangs forever, runImport/runExport's finally never runs, the job
    // stays InProgress indefinitely, and the mkdtemp workDir + open write stream leak for the life
    // of the process. Reset on every 'data' event so this bounds inactivity, not total transfer
    // time -- a large (near MAX_DOWNLOAD_BYTES) but genuinely progressing download must not be
    // killed just for taking a while. See the #73 review.
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
    // Cap the *decompressed* output independently of the (already-capped, in downloadAndChecksum)
    // compressed input — gzip's compression ratio can be adversarially enormous (a "decompression
    // bomb": a small compressed artifact can still pass the checksum check and then expand to fill
    // the host's disk), so the compressed-size cap alone doesn't protect this step.
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
// Previously constructed eagerly at module scope in MultiTenancyController.ts, which meant every
// agent process opened a Redis connection at import time — including dedicated (non-tenant)
// agents, where /multi-tenancy/* is rejected outright by authentication.ts — and that connection
// was never closed on shutdown (cliAgent.ts's shutdown() only knows about CacheModuleConfig's
// cache, not this). Constructing lazily on first actual use fixes the former; wiring
// shutdownWalletPortabilityService() into cliAgent.ts's shutdown() fixes the latter. This doesn't
// route construction through tsyringe (there's no existing precedent in this repo for a plain
// service — as opposed to a tsoa @injectable() controller — being registered in the container),
// but a module-level function is still substitutable via jest.mock() in a way an eagerly-created
// const bound in a different file is not.
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
