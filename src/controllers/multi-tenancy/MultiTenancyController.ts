import type { RestMultiTenantAgentModules } from '../../cliAgent'
import type { TenantRecord } from '@credo-ts/tenants'

import { Agent, CacheModuleConfig, JsonTransformer, injectable, LogLevel, RecordNotFoundError } from '@credo-ts/core'
import { Request as Req } from 'express'
import jwt from 'jsonwebtoken'
import { Body, Controller, Delete, Post, Route, Tags, Path, Security, Request, Res, TsoaResponse, Get } from 'tsoa'

import { AgentRole, SCOPES } from '../../enums'
import ErrorHandlingService from '../../errorHandlingService'
import { WalletPortabilityService } from '../../services/wallet-portability/WalletPortabilityService'
import { TsLogger } from '../../utils/logger'
import { CreateTenantOptions } from '../types'

// Constructed once, not per-request — owns a Redis connection for job status (see
// WalletPortabilityJobStore) that must not be re-opened on every call.
const walletPortabilityService = new WalletPortabilityService(new TsLogger(LogLevel.info, 'wallet-portability'))

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
    @Res() internalServerError: TsoaResponse<500, { message: string }>,
  ) {
    try {
      const { passKey } = exportWalletRequest
      if (!passKey) {
        return badRequestError(400, { reason: 'passKey is required.' })
      }
      const agent = request.agent as Agent<RestMultiTenantAgentModules>
      return await walletPortabilityService.exportWallet(agent, tenantId, passKey)
    } catch (error) {
      return internalServerError(500, { message: `something went wrong: ${error}` })
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
      const job = await walletPortabilityService.getJobStatus(jobId)
      if (!job || job.tenantId !== tenantId) {
        return notFoundError(404, { reason: `Export job '${jobId}' not found for tenant '${tenantId}'.` })
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
