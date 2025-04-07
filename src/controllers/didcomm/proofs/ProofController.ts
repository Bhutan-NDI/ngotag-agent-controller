import type {
  AcceptProofRequestOptions,
  DeclineProofRequestOptions,
  PeerDidNumAlgo2CreateOptions,
  ProofExchangeRecordProps,
  ProofsProtocolVersionType,
  Routing,
} from '@credo-ts/core'

import { PeerDidNumAlgo, createPeerDidDocumentFromServices } from '@credo-ts/core'
import { Request as Req } from 'express'
import { Body, Controller, Example, Get, Path, Post, Query, Route, Tags, Security, Request } from 'tsoa'
import { injectable } from 'tsyringe'

import { SCOPES } from '../../../enums'
import ErrorHandlingService from '../../../errorHandlingService'
import { ProofRecordExample, RecordId } from '../../examples'
import {
  AcceptProofProposal,
  CreateProofRequestOobOptions,
  RequestProofOptions,
  RequestProofProposalOptions,
} from '../../types'

@Tags('DIDComm - Proofs')
@Route('/didcomm/proofs')
@Security('jwt', [SCOPES.TENANT_AGENT, SCOPES.DEDICATED_AGENT])
@injectable()
export class ProofController extends Controller {
  /**
   * Retrieve all proof records
   *
   * @param threadId
   * @returns ProofRecord[]
   */
  @Example<ProofExchangeRecordProps[]>([ProofRecordExample])
  @Get('/')
  public async getAllProofs(@Request() request: Req, @Query('threadId') threadId?: string) {
    try {
      const query = threadId ? { threadId } : {}
      const proofs = await request.agent.proofs.findAllByQuery(query)

      return proofs.map((proof) => proof.toJSON())
    } catch (error) {
      throw ErrorHandlingService.handle(error)
    }
  }

  /**
   * Retrieve proof record by proof record id
   *
   * @param proofRecordId
   * @returns ProofRecord
   */
  @Get('/:proofRecordId')
  @Example<ProofExchangeRecordProps>(ProofRecordExample)
  public async getProofById(@Request() request: Req, @Path('proofRecordId') proofRecordId: RecordId) {
    try {
      const proof = await request.agent.proofs.getById(proofRecordId)

      return proof.toJSON()
    } catch (error) {
      throw ErrorHandlingService.handle(error)
    }
  }

