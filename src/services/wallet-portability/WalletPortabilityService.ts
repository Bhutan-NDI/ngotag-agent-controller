import type { ExportWalletResult, WalletPortabilityJobRecord } from './WalletPortabilityTypes'
import type { RestMultiTenantAgentModules } from '../../cliAgent'
import type { TsLogger } from '../../utils/logger'
import type { Agent } from '@credo-ts/core'
import type { Readable } from 'stream'

import { AskarStoreManager } from '@credo-ts/askar'
import { KdfMethod, Store, StoreKeyMethod } from '@openwallet-foundation/askar-shared'
import * as AWS from 'aws-sdk'
import { createHash } from 'crypto'
import { createReadStream, createWriteStream, promises as fs } from 'fs'
import * as os from 'os'
import * as path from 'path'
import { pipeline } from 'stream/promises'
import { v4 as uuid } from 'uuid'
import { createGzip } from 'zlib'

import { WalletPortabilityJobStore } from './WalletPortabilityJobStore'
import { WalletPortabilityJobStatus, WalletPortabilityJobType } from './WalletPortabilityTypes'

// Short-lived per the plan's requirement — an exported wallet is sensitive, the URL should not
// stay valid longer than a normal download takes.
const PRE_SIGNED_URL_EXPIRY_SECONDS = 15 * 60

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
   *   `POST /export/:tenantId { passKey, walletID }` contract. Any string is accepted: it is
   *   run through Argon2i key derivation (KdfMethod.Argon2IMod) rather than passed to Askar's
   *   raw KDF, which only accepts a base58-encoded 32-byte key and would reject a normal
   *   passphrase outright (see runExport below). The caller must retain this to import the
   *   artifact later; it is never generated or persisted server-side, and never logged.
   */
  public async exportWallet(
    agent: Agent<RestMultiTenantAgentModules>,
    tenantId: string,
    passKey: string,
  ): Promise<ExportWalletResult> {
    const jobId = uuid()
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
    this.runExport(agent, tenantId, jobId, passKey).catch((error) => {
      this.logger.error(`[WalletPortabilityService] export job ${jobId} failed to start: ${error}`)
      this.setJobStatus(jobId, tenantId, WalletPortabilityJobStatus.Failed, `${error}`).catch((statusError) => {
        this.logger.error(
          `[WalletPortabilityService] export job ${jobId} also failed to record its Failed status: ${statusError}`,
        )
      })
    })

    return { jobId, status: WalletPortabilityJobStatus.Pending }
  }

  private async runExport(
    agent: Agent<RestMultiTenantAgentModules>,
    tenantId: string,
    jobId: string,
    passKey: string,
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
      await this.setJobStatus(jobId, tenantId, WalletPortabilityJobStatus.InProgress)

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
      await this.setJobStatus(jobId, tenantId, WalletPortabilityJobStatus.Failed, `${error}`)
    } finally {
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
    status: WalletPortabilityJobStatus,
    error?: string,
  ): Promise<void> {
    const existing = await this.jobStore.get(jobId)
    await this.jobStore.save({
      jobId,
      tenantId,
      type: WalletPortabilityJobType.Export,
      status,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      error,
    })
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
