import type { RestMultiTenantAgentModules } from '../../cliAgent'
import type { TenantRecord } from '@credo-ts/tenants'

import { Agent, CacheModuleConfig, JsonTransformer, injectable, LogLevel, RecordNotFoundError } from '@credo-ts/core'
import { Request as Req } from 'express'
import jwt from 'jsonwebtoken'
import { Body, Controller, Delete, Post, Route, Tags, Path, Security, Request, Res, TsoaResponse, Get } from 'tsoa'

import { AgentRole, SCOPES } from '../../enums'
import ErrorHandlingService from '../../errorHandlingService'
import { ConflictError } from '../../errors/errors'
import { getWalletPortabilityService } from '../../services/wallet-portability/WalletPortabilityService'
import { WalletPortabilityJobConflictError } from '../../services/wallet-portability/WalletPortabilityTypes'
import { TsLogger } from '../../utils/logger'
import { CreateTenantOptions } from '../types'

// Minimum length for a caller-supplied wallet export/import passKey. Argon2i (KdfMethod.Argon2IMod)
// derives a real encryption key from whatever string is supplied, so a bare non-empty check let
// through one-character passphrases like "a" -- practical to brute-force offline against an
// artifact that otherwise sits in S3. 16 is a floor, not a strength guarantee: it rules out the
// trivial cases without forcing the caller-remembered-passphrase design (matches the legacy
// contract) into a server-generated-key one, which would be a bigger, separate change. See the
// #72 review.
const MIN_PASSKEY_LENGTH = 16

@Tags('MultiTenancy')
@Security('jwt', [SCOPES.MULTITENANT_BASE_AGENT])
@Route('/multi-tenancy')
@injectable()
export class MultiTenancyController extends Controller {
  @Post('/create-tenant')
  public async createTenant(@Request() request: Req, @Body() createTenantOptions: CreateTenantOptions) {
    const { config } = createTenantOptions
    try {
      const agent = request.agent as Agent<RestMultiTenantAgentModules>
      const tenantRecord: TenantRecord = await agent.modules.tenants.createTenant({ config })
      // Note: logic to store generate token for tenant using BW's secertKey
      // Here no need to change the logic, here only change the logic in 'createToken'
      const token = await this.createToken(agent, tenantRecord.id)
      const withToken = { token, ...tenantRecord }
      return withToken
    } catch (error) {
      throw ErrorHandlingService.handle(error)
    }
  }

  @Post('/get-token/:tenantId')
  public async getTenantToken(
    @Request() request: Req,
    @Path('tenantId') tenantId: string,
    @Res() notFoundError: TsoaResponse<404, { reason: string }>,
    @Res() internalServerError: TsoaResponse<500, { message: string }>,
  ) {
    try {
      const agent = request.agent as unknown as Agent<RestMultiTenantAgentModules>
      // Option1: logic to use tenant's secret key to generate token for tenant
      // let secretKey
      // await agent.modules.tenants.withTenantAgent({ tenantId }, async (tenantAgent) => {
      //   const genericRecord = await tenantAgent.genericRecords.getAll()
      //   const records = genericRecord.find((record) => record?.content?.secretKey !== undefined)
      //   secretKey = records?.content.secretKey as string
      // })

      // Note: logic to store generate token for tenant using BW's secertKey

      const genericRecord = await agent.genericRecords.findAllByQuery({ hasSecretKey: 'true' })
      const secretKey = genericRecord[0]?.content.secretKey as string

      if (!secretKey) {
        throw new Error('secretKey does not exist in wallet')
      }

      const token = await this.createToken(agent, tenantId, secretKey)

      return { token: token }
    } catch (error) {
      if (error instanceof RecordNotFoundError) {
        return notFoundError(404, {
          reason: `SecretKey not found`,
        })
      }

      return internalServerError(500, { message: `Something went wrong: ${error}` })
    }
  }

