import {
  // AcceptProofPresentationOptions,
  AcceptProofRequestOptions,
  ConnectionRecord,
  CreateProofRequestOptions,
  DidExchangeRole,
  DidExchangeState,
  ProofExchangeRecord,
  // IndyProofFormat,
  ProofExchangeRecordProps,
  ProofsProtocolVersionType,
  // ProposeProofOptions,
  // V1ProofService,
  // V2ProofService,
} from '@aries-framework/core'

import {
  LegacyIndyCredentialFormatService,
  LegacyIndyProofFormatService,
  V1ProofProtocol
} from '@aries-framework/anoncreds'

import { Agent, RecordNotFoundError } from '@aries-framework/core'
import { Body, Controller, Delete, Example, Get, Path, Post, Query, Res, Route, Tags, TsoaResponse } from 'tsoa'
import { injectable } from 'tsyringe'

import { ProofRecordExample, RecordId } from '../examples'
import { AcceptProofProposal, RequestProofOptions, RequestProofProposalOptions } from '../types'

@Tags('Proofs')
@Route('/proofs')
@injectable()
export class ProofController extends Controller {
  private agent: Agent
  public constructor(agent: Agent) {
    super()
    this.agent = agent
  }

  /**
   * Retrieve all proof records
   *
   * @param threadId
   * @returns ProofRecord[]
   */
  @Example<ProofExchangeRecordProps[]>([ProofRecordExample])
  @Get('/')
  public async getAllProofs(@Query('threadId') threadId?: string) {
    let proofs = await this.agent.proofs.getAll()

    if (threadId) proofs = proofs.filter((p) => p.threadId === threadId)

    return proofs.map((proof) => proof.toJSON())
  }

  /**
   * Retrieve proof record by proof record id
   *
   * @param proofRecordId
   * @returns ProofRecord
   */
  @Get('/:proofRecordId')
  @Example<ProofExchangeRecordProps>(ProofRecordExample)
  public async getProofById(
    @Path('proofRecordId') proofRecordId: RecordId,
    @Res() notFoundError: TsoaResponse<404, { reason: string }>,
    @Res() internalServerError: TsoaResponse<500, { message: string }>
  ) {
    try {
      const proof = await this.agent.proofs.getById(proofRecordId)

      return proof.toJSON()
    } catch (error) {
      if (error instanceof RecordNotFoundError) {
        return notFoundError(404, {
          reason: `proof with proofRecordId "${proofRecordId}" not found.`,
        })
      }
      return internalServerError(500, { message: `something went wrong: ${error}` })
    }
  }

  /**
   * Deletes a proof record in the proof repository.
   *
   * @param proofRecordId
   */
  // @Delete('/:proofRecordId')
  // public async deleteProof(
  //   @Path('proofRecordId') proofRecordId: RecordId,
  //   @Res() notFoundError: TsoaResponse<404, { reason: string }>,
  //   @Res() internalServerError: TsoaResponse<500, { message: string }>
  // ) {
  //   try {
  //     this.setStatus(204)
  //     await this.v1ProofProtocol.delete(proofRecordId)
  //   } catch (error) {
  //     if (error instanceof RecordNotFoundError) {
  //       return notFoundError(404, {
  //         reason: `proof with proofRecordId "${proofRecordId}" not found.`,
  //       })
  //     }
  //     return internalServerError(500, { message: `something went wrong: ${error}` })
  //   }
  // }

  /**
   * Initiate a new presentation exchange as prover by sending a presentation proposal request
   * to the connection with the specified connection id.
   *
   * @param proposal
   * @returns ProofRecord
   */
  @Post('/propose-proof')
  @Example<ProofExchangeRecordProps>(ProofRecordExample)
  public async proposeProof(
    @Body() requestProofProposalOptions: RequestProofProposalOptions,
    @Res() notFoundError: TsoaResponse<404, { reason: string }>,
    @Res() internalServerError: TsoaResponse<500, { message: string }>
  ) {

    try {

      const proof = await this.agent.proofs.proposeProof({
        connectionId: requestProofProposalOptions.connectionId,
        protocolVersion: 'v1' as ProofsProtocolVersionType<[]>,
        proofFormats: requestProofProposalOptions.proofFormats,
        comment: requestProofProposalOptions.comment,
        autoAcceptProof: requestProofProposalOptions.autoAcceptProof,
        goalCode: requestProofProposalOptions.goalCode,
        parentThreadId: requestProofProposalOptions.parentThreadId
      })

      return proof
    } catch (error) {
      if (error instanceof RecordNotFoundError) {
        return notFoundError(404, {
          reason: `connection with connection id "${requestProofProposalOptions.connectionId}" not found.`,
        })
      }
      return internalServerError(500, { message: `something went wrong: ${error}` })
    }
  }