  /**
   * Initiate a new presentation exchange as prover by sending a presentation proposal request
   * to the connection with the specified connection id.
   *
   * @param proposal
   * @returns ProofRecord
   */
  @Post('/propose-proof')
  @Example<ProofExchangeRecordProps>(ProofRecordExample)
  public async proposeProof(@Request() request: Req, @Body() requestProofProposalOptions: RequestProofProposalOptions) {
    try {
      const proof = await request.agent.proofs.proposeProof({
        connectionId: requestProofProposalOptions.connectionId,
        protocolVersion: 'v1' as ProofsProtocolVersionType<[]>,
        proofFormats: requestProofProposalOptions.proofFormats,
        comment: requestProofProposalOptions.comment,
        autoAcceptProof: requestProofProposalOptions.autoAcceptProof,
        goalCode: requestProofProposalOptions.goalCode,
        parentThreadId: requestProofProposalOptions.parentThreadId,
      })

      return proof
    } catch (error) {
      throw ErrorHandlingService.handle(error)
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
  public async acceptProposal(@Request() request: Req, @Body() acceptProposal: AcceptProofProposal) {
    try {
      const proof = await request.agent.proofs.acceptProposal(acceptProposal)

      return proof
    } catch (error) {
      throw ErrorHandlingService.handle(error)
    }
  }

  /**
   * Creates a presentation request bound to existing connection
   */
  @Post('/request-proof')
  @Example<ProofExchangeRecordProps>(ProofRecordExample)
  public async requestProof(@Request() request: Req, @Body() requestProofOptions: RequestProofOptions) {
    try {
      const requestProofPayload = {
        connectionId: requestProofOptions.connectionId,
        protocolVersion: requestProofOptions.protocolVersion as ProofsProtocolVersionType<[]>,
        comment: requestProofOptions.comment,
        proofFormats: requestProofOptions.proofFormats,
        autoAcceptProof: requestProofOptions.autoAcceptProof,
        goalCode: requestProofOptions.goalCode,
        parentThreadId: requestProofOptions.parentThreadId,
        willConfirm: requestProofOptions.willConfirm,
      }
      const proof = await request.agent.proofs.requestProof(requestProofPayload)

      return proof
    } catch (error) {
      throw ErrorHandlingService.handle(error)
    }
  }

  /**
   * Creates a presentation request not bound to any proposal or existing connection
   */
  @Post('create-request-oob')
  @Example<ProofExchangeRecordProps>(ProofRecordExample)
  public async createRequest(@Request() request: Req, @Body() createRequestOptions: CreateProofRequestOobOptions) {
    try {
      let routing: Routing
      let invitationDid: string | undefined

      if (createRequestOptions?.invitationDid) {
        invitationDid = createRequestOptions?.invitationDid
      } else {
        routing = await request.agent.mediationRecipient.getRouting({})
        const didDocument = createPeerDidDocumentFromServices([
          {
            id: 'didcomm',
            recipientKeys: [routing.recipientKey],
            routingKeys: routing.routingKeys,
            serviceEndpoint: routing.endpoints[0],
          },
        ])
        const did = await request.agent.dids.create<PeerDidNumAlgo2CreateOptions>({
          didDocument,
          method: 'peer',
          options: {
            numAlgo: PeerDidNumAlgo.MultipleInceptionKeyWithoutDoc,
          },
        })
        invitationDid = did.didState.did
      }

      const proof = await request.agent.proofs.createRequest({
        protocolVersion: createRequestOptions.protocolVersion as ProofsProtocolVersionType<[]>,
        proofFormats: createRequestOptions.proofFormats,
        goalCode: createRequestOptions.goalCode,
        willConfirm: createRequestOptions.willConfirm,
        parentThreadId: createRequestOptions.parentThreadId,
        autoAcceptProof: createRequestOptions.autoAcceptProof,
        comment: createRequestOptions.comment,
      })
      const proofMessage = proof.message
      const outOfBandRecord = await request.agent.oob.createInvitation({
        label: createRequestOptions.label,
        messages: [proofMessage],
        autoAcceptConnection: true,
        imageUrl: createRequestOptions?.imageUrl,
        goalCode: createRequestOptions?.goalCode,
        invitationDid,
      })

      return {
        invitationUrl: outOfBandRecord.outOfBandInvitation.toUrl({
          domain: request.agent.config.endpoints[0],
        }),
        invitation: outOfBandRecord.outOfBandInvitation.toJSON({
          useDidSovPrefixWhereAllowed: request.agent.config.useDidSovPrefixWhereAllowed,
        }),
        outOfBandRecord: outOfBandRecord.toJSON(),
        invitationDid: createRequestOptions?.invitationDid ? '' : invitationDid,
        proofRecordThId: proof.proofRecord.threadId,
        proofMessageId: proof.message.thread?.threadId || proof.message.threadId || proof.message.id,
      }
    } catch (error) {
      throw ErrorHandlingService.handle(error)
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
    @Request() request: Req,
    @Path('proofRecordId') proofRecordId: string,
    @Body()
    body: {
      filterByPresentationPreview?: boolean
      filterByNonRevocationRequirements?: boolean
      comment?: string
    },
  ) {
    try {
      const requestedCredentials = await request.agent.proofs.selectCredentialsForRequest({
        proofRecordId,
      })

      const acceptProofRequest: AcceptProofRequestOptions = {
        proofRecordId,
        comment: body.comment,
        proofFormats: requestedCredentials.proofFormats,
      }

      const proof = await request.agent.proofs.acceptRequest(acceptProofRequest)

      return proof.toJSON()
    } catch (error) {
      throw ErrorHandlingService.handle(error)
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
  public async acceptPresentation(@Request() request: Req, @Path('proofRecordId') proofRecordId: string) {
    try {
      const proof = await request.agent.proofs.acceptPresentation({ proofRecordId })
      return proof
    } catch (error) {
      throw ErrorHandlingService.handle(error)
    }
  }

  /**
   * Return proofRecord
   *
   * @param proofRecordId
   * @returns ProofRecord
   */
  @Get('/:proofRecordId/form-data')
  @Example<ProofExchangeRecordProps>(ProofRecordExample)
  // TODO: Add return type
  public async proofFormData(@Request() request: Req, @Path('proofRecordId') proofRecordId: string) {
    try {
      const proof = await request.agent.proofs.getFormatData(proofRecordId)
      return proof
    } catch (error) {
      throw ErrorHandlingService.handle(error)
    }
  }

  @Get('/credentialsForRequest/:proofRecordId')
  public async getCredentialsForRequest(
    @Request() request: Req,
    @Path('proofRecordId') proofRecordId: RecordId
  ) {
    try {
      const credentials = await request.agent.proofs.getCredentialsForRequest({ proofRecordId })
      return credentials
    } catch (error) {
      throw ErrorHandlingService.handle(error)
    }
  }

  @Post('/proofs/accept-request-with-cred')
  @Example<ProofExchangeRecordProps>(ProofRecordExample)
  public async acceptRequestWithProofFormatInput(
    @Request() request: Req,
    @Body()
    acceptRequestWithProofFormatInput: {
      proofRecordId: string
      comment?: string
      proofFormats: {
        presentationExchange: {
          credentials: Record<string, string>
        }
      }
    }
  ) {
    let proofRecord
    try {
      const getCredentials = await request.agent.proofs.getCredentialsForRequest({
        proofRecordId: acceptRequestWithProofFormatInput.proofRecordId,
      })

      const proofFormats: {
        presentationExchange: {
          credentials: Record<string, any>
        }
      } = {
        presentationExchange: {
          credentials: {},
        },
      }

      getCredentials.proofFormats.presentationExchange?.requirements.forEach((requirement) => {
        proofFormats.presentationExchange.credentials[`${requirement.submissionEntry[0].inputDescriptorId}`] = [
          // requirement.submissionEntry[0].verifiableCredentials[
          //   acceptRequestWithProofFormatInput.proofFormats.presentationExchange.credentials[
          //     `${requirement.submissionEntry[0].inputDescriptorId}`
          //   ]
          // ].credentialRecord,
          requirement.submissionEntry[0].verifiableCredentials.find(
            (credentials) =>
              credentials.credentialRecord.id ===
              acceptRequestWithProofFormatInput.proofFormats.presentationExchange.credentials[
                `${requirement.submissionEntry[0].inputDescriptorId}`
              ]
          )?.credentialRecord,
        ]
      })

      const acceptProofRequest = {
        proofRecordId: acceptRequestWithProofFormatInput.proofRecordId,
        comment: acceptRequestWithProofFormatInput.comment,
        proofFormats: proofFormats,
      }
      const proof = await request.agent.proofs.acceptRequest(acceptProofRequest)

      proofRecord = proof.toJSON()
      
      return proofRecord
    } catch (error) {
      throw ErrorHandlingService.handle(error)
    }
  }

  @Post('/proofs/:proofRecordId/decline-request')
  @Example<ProofExchangeRecordProps>(ProofRecordExample)
  public async declineRequest(
    @Request() request: Req,
    @Path('proofRecordId') proofRecordId: string,
    @Body()
    req: //TODO type for request
    {
      sendProblemReport?: boolean
      problemReportDescription?: string
    }
  ) {
    let proofRecord
    try {
      const declineProofRequestOptions: DeclineProofRequestOptions = {
        proofRecordId,
        sendProblemReport: req.sendProblemReport,
        problemReportDescription: req.problemReportDescription,
      }
      const proof = await request.agent.proofs.declineRequest(declineProofRequestOptions)
      proofRecord = proof.toJSON()
      return proofRecord
    } catch (error) {
      throw ErrorHandlingService.handle(error)
    }
  }
}