  @Get(':tenantId')
  public async getTenantById(
    @Request() request: Req,
    @Path('tenantId') tenantId: string,
    @Res() notFoundError: TsoaResponse<404, { reason: string }>,
    @Res() internalServerError: TsoaResponse<500, { message: string }>,
  ) {
    try {
      const agent = request.agent as Agent<RestMultiTenantAgentModules>
      const getTenant = await agent.modules.tenants.getTenantById(tenantId)
      return JsonTransformer.toJSON(getTenant)
    } catch (error) {
      if (error instanceof RecordNotFoundError) {
        return notFoundError(404, {
          reason: `Tenant with id: ${tenantId} not found.`,
        })
      }
      return internalServerError(500, { message: `Something went wrong: ${error}` })
    }
  }

  @Delete(':tenantId')
  public async deleteTenantById(
    @Request() request: Req,
    @Path('tenantId') tenantId: string,
    @Res() notFoundError: TsoaResponse<404, { reason: string }>,
    @Res() internalServerError: TsoaResponse<500, { message: string }>,
  ) {
    try {
      const agent = request.agent as Agent<RestMultiTenantAgentModules>
      const deleteTenant = await agent.modules.tenants.deleteTenantById(tenantId)
      // Invalidate the cached tenant record so a deleted tenant no longer resolves from cache.
      // Key matches the tenants cache patch (patches/@credo-ts+tenants+0.6.2.patch).
      try {
        const cache = agent.dependencyManager.resolve(CacheModuleConfig).cache
        await cache.remove(agent.context, `tenantRecord:${tenantId}`)
      } catch (cacheError) {
        agent.config.logger.warn(`Failed to invalidate tenant cache for ${tenantId}: ${cacheError}`)
      }
      return JsonTransformer.toJSON(deleteTenant)
    } catch (error) {
      if (error instanceof RecordNotFoundError) {
        return notFoundError(404, {
          reason: `Tenant with id: ${tenantId} not found.`,
        })
      }
      return internalServerError(500, { message: `Something went wrong: ${error}` })
    }
  }

  /**
   * Export a tenant's (cloud) wallet — native replacement for the legacy per-request raw-NATS
   * call to the separate askar-wallet-tools Python service. Async job: returns a job id
   * immediately, the actual export runs in the background — poll via the status endpoint below.
   *
   * `passKey` is caller-supplied (matches the legacy contract) and protects the exported
   * artifact — the caller must retain it to import the artifact later; it is never generated
   * or persisted server-side.
   *
   * @returns { jobId, status } — status is always 'pending' on this response
   */
  @Post('/export/:tenantId')
  public async exportTenantWallet(
    @Request() request: Req,
    @Path('tenantId') tenantId: string,
    @Body() exportWalletRequest: { passKey: string },
    @Res() badRequestError: TsoaResponse<400, { reason: string }>,
  ) {
    const { passKey } = exportWalletRequest
    if (!passKey || passKey.length < MIN_PASSKEY_LENGTH) {
      return badRequestError(400, { reason: `passKey must be at least ${MIN_PASSKEY_LENGTH} characters.` })
    }
    const agent = request.agent as Agent<RestMultiTenantAgentModules>
    try {
      // Fail fast with a 404 for a bad/deleted tenantId instead of enqueueing a job that can
      // only ever fail later — without this, POST returns 200 {jobId, pending} regardless, and
      // the caller has to poll and then string-match job.error to tell "bad request" apart from
      // "the export machinery broke". Every sibling endpoint on this controller (getTenantById,
      // deleteTenantById) checks this upfront the same way.
      await agent.modules.tenants.getTenantById(tenantId)
    } catch (error) {
      throw ErrorHandlingService.handle(error)
    }
    try {
      return await getWalletPortabilityService(new TsLogger(LogLevel.info, 'wallet-portability')).exportWallet(
        agent,
        tenantId,
        passKey,
      )
    } catch (error) {
      // Export and import share the tenant's profile namespace and can't safely run
      // concurrently — see WalletPortabilityJobConflictError's docblock.
      if (error instanceof WalletPortabilityJobConflictError) {
        throw new ConflictError(error.message)
      }
      throw ErrorHandlingService.handle(error)
    }
  }

