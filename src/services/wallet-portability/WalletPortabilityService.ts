import type { ExportWalletResult, WalletPortabilityJobRecord } from './WalletPortabilityTypes'
import type { RestMultiTenantAgentModules } from '../../cliAgent'
import type { TsLogger } from '../../utils/logger'
import type { Agent } from '@credo-ts/core'

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
  putObject(params: { Bucket: string; Key: string; Body: Buffer; ServerSideEncryption: string }): {
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
    return this.jobStore.get(jobId)
  }

  public async exportWallet(agent: Agent<RestMultiTenantAgentModules>, tenantId: string): Promise<ExportWalletResult> {
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
    this.runExport(agent, tenantId, jobId).catch((error) => {
      this.logger.error(`[WalletPortabilityService] export job ${jobId} failed to start: ${error}`)
    })

    return { jobId, status: WalletPortabilityJobStatus.Pending }
  }

  private async runExport(agent: Agent<RestMultiTenantAgentModules>, tenantId: string, jobId: string): Promise<void> {
    await this.setJobStatus(jobId, tenantId, WalletPortabilityJobStatus.InProgress)

    let tempStore: Store | undefined
    let tempDbPath: string | undefined
    let gzipPath: string | undefined

    try {
      const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wallet-export-'))
      tempDbPath = path.join(workDir, `${jobId}.db`)

      // Never touches the real wallet passphrase — this key only protects a brand-new,
      // throwaway temp file that's deleted (see finally block) as soon as it's zipped+uploaded.
      const exportKey = Store.generateRawKey()

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
          keyMethod: new StoreKeyMethod(KdfMethod.Raw),
          passKey: exportKey,
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
      const downloadUrl = this.getPresignedUrl(s3Key)

      const existing = await this.jobStore.get(jobId)
      await this.jobStore.save({
        jobId,
        tenantId,
        type: WalletPortabilityJobType.Export,
        status: WalletPortabilityJobStatus.Completed,
        createdAt: existing?.createdAt ?? new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        downloadUrl,
        checksum,
      })
    } catch (error) {
      this.logger.error(`[WalletPortabilityService] export job ${jobId} failed: ${error}`)
      await this.setJobStatus(jobId, tenantId, WalletPortabilityJobStatus.Failed, `${error}`)
    } finally {
      // Guaranteed cleanup regardless of success/failure — the export key and the plaintext
      // wallet artifact must never linger on local disk.
      if (tempStore) {
        await tempStore.close().catch(() => undefined)
      }
      if (tempDbPath) {
        await fs.rm(tempDbPath, { force: true }).catch(() => undefined)
      }
      if (gzipPath) {
        await fs.rm(gzipPath, { force: true }).catch(() => undefined)
      }
    }
  }

  private async gzipAndChecksum(sourcePath: string, destPath: string): Promise<string> {
    const hash = createHash('sha256')
    const source = createReadStream(sourcePath)
    const dest = createWriteStream(destPath)
    source.on('data', (chunk) => hash.update(chunk))
    await pipeline(source, createGzip(), dest)
    return hash.digest('hex')
  }

  private getExportBucket(): string {
    const bucket = process.env.AWS_WALLET_EXPORT_BUCKET
    if (!bucket) {
      throw new Error('AWS_WALLET_EXPORT_BUCKET is not configured')
    }
    return bucket
  }

  private async uploadToS3(filePath: string, key: string): Promise<void> {
    const body = await fs.readFile(filePath)
    await this.s3
      .putObject({
        Bucket: this.getExportBucket(),
        Key: key,
        Body: body,
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
}
