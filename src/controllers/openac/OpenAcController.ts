import type {
  OpenAcChallengeRequest,
  OpenAcChallengeResponse,
  OpenAcPrecomputeRequest,
  OpenAcPrecomputeResponse,
  OpenAcPresentRequest,
  OpenAcTrustedIssuerRequest,
  OpenAcTrustedIssuerResponse,
  OpenAcProof,
  OpenAcVerifyRequest,
  OpenAcVerifyResponse,
} from './openac.types'
import type { Request as Req } from 'express'

import { Body, Controller, Post, Request, Route, Security, Tags } from 'tsoa'
import { injectable } from 'tsyringe'

import { SCOPES } from '../../enums/enum'
import ErrorHandlingService from '../../errorHandlingService'

import { openAcService } from './OpenAcService'

/**
 * OpenAC PoC. Holder and verifier are tenants of this controller; the tenant agent comes from the bearer token.
 * See docs/openac-poc-plan.md.
 */
@Tags('OpenAC')
@Security('jwt', [SCOPES.TENANT_AGENT, SCOPES.DEDICATED_AGENT])
@Route('openac')
@injectable()
export class OpenAcController extends Controller {
  /**
   * Verifier: issue a single-use challenge (32-byte nonce, valid 2 minutes) for a policy.
   */
  @Post('/verifier/challenge')
  public async challenge(
    @Request() request: Req,
    @Body() body: OpenAcChallengeRequest,
  ): Promise<OpenAcChallengeResponse> {
    try {
      return openAcService.createChallenge(request, body)
    } catch (error) {
      throw ErrorHandlingService.handle(error)
    }
  }

  /**
   * Holder: prepare a credential for proving (the slow step, once per credential). Cached until restart.
   */
  @Post('/holder/precompute')
  public async precompute(
    @Request() request: Req,
    @Body() body: OpenAcPrecomputeRequest,
  ): Promise<OpenAcPrecomputeResponse> {
    try {
      return await openAcService.precompute(request, body)
    } catch (error) {
      throw ErrorHandlingService.handle(error)
    }
  }

  /**
   * Holder: prove the policy for a verifier nonce. The response contains proof data only, no claim values.
   */
  @Post('/holder/present')
  public async present(@Request() request: Req, @Body() body: OpenAcPresentRequest): Promise<OpenAcProof> {
    try {
      return await openAcService.present(request, body)
    } catch (error) {
      throw ErrorHandlingService.handle(error)
    }
  }

  /**
   * Verifier: check a proof. Rejects unknown, expired and reused nonces and issuers that are not trusted.
   */
  @Post('/verifier/verify')
  public async verify(@Request() request: Req, @Body() body: OpenAcVerifyRequest): Promise<OpenAcVerifyResponse> {
    try {
      return await openAcService.verify(request, body)
    } catch (error) {
      throw ErrorHandlingService.handle(error)
    }
  }

  /**
   * Verifier: trust an issuer. The verifier resolves the did itself; proofs never choose the trust list.
   * Only this verifier tenant's own list changes. Without a trusted issuer every proof is rejected.
   */
  @Post('/verifier/trusted-issuers')
  public async registerTrustedIssuer(
    @Request() request: Req,
    @Body() body: OpenAcTrustedIssuerRequest,
  ): Promise<OpenAcTrustedIssuerResponse> {
    try {
      return await openAcService.registerTrustedIssuer(request, body)
    } catch (error) {
      throw ErrorHandlingService.handle(error)
    }
  }
}