  /**
   * Poll the status of an export job started via POST /export/:tenantId. On completion, the
   * response carries a short-lived pre-signed S3 URL and the artifact's SHA-256 checksum.
   */
  @Get('/export/:tenantId/status/:jobId')
  public async getExportWalletStatus(
    @Path('tenantId') tenantId: string,
    @Path('jobId') jobId: string,
    @Res() notFoundError: TsoaResponse<404, { reason: string }>,
    @Res() internalServerError: TsoaResponse<500, { message: string }>,
  ) {
    try {
      const job = await getWalletPortabilityService(new TsLogger(LogLevel.info, 'wallet-portability')).getJobStatus(
        jobId,
      )
      if (!job || job.tenantId !== tenantId) {
        return notFoundError(404, { reason: `Export job '${jobId}' not found for tenant '${tenantId}'.` })
      }
      return job
    } catch (error) {
      return internalServerError(500, { message: `something went wrong: ${error}` })
    }
  }

  /**
   * Import a tenant's (cloud) wallet from a prior export. Async job: returns a job id
   * immediately — poll via the status endpoint below.
   *
   * The tenant's current profile is never deleted outright: it's renamed aside (see
   * `backupProfile` on the completed job) before the imported profile takes its place, so a bad
   * import always leaves a recovery path. checksum is verified before anything live is touched.
   *
   * @returns { jobId, status } — status is always 'pending' on this response
   */
  @Post('/import/:tenantId')
  public async importTenantWallet(
    @Request() request: Req,
    @Path('tenantId') tenantId: string,
    @Body() importWalletRequest: { exportUrl: string; passKey: string; checksum: string },
    @Res() badRequestError: TsoaResponse<400, { reason: string }>,
    @Res() internalServerError: TsoaResponse<500, { message: string }>,
  ) {
    try {
      const { exportUrl, passKey, checksum } = importWalletRequest
      if (!exportUrl || !passKey || !checksum) {
        return badRequestError(400, { reason: 'exportUrl, passKey and checksum are all required.' })
      }
      const agent = request.agent as Agent<RestMultiTenantAgentModules>
      return await getWalletPortabilityService(new TsLogger(LogLevel.info, 'wallet-portability')).importWallet(
        agent,
        tenantId,
        exportUrl,
        passKey,
        checksum,
      )
    } catch (error) {
      // Export and import share the tenant's profile namespace and can't safely run
      // concurrently — see WalletPortabilityJobConflictError's docblock.
      if (error instanceof WalletPortabilityJobConflictError) {
        throw new ConflictError(error.message)
      }
      return internalServerError(500, { message: `something went wrong: ${error}` })
    }
  }

  /**
   * Poll the status of an import job started via POST /import/:tenantId. On completion, the
   * response carries the name the tenant's pre-import profile was renamed to (backupProfile) —
   * it is never deleted automatically.
   */
  @Get('/import/:tenantId/status/:jobId')
  public async getImportWalletStatus(
    @Path('tenantId') tenantId: string,
    @Path('jobId') jobId: string,
    @Res() notFoundError: TsoaResponse<404, { reason: string }>,
    @Res() internalServerError: TsoaResponse<500, { message: string }>,
  ) {
    try {
      const job = await getWalletPortabilityService(new TsLogger(LogLevel.info, 'wallet-portability')).getJobStatus(
        jobId,
      )
      if (!job || job.tenantId !== tenantId) {
        return notFoundError(404, { reason: `Import job '${jobId}' not found for tenant '${tenantId}'.` })
      }
      return job
    } catch (error) {
      return internalServerError(500, { message: `something went wrong: ${error}` })
    }
  }

  private async createToken(agent: Agent<RestMultiTenantAgentModules>, tenantId: string, secretKey?: string) {
    let key: string
    if (!secretKey) {
      // Option1: logic to use tenant's secret key to generate token for tenant
      // key = await generateSecretKey()
      // await agent.modules.tenants.withTenantAgent({ tenantId }, async (tenantAgent) => {
      //   tenantAgent.genericRecords.save({
      //     content: {
      //       secretKey: key,
      //     },
      //   })
      // })

      // Option2: logic to store generate token for tenant using BW's secertKey
      const genericRecord = await agent.genericRecords.findAllByQuery({ hasSecretKey: 'true' })
      key = genericRecord[0].content.secretKey as string

      if (!key) {
        throw new Error('SecretKey does not exist for basewallet')
      }
    } else {
      key = secretKey
    }
    const token = jwt.sign({ role: AgentRole.RestTenantAgent, tenantId }, key)
    return token
  }
}
