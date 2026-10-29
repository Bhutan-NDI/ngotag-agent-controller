import type { CreatedImportSession } from '../../services/wallet-portability/ImportSessionStore'
import type {
  ImportWalletResult,
  WalletPortabilityJobRecord,
} from '../../services/wallet-portability/WalletPortabilityTypes'
import type { ExportBucketProbe } from '../../services/wallet-portability/exportBucketProbe'
import type { Agent } from '@credo-ts/core'

import { LogLevel } from '@credo-ts/core'
import { Request as Req } from 'express'
import { Body, Controller, Get, Path, Post, Request, Res, Response, Route, Security, Tags, TsoaResponse } from 'tsoa'
import { injectable } from 'tsyringe'

import { SCOPES } from '../../enums'
import ErrorHandlingService from '../../errorHandlingService'
import {
  getWalletPortabilityService,
  ROOT_IMPORT_SCOPE_ID,
} from '../../services/wallet-portability/WalletPortabilityService'
import { WalletPortabilityJobType } from '../../services/wallet-portability/WalletPortabilityTypes'
import { probeExportBucket } from '../../services/wallet-portability/exportBucketProbe'
import { TsLogger } from '../../utils/logger'

import { mapImportError } from './walletImportErrors'

const CHECKSUM_PATTERN = /^[a-f0-9]{64}$/i
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/

const service = () => getWalletPortabilityService(new TsLogger(LogLevel.info, 'wallet-portability'))

/**
 * Imports a sealed wallet export into a dedicated agent's root wallet (org wallet migration). Dedicated agents
 * only: a multi-tenant agent's tokens are rejected by the security scope.
 */
@Tags('Agent')
@Route('/agent/wallet')
@Security('jwt', [SCOPES.DEDICATED_AGENT])
@injectable()
export class AgentWalletController extends Controller {
  /**
   * Whether this agent can pull an export from its S3 bucket. When it cannot, the platform sends the export itself
   * with POST /agent/wallet/import/upload.
   */
  @Get('/export-bucket')
  public async getExportBucket(): Promise<ExportBucketProbe> {
    return probeExportBucket()
  }

  /**
   * Checks the root wallet is pristine and starts an import session. The returned public key is what the
   * export's store key is sealed to; the private half stays in this agent's memory.
   */
  @Response<{ message: string }>(409, 'TARGET_NOT_PRISTINE')
  @Post('/import-session')
  public async createImportSession(@Request() request: Req): Promise<CreatedImportSession> {
    try {
      return await service().createImportSession(request.agent as Agent)
    } catch (error) {
      throw mapImportError(error)
    }
  }

  /**
   * Merges a sealed export into the root wallet. Async job: returns a job id, poll the status route. With
   * `dryRun` the merge is rolled back after it has run.
   */
  @Response<{ message: string }>(404, 'Import session not found or expired')
  @Response<{ message: string }>(409, 'TARGET_NOT_PRISTINE, STORAGE_VERSION_MISMATCH or an import already running')
  @Post('/import')
  public async importWallet(
    @Request() request: Req,
    @Body()
    body: {
      sessionId: string
      exportUrl: string
      checksum: string
      sealedStoreKey: string
      storageVersion: string
      dryRun?: boolean
    },
    @Res() badRequestError: TsoaResponse<400, { reason: string }>,
  ): Promise<ImportWalletResult> {
    const { sessionId, exportUrl, checksum, sealedStoreKey, storageVersion, dryRun } = body
    if (!sessionId || !exportUrl || !checksum || !sealedStoreKey || !storageVersion) {
      return badRequestError(400, {
        reason: 'sessionId, exportUrl, checksum, sealedStoreKey and storageVersion are all required.',
      })
    }
    if (!CHECKSUM_PATTERN.test(checksum)) {
      return badRequestError(400, { reason: 'checksum must be a 64-character hexadecimal SHA-256 digest.' })
    }
    if (!BASE64_PATTERN.test(sealedStoreKey)) {
      return badRequestError(400, { reason: 'sealedStoreKey must be base64.' })
    }
    try {
      return await service().importRootWallet(request.agent as Agent, {
        sessionId,
        exportUrl,
        checksum: checksum.toLowerCase(),
        sealedStoreKey,
        storageVersion,
        dryRun: true === dryRun,
      })
    } catch (error) {
      throw mapImportError(error)
    }
  }

  /**
   * Poll an import job. On completion it reports how many records and keys the merge inserted.
   */
  @Response<{ message: string }>(500, 'Internal Server Error')
  @Get('/import/status/:jobId')
  public async getImportStatus(
    @Path('jobId') jobId: string,
    @Res() notFoundError: TsoaResponse<404, { reason: string }>,
  ): Promise<WalletPortabilityJobRecord> {
    try {
      const job = await service().getJobStatus(jobId)
      if (!job || job.tenantId !== ROOT_IMPORT_SCOPE_ID || job.type !== WalletPortabilityJobType.Import) {
        return notFoundError(404, { reason: `Import job '${jobId}' not found.` })
      }
      return job
    } catch (error) {
      throw ErrorHandlingService.handle(error)
    }
  }
}
