import type { PeerDidNumAlgo2CreateOptions, DifPexInputDescriptorToCredentials } from '@credo-ts/core'

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
   * Accept a presentation request as prover, submitting the caller's own credential choice per
   * input descriptor instead of auto-selecting (see acceptRequest above). Ported from the legacy
   * `/multi-tenancy/proofs/accept-request-with-cred/:tenantId` endpoint -- this agent's contract
   * never had an equivalent under `/didcomm/proofs`. Real chosen-credential matching is required
   * since the legacy version only forwarded a bare `credentialRecord`; the currently-installed
   * Credo expects the full `SubmissionEntryCredential` (with `claimFormat`) in its place.
   *
   * @param proofRecordId
   * @param body
   * @returns ProofRecord
   */
  @Post('/:proofRecordId/accept-request-with-cred')
  @Example<DidCommProofExchangeRecordProps>(ProofRecordExample)
  public async acceptRequestWithCred(
    @Request() request: Req,
    @Path('proofRecordId') proofRecordId: string,
    @Body()
    body: {
      comment?: string
      // inputDescriptorId -> the credentialRecordId the caller chose to satisfy it
      proofFormats: { presentationExchange: { credentials: Record<string, string> } }
    },
  ) {
    try {
      const existingProof = await request.agent.modules.didcomm.proofs.getById(proofRecordId)
      this.assertProofState(existingProof, 'accept')

      const availableCredentials = await request.agent.modules.didcomm.proofs.getCredentialsForRequest({
        proofExchangeRecordId: proofRecordId,
      })

      // This endpoint only supports the presentationExchange proof format -- the legacy version
      // this was ported from made the same assumption implicitly (it never checked), which threw
      // an opaque "No attachment found for service presentationExchange" CredoError (mapped to a
      // raw 500) for an indy/anoncreds-negotiated proof record instead of a clear rejection. See
      // the #85 review.
      const pexResult = availableCredentials.proofFormats.presentationExchange
      if (!pexResult) {
        throw new BadRequestError(
          'This proof record was not negotiated using the presentationExchange format; accept-request-with-cred only supports presentationExchange.',
        )
      }

      const chosenCredentials: DifPexInputDescriptorToCredentials = {}
      // Two distinct failure kinds, kept separate rather than folded into one untyped list --
      // an invalid choice is always a real error (stale id/typo), while an unsatisfied requirement
      // may be legitimate up until the needsCount check (another alternative could have covered
      // it). Joined into one message below since the response contract here is a single string,
      // but kept distinguishable in code for any future caller that wants to render them
      // differently. See the #85 review.
      const invalidCredentialChoices: string[] = []
      const unsatisfiedRequirements: string[] = []
      for (const requirement of pexResult.requirements) {
        // Loop the full submissionEntry array, not just [0] -- a single requirement can
        // legitimately contain multiple submission entries (rule 'all' with 2+ descriptors, or
        // rule 'pick' with needsCount > 1). Indexing [0] silently dropped every entry beyond the
        // first. See the #85 review.
        let matchedCount = 0
        for (const submissionEntry of requirement.submissionEntry) {
          const chosenCredentialId =
            body.proofFormats.presentationExchange.credentials[submissionEntry.inputDescriptorId]
          if (chosenCredentialId === undefined) {
            // Caller didn't choose this descriptor -- may be an unneeded alternative within an
            // 'all'/'pick' group; only flagged below if the requirement ends up under-satisfied.
            continue
          }
          const match = submissionEntry.verifiableCredentials.find(
            (candidate) => candidate.credentialRecord.id === chosenCredentialId,
          )
          if (!match) {
            // A caller-supplied id that matches nothing is always a real error (stale id, typo) --
            // unlike an omitted descriptor, this is never legitimate, so it's reported immediately
            // rather than folded into the needsCount check below. See the #85 review.
            invalidCredentialChoices.push(
              `${submissionEntry.inputDescriptorId} (no credential '${chosenCredentialId}' available)`,
            )
            continue
          }
          chosenCredentials[submissionEntry.inputDescriptorId] = [match]
          matchedCount += 1
        }
        if (matchedCount < requirement.needsCount) {
          unsatisfiedRequirements.push(
            `requirement needing ${requirement.needsCount} credential(s), only ${matchedCount} provided`,
          )
        }
      }
      if (invalidCredentialChoices.length > 0 || unsatisfiedRequirements.length > 0) {
        // Previously, an unmatched/omitted descriptor was silently dropped and the presentation
        // was still submitted -- the verifier would receive a presentation missing a required
        // credential with no error raised anywhere. See the #85 review.
        throw new BadRequestError(
          `Unable to satisfy proof request: ${[...invalidCredentialChoices, ...unsatisfiedRequirements].join('; ')}.`,
        )
      }

      const proof = await request.agent.modules.didcomm.proofs.acceptRequest({
        proofExchangeRecordId: proofRecordId,
        comment: body.comment,
        proofFormats: { presentationExchange: { credentials: chosenCredentials } },
      })

      return proof.toJSON()
    } catch (error) {
      throw ErrorHandlingService.handle(error)
    }
  }

  // Shared by declineRequest/getCredentialsForRequest/acceptRequestWithCred -- all three only ever
  // proceed from RequestReceived, differing solely in the verb used in the resulting message. See
  // the #85 review.
  private assertProofState(record: { state: DidCommProofState }, verb: string): void {
    if (record.state !== DidCommProofState.RequestReceived) {
      throw new BadRequestError(
        `Cannot ${verb} a proof record in state '${record.state}'; expected '${DidCommProofState.RequestReceived}'.`,
      )
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
      this.assertProofState(existingProof, 'decline')

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
      this.assertProofState(existingProof, 'list credentials for')

      const credentials = await request.agent.modules.didcomm.proofs.getCredentialsForRequest({
        proofExchangeRecordId: proofRecordId,
      })

      return credentials
    } catch (error) {
      throw ErrorHandlingService.handle(error)
    }
  }
}