  /**
   * Accept a presentation proposal as verifier by sending an accept proposal message
   * to the connection associated with the proof record.
   *
   * @param proofRecordId
   * @param proposal
   * @returns ProofRecord
   */
  @Post('/:proofRecordId/accept-proposal')
  @Example<ProofExchangeRecordProps>(ProofRecordExample)
  public async acceptProposal(
    @Body() acceptProposal: AcceptProofProposal,
    @Res() notFoundError: TsoaResponse<404, { reason: string }>,
    @Res() internalServerError: TsoaResponse<500, { message: string }>
  ) {
    try {
      const proof = await this.agent.proofs.acceptProposal(acceptProposal)

      return proof;
    } catch (error) {
      if (error instanceof RecordNotFoundError) {
        return notFoundError(404, {
          reason: `proof with proof record  "${acceptProposal.proofRecordId}" not found.`,
        })
      }
      return internalServerError(500, { message: `something went wrong: ${error}` })
    }
  }

  /**
   * Creates a presentation request not bound to any proposal or existing connection
   *
   * @param request
   * @returns ProofRequestMessageResponse
   */
  // @Post('/request-outofband-proof')
  // // @Example<{ proofUrl: string; proofRecord: ProofExchangeRecordProps }>({
  // //   proofUrl: 'https://example.com/proof-url',
  // //   proofRecord: ProofRecordExample,
  // // })
  // public async requestProofOutOfBand(@Body() request: RequestProofOptions) {
  //   // const requestProofOutOfBandRequestPayload: CreateProofRequestOptions<
  //   //   [IndyProofFormat],
  //   //   [V1ProofService, V2ProofService<[IndyProofFormat]>]
  //   // > = {
  //   //   protocolVersion: request.protocolVersion,
  //   //   proofFormats: request.proofFormats,
  //   //   comment: request.comment,
  //   //   autoAcceptProof: request.autoAcceptProof,
  //   //   parentThreadId: request.parentThreadId,
  //   // }
  //   const { connectionId, proofRequestOptions, ...config } = request

  //   const proof = await this.agent.proofs.createRequest({
  //     protocolVersion: config.protocolVersion,
  //     comment: config.comment,
  //     proofFormats: {
  //       indy: {
  //         name: 'proof-request',
  //         version: '1.0',
  //         nonce: await this.agent.wallet.generateNonce(),
  //         requestedAttributes: proofRequestOptions.requestedAttributes,
  //         requestedPredicates: proofRequestOptions.requestedPredicates,
  //       },
  //     },
  //     autoAcceptProof: request.autoAcceptProof,
  //   })

  //   return {
  //     proofUrl: `${this.agent.config.endpoints[0]}/?d_m=${JsonEncoder.toBase64URL(
  //       proof.message.toJSON({ useDidSovPrefixWhereAllowed: this.agent.config.useDidSovPrefixWhereAllowed })
  //     )}`,
  //     proofRecord: proof.proofRecord,
  //   }
  // }

  /**
   * Creates a presentation request bound to existing connection
   *
   * @param request
   * @returns ProofRecord
   */
  // @Post('/request-proof')
  // // @Example<ProofExchangeRecordProps>(ProofRecordExample)
  // public async requestProof(
  //   @Body() request: RequestProofOptions,
  //   @Res() notFoundError: TsoaResponse<404, { reason: string }>,
  //   @Res() internalServerError: TsoaResponse<500, { message: string }>
  // ) {
  //   // const { connectionId, proofRequestOptions, ...config } = request

