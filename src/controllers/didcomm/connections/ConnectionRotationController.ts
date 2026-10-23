import type { RotationStatus } from '../../../services/did-rotation/RotationRunner'
import type { RotateOutcome } from '../../../services/did-rotation/RotationService'

import { Body, Controller, Get, Path, Post, Response, Route, Security, Tags } from 'tsoa'
import { injectable } from 'tsyringe'

import { SCOPES } from '../../../enums'
import ErrorHandlingService from '../../../errorHandlingService'
import { ConflictError } from '../../../errors/errors'
import { getRotationRuntime } from '../../../services/did-rotation/rotationRuntime'

const runtime = () => {
  const current = getRotationRuntime()
  if (!current) throw new ConflictError('ROTATION_UNAVAILABLE')
  return current
}

/**
 * Moves an organisation's holder connections to a new DID on this agent, after the organisation's wallet was moved
 * here (org wallet migration). Dedicated agents only.
 */
@Tags('Connections')
@Route()
@Security('jwt', [SCOPES.DEDICATED_AGENT])
@injectable()
export class ConnectionRotationController extends Controller {
  /**
   * Starts rotating every completed connection, most recently active first, in batches (50 a minute by default).
   * Returns the job status; a job that is already running is left alone.
   */
  @Response<{ message: string }>(409, 'ROTATION_UNAVAILABLE')
  @Post('/didcomm/connections/rotate-all')
  public async rotateAll(@Body() body: { batchSize?: number; intervalSeconds?: number }): Promise<RotationStatus> {
    try {
      return await runtime().runner.start({
        batchSize: body.batchSize,
        intervalMs: undefined === body.intervalSeconds ? undefined : body.intervalSeconds * 1000,
      })
    } catch (error) {
      throw ErrorHandlingService.handle(error)
    }
  }

  /**
   * Progress of the rotation: how many connections are pending, waiting for an acknowledgement, stale (no answer for
   * 30 days), refused, updated, retrying or failed.
   */
  @Get('/didcomm/connections/rotate-all/status')
  public async getRotationStatus(): Promise<RotationStatus> {
    try {
      return await runtime().runner.status()
    } catch (error) {
      throw ErrorHandlingService.handle(error)
    }
  }

  /**
   * Rotates one connection now. Also retries a connection whose earlier attempts gave up.
   */
  @Post('/didcomm/connections/:connectionId/rotate')
  public async rotateConnection(@Path('connectionId') connectionId: string): Promise<RotateOutcome> {
    try {
      return await runtime().service.rotateConnection(connectionId, { force: true })
    } catch (error) {
      throw ErrorHandlingService.handle(error)
    }
  }
}
