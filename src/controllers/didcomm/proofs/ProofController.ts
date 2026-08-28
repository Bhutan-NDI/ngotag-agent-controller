import type { PeerDidNumAlgo2CreateOptions } from '@credo-ts/core'

import { PeerDidNumAlgo, createPeerDidDocumentFromServices } from '@credo-ts/core'
import {
  AcceptProofRequestOptions,
  DidCommProofExchangeRecordProps,
  DidCommProofState,
  ProofsProtocolVersionType,
  DidCommRouting,
} from '@credo-ts/didcomm'
import { Request as Req } from 'express'
import { Body, Controller, Example, Get, Path, Post, Query, Route, Tags, Security, Request } from 'tsoa'
import { injectable } from 'tsyringe'

import { SCOPES } from '../../../enums'
import ErrorHandlingService from '../../../errorHandlingService'
import { BadRequestError } from '../../../errors'
import { PurgeRecordType } from '../../../purge/PurgeTypes'
import { SchedulePurge } from '../../../purge/decorators/SchedulePurge'
import { ProofRecordExample, RecordId } from '../../examples'
import {
  AcceptProofProposal,
  CreateProofRequestOobOptions,
  RequestProofOptions,
  RequestProofProposalOptions,
} from '../../types'

// A human-readable DIDComm problem-report reason has no business being large -- the field
// otherwise accepts an unbounded string (up to the application-wide 5 MB body limit) that gets
// encrypted, stored, and delivered to the verifier's agent. 500 is generous for a real
// explanation, far below anything that could be mistaken for a payload.
const MAX_PROBLEM_REPORT_DESCRIPTION_LENGTH = 500

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
  @Example<DidCommProofExchangeRecordProps[]>([ProofRecordExample])
  @Get('/')
  public async getAllProofs(@Request() request: Req, @Query('threadId') threadId?: string) {
    try {
      const query = threadId ? { threadId } : {}
      const proofs = await request.agent.modules.didcomm.proofs.findAllByQuery(query)

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
  @Example<DidCommProofExchangeRecordProps>(ProofRecordExample)
  public async getProofById(@Request() request: Req, @Path('proofRecordId') proofRecordId: RecordId) {
    try {
      const proof = await request.agent.modules.didcomm.proofs.getById(proofRecordId)

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
  @Example<DidCommProofExchangeRecordProps>(ProofRecordExample)
  public async proposeProof(@Request() request: Req, @Body() requestProofProposalOptions: RequestProofProposalOptions) {
    try {
      const proof = await request.agent.modules.didcomm.proofs.proposeProof({
        connectionId: requestProofProposalOptions.connectionId,
        protocolVersion: requestProofProposalOptions.protocolVersion as ProofsProtocolVersionType<[]>,
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
  @Post('/accept-proposal')
  @Example<DidCommProofExchangeRecordProps>(ProofRecordExample)
  public async acceptProposal(@Request() request: Req, @Body() acceptProposal: AcceptProofProposal) {
    try {
      const proof = await request.agent.modules.didcomm.proofs.acceptProposal(acceptProposal)

      return proof
    } catch (error) {
      throw ErrorHandlingService.handle(error)
    }
  }

  /**
   * Creates a presentation request bound to existing connection
   */
  @Post('/request-proof')
  @Example<DidCommProofExchangeRecordProps>(ProofRecordExample)
  @SchedulePurge(PurgeRecordType.DIDCOMM_PROOF, (r) => (r as any)?.id)
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
      const proof = await request.agent.modules.didcomm.proofs.requestProof(requestProofPayload)

      return proof
    } catch (error) {
      throw ErrorHandlingService.handle(error)
    }
  }

  /**
   * Creates a presentation request not bound to any proposal or existing connection
   */
  @Post('create-request-oob')
  @Example<DidCommProofExchangeRecordProps>(ProofRecordExample)
  @SchedulePurge(PurgeRecordType.DIDCOMM_PROOF, (r) => (r as any)?.proofRecordId)
  public async createRequest(@Request() request: Req, @Body() createRequestOptions: CreateProofRequestOobOptions) {
    try {
      let routing: DidCommRouting
      let invitationDid: string | undefined

      if (createRequestOptions?.invitationDid) {
        invitationDid = createRequestOptions?.invitationDid
      } else {
        routing = await request.agent.modules.didcomm.mediationRecipient.getRouting({})
        const { didDocument, keys } = createPeerDidDocumentFromServices(
          [
            {
              id: 'didcomm',
              recipientKeys: [routing.recipientKey],
              routingKeys: routing.routingKeys,
              serviceEndpoint: routing.endpoints[0],
            },
          ],
          true,
        )
        const did = await request.agent.dids.create<PeerDidNumAlgo2CreateOptions>({
          didDocument,
          method: 'peer',
          options: {
            numAlgo: PeerDidNumAlgo.MultipleInceptionKeyWithoutDoc,
            keys,
          },
        })
        invitationDid = did.didState.did
      }

      const proof = await request.agent.modules.didcomm.proofs.createRequest({
        protocolVersion: createRequestOptions.protocolVersion as ProofsProtocolVersionType<[]>,
        proofFormats: createRequestOptions.proofFormats,
        goalCode: createRequestOptions.goalCode,
        willConfirm: createRequestOptions.willConfirm,
        parentThreadId: createRequestOptions.parentThreadId,
        autoAcceptProof: createRequestOptions.autoAcceptProof,
        comment: createRequestOptions.comment,
      })
      const proofMessage = proof.message
      const outOfBandRecord = await request.agent.modules.didcomm.oob.createInvitation({
        label: createRequestOptions.label,
        messages: [proofMessage],
        autoAcceptConnection: true,
        imageUrl: createRequestOptions?.imageUrl,
        goalCode: createRequestOptions?.goalCode,
        invitationDid,
      })

      return {
        invitationUrl: outOfBandRecord.outOfBandInvitation.toUrl({
          domain: request.agent.modules.didcomm.config.endpoints[0],
        }),
        invitation: outOfBandRecord.outOfBandInvitation.toJSON({
          useDidSovPrefixWhereAllowed: request.agent.modules.didcomm.config.useDidSovPrefixWhereAllowed,
        }),
        outOfBandRecord: outOfBandRecord.toJSON(),
        invitationDid,
        proofRecordId: proof.proofRecord.id,
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
  @Example<DidCommProofExchangeRecordProps>(ProofRecordExample)
  public async acceptRequest(
    @Request() request: Req,
    @Path('proofRecordId') proofRecordId: string,
    @Body()
    body: {
      // TODO: Check if we can remove the below body options as they are not used
      filterByPresentationPreview?: boolean
      filterByNonRevocationRequirements?: boolean
      comment?: string
    },
  ) {
    try {
      const requestedCredentials = await request.agent.modules.didcomm.proofs.selectCredentialsForRequest({
        proofExchangeRecordId: proofRecordId,
      })

      const acceptProofRequest: AcceptProofRequestOptions = {
        proofExchangeRecordId: proofRecordId,
        comment: body.comment,
        proofFormats: requestedCredentials.proofFormats,
      }

      const proof = await request.agent.modules.didcomm.proofs.acceptRequest(acceptProofRequest)

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
  @Example<DidCommProofExchangeRecordProps>(ProofRecordExample)
  public async acceptPresentation(@Request() request: Req, @Path('proofRecordId') proofRecordId: string) {
    try {
      const proof = await request.agent.modules.didcomm.proofs.acceptPresentation({
        proofExchangeRecordId: proofRecordId,
      })
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
  @Example<DidCommProofExchangeRecordProps>(ProofRecordExample)
  // TODO: Add return type
  public async proofFormData(@Request() request: Req, @Path('proofRecordId') proofRecordId: string) {
    try {
      const proof = await request.agent.modules.didcomm.proofs.getFormatData(proofRecordId)
      return proof
    } catch (error) {
      throw ErrorHandlingService.handle(error)
    }
  }

  /**
   * Decline a received presentation request as prover, optionally sending a problem-report
   * message to the verifier associated with the proof record.
   *
   * @param proofRecordId
   * @param body
   * @returns ProofRecord
   */
  @Post('/:proofRecordId/decline-request')
  @Example<DidCommProofExchangeRecordProps>(ProofRecordExample)
  public async declineRequest(
    @Request() request: Req,
    @Path('proofRecordId') proofRecordId: string,
    @Body() body: { sendProblemReport?: boolean; problemReportDescription?: string },
  ) {
    try {
      // Trimmed, and checked with a length comparison rather than truthiness -- a bare truthiness
      // check would let an empty string ("") through unvalidated and defeat Credo's own
      // `?? 'Request declined'` default (`??` only fires on null/undefined, not ""), sending the
      // verifier a reasonless problem report instead of the intended default text.
      const problemReportDescription = body.problemReportDescription?.trim()
      if (problemReportDescription && problemReportDescription.length > MAX_PROBLEM_REPORT_DESCRIPTION_LENGTH) {
        throw new BadRequestError(
          `problemReportDescription must be at most ${MAX_PROBLEM_REPORT_DESCRIPTION_LENGTH} characters.`,
        )
      }

      // Pre-check state before calling Credo's declineRequest: Credo's own assertState throws a
      // plain CredoError for a repeat/late decline (already declined, or the record has moved
      // past request-received), which ErrorHandlingService maps to a raw 500 -- a client that
      // retries after a lost response, or double-taps Decline, can't tell "nothing to do" from a
      // genuine failure. This only maps the state-mismatch case to a sensible response; it does
      // not close the underlying race between two concurrent callers.
      const existingProof = await request.agent.modules.didcomm.proofs.getById(proofRecordId)
      if (existingProof.state === DidCommProofState.Declined) {
        // Idempotent: the record is already in the terminal state this call is trying to reach.
        return existingProof.toJSON()
      }
      if (existingProof.state !== DidCommProofState.RequestReceived) {
        throw new BadRequestError(
          `Cannot decline a proof record in state '${existingProof.state}'; expected '${DidCommProofState.RequestReceived}'.`,
        )
      }

      const proof = await request.agent.modules.didcomm.proofs.declineRequest({
        proofExchangeRecordId: proofRecordId,
        sendProblemReport: body.sendProblemReport,
        problemReportDescription: problemReportDescription || undefined,
      })

      return proof.toJSON()
    } catch (error) {
      throw ErrorHandlingService.handle(error)
    }
  }

  /**
   * Retrieve the credentials that satisfy a received presentation request, without selecting or
   * accepting any of them — lets the holder choose among multiple matching credentials before
   * accepting. acceptRequest (above) already auto-selects via selectCredentialsForRequest; this is
   * the corresponding "let the caller choose first" read path.
   *
   * @param proofRecordId
   * @returns the credentials satisfying each requested attribute/predicate
   */
  @Get('/:proofRecordId/credentials-for-request')
  public async getCredentialsForRequest(@Request() request: Req, @Path('proofRecordId') proofRecordId: string) {
    try {
      // Pre-check state for the same reason declineRequest does above: DidCommProofV2Protocol's
      // getCredentialsForRequest asserts protocol version and state (request-received only)
      // itself and throws a plain CredoError otherwise, which ErrorHandlingService maps to a raw
      // 500 -- including immediately after a successful decline, on a verifier-side record, or on
      // a v1 record reached via this v2-only path.
      const existingProof = await request.agent.modules.didcomm.proofs.getById(proofRecordId)
      if (existingProof.state !== DidCommProofState.RequestReceived) {
        throw new BadRequestError(
          `Cannot list credentials for a proof record in state '${existingProof.state}'; expected '${DidCommProofState.RequestReceived}'.`,
        )
      }

      const credentials = await request.agent.modules.didcomm.proofs.getCredentialsForRequest({
        proofExchangeRecordId: proofRecordId,
      })

      return credentials
    } catch (error) {
      throw ErrorHandlingService.handle(error)
    }
  }
}