  //   try {
  //     const requestProofPayload: RequestProofOptions = {
  //       protocolVersion: request.protocolVersion,
  //       proofFormats: request.proofFormats,
  //       comment: request.comment,
  //       autoAcceptProof: request.autoAcceptProof,
  //       parentThreadId: request.parentThreadId,
  //       connectionId: request.connectionId,
  //     }
  //     const proof = await this.agent.proofs.requestProof(requestProofPayload)

  //     return proof.toJSON()
  //   } catch (error) {
  //     if (error instanceof RecordNotFoundError) {
  //       return notFoundError(404, {
  //         reason: `connection with connectionId "${request.connectionId}" not found.`,
  //       })
  //     }
  //     return internalServerError(500, { message: `something went wrong: ${error}` })
  //   }
  // }

  @Post('/request-proof')
  @Example<ProofExchangeRecordProps>(ProofRecordExample)
  public async requestProof(
    @Body() requestProofOptions: RequestProofOptions,
    @Res() notFoundError: TsoaResponse<404, { reason: string }>,
    @Res() internalServerError: TsoaResponse<500, { message: string }>
  ) {
    try {

      const requestProofPayload = {
        connectionId: requestProofOptions.connectionId,
        protocolVersion: requestProofOptions.protocolVersion as ProofsProtocolVersionType<[]>,
        comment: requestProofOptions.comment,
        proofFormats: requestProofOptions.proofFormats,
        autoAcceptProof: requestProofOptions.autoAcceptProof,
        goalCode: requestProofOptions.goalCode,
        parentThreadId: requestProofOptions.parentThreadId,
        willConfirm: requestProofOptions.willConfirm
      }
      const proof = await this.agent.proofs.requestProof(requestProofPayload)

      return proof
    } catch (error) {
      return internalServerError(500, { message: `something went wrong: ${error}` })
    }
  }

  /**
   * Accept a presentation request as prover by sending an accept request message
   * to the connection associated with the proof record.
   *
   * @param proofRecordId
   * @param request
   * @returns ProofRecord
   */
  @Post('/:proofRecordId/accept-request')
  @Example<ProofExchangeRecordProps>(ProofRecordExample)
  public async acceptRequest(
    @Path('proofRecordId') proofRecordId: string,
    @Body()
    request: {
      filterByPresentationPreview?: boolean
      filterByNonRevocationRequirements?: boolean
      comment?: string
    },
    @Res() notFoundError: TsoaResponse<404, { reason: string }>,
    @Res() internalServerError: TsoaResponse<500, { message: string }>
  ) {
    try {

      const requestedCredentials = await this.agent.proofs.selectCredentialsForRequest({
        proofRecordId,
      })

      const acceptProofRequest: AcceptProofRequestOptions = {
        proofRecordId,
        comment: request.comment,
        proofFormats: requestedCredentials.proofFormats,
      }

      const proof = await this.agent.proofs.acceptRequest(acceptProofRequest)

      return proof.toJSON()
    } catch (error) {
      if (error instanceof RecordNotFoundError) {
        return notFoundError(404, {
          reason: `proof with proofRecordId "${proofRecordId}" not found.`,
        })
      }
      return internalServerError(500, { message: `something went wrong: ${error}` })
    }
  }

  /**
   * Accept a presentation as prover by sending an accept presentation message
   * to the connection associated with the proof record.
   *
   * @param proofRecordId
   * @returns ProofRecord
   */
  @Post('/:proofRecordId/accept-presentation')
  @Example<ProofExchangeRecordProps>(ProofRecordExample)
  public async acceptPresentation(
    @Path('proofRecordId') proofRecordId: string,
    @Res() notFoundError: TsoaResponse<404, { reason: string }>,
    @Res() internalServerError: TsoaResponse<500, { message: string }>
  ) {
    try {
      const proof = await this.agent.proofs.acceptPresentation({ proofRecordId })
      return proof
    } catch (error) {
      if (error instanceof RecordNotFoundError) {
        return notFoundError(404, {
          reason: `proof with proofRecordId "${proofRecordId}" not found.`,
        })
      }
      return internalServerError(500, { message: `something went wrong: ${error}` })
    }
  }
}