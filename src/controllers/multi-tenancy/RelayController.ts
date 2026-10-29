import type { RestMultiTenantAgentModules } from '../../cliAgent'
import type { ProbeResult, RelayStatus } from '../../services/migration-relay/RelayService'
import type { Agent } from '@credo-ts/core'
import type { Request as Req } from 'express'

import { Body, Controller, Delete, Get, Path, Post, Put, Request, Response, Route, Security, Tags } from 'tsoa'
import { injectable } from 'tsyringe'

import { SCOPES } from '../../enums'
import ErrorHandlingService from '../../errorHandlingService'
import { BadRequestError, ConflictError, NotFoundError } from '../../errors/errors'
import { RelayConflictError, RelayNotFoundError } from '../../services/migration-relay/RelayService'
import { isRelayEnabled } from '../../services/migration-relay/relayConfig'
import { getRelayRuntime } from '../../services/migration-relay/relayRuntime'
import { InvalidRelayTargetError } from '../../services/migration-relay/relayTarget'

const service = () => {
  const runtime = getRelayRuntime()
  if (!runtime) throw new ConflictError('RELAY_DISABLED')
  return runtime.service
}

const mapRelayError = (error: unknown): unknown => {
  if (error instanceof RelayConflictError) return new ConflictError(error.code)
  if (error instanceof RelayNotFoundError) return new NotFoundError(error.message)
  if (error instanceof InvalidRelayTargetError) return new BadRequestError(error.message)
  return ErrorHandlingService.handle(error)
}

/**
 * Admin routes of the migration relay, used by the platform while it moves an organisation off this shared agent.
 * Base-wallet token only. Every route except `health` answers 409 RELAY_DISABLED when the relay is not enabled.
 */
@Tags('Multi-Tenancy')
@Route('/multi-tenancy/relay')
@Security('jwt', [SCOPES.MULTITENANT_BASE_AGENT])
@injectable()
export class RelayController extends Controller {
  /**
   * Whether the relay is enabled on this agent and its Redis is reachable (the platform's preflight check).
   */
  @Get('/health')
  public async getHealth(): Promise<{ enabled: boolean; redisReady: boolean }> {
    const runtime = getRelayRuntime()
    if (!runtime || !isRelayEnabled()) return { enabled: false, redisReady: false }
    return runtime.service.health()
  }

  /**
   * Starts or advances a tenant's relay: HOLD buffers its inbound messages, FORWARD (with the organisation's DIDComm
   * address as `target`) passes them on and delivers whatever was held. Never goes back from FORWARD to HOLD.
   */
  @Response<{ message: string }>(404, 'Tenant not found')
  @Response<{ message: string }>(409, 'RELAY_DISABLED or RELAY_TRANSITION_NOT_ALLOWED')
  @Put('/:tenantId')
  public async putRelay(
    @Request() request: Req,
    @Path('tenantId') tenantId: string,
    @Body() body: { mode: 'HOLD' | 'FORWARD'; target?: string },
  ): Promise<RelayStatus> {
    try {
      return await service().put(request.agent as Agent<RestMultiTenantAgentModules>, tenantId, body)
    } catch (error) {
      throw mapRelayError(error)
    }
  }

  @Response<{ message: string }>(404, 'No relay for this tenant')
  @Get('/:tenantId')
  public async getRelay(@Request() request: Req, @Path('tenantId') tenantId: string): Promise<RelayStatus> {
    try {
      return await service().get(request.agent as Agent<RestMultiTenantAgentModules>, tenantId)
    } catch (error) {
      throw mapRelayError(error)
    }
  }

  /**
   * Removes a HOLD relay after an aborted move. Refused for a FORWARD relay, and while messages are still held.
   */
  @Response<{ message: string }>(409, 'RELAY_NOT_REMOVABLE or RELAY_BUFFER_NOT_EMPTY')
  @Delete('/:tenantId')
  public async deleteRelay(@Request() request: Req, @Path('tenantId') tenantId: string): Promise<void> {
    try {
      await service().remove(request.agent as Agent<RestMultiTenantAgentModules>, tenantId)
      this.setStatus(204)
    } catch (error) {
      throw mapRelayError(error)
    }
  }

  /**
   * Checks the organisation's DIDComm address answers over HTTPS with a valid certificate.
   */
  @Post('/:tenantId/probe')
  public async probe(@Path('tenantId') _tenantId: string, @Body() body: { target: string }): Promise<ProbeResult> {
    try {
      return await service().probe(body.target)
    } catch (error) {
      throw mapRelayError(error)
    }
  }

  /**
   * Hands the held messages back to this agent to process, for an aborted move.
   */
  @Response<{ message: string }>(409, 'RELAY_NOT_HOLDING or RELAY_BUSY (another re-inject is running)')
  @Post('/:tenantId/reinject')
  public async reinject(
    @Request() request: Req,
    @Path('tenantId') tenantId: string,
  ): Promise<{ injected: number; failed: number }> {
    try {
      return await service().reinject(request.agent as Agent<RestMultiTenantAgentModules>, tenantId)
    } catch (error) {
      throw mapRelayError(error)
    }
  }
}
