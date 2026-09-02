import type { PeerDidNumAlgo2CreateOptions } from '@credo-ts/core'

import { W3cCredentialService, createPeerDidDocumentFromServices, PeerDidNumAlgo } from '@credo-ts/core'
import {
  DidCommCredentialExchangeRecordProps,
  CredentialProtocolVersionType,
  DidCommCredentialState,
  DidCommCredentialRole,
  DidCommRouting,
} from '@credo-ts/didcomm'
import { Request as Req } from 'express'
import { Body, Controller, Delete, Get, Path, Post, Route, Tags, Example, Query, Security, Request } from 'tsoa'
import { injectable } from 'tsyringe'

import { SCOPES } from '../../../enums'
import ErrorHandlingService from '../../../errorHandlingService'
import { BadRequestError } from '../../../errors'
import { PurgeRecordType } from '../../../purge/PurgeTypes'
import { SchedulePurge } from '../../../purge/decorators/SchedulePurge'
import { AgentType } from '../../../types'
import { CredentialExchangeRecordExample, RecordId } from '../../examples'
import {
  AcceptCredentialRequestOptions,
  ProposeCredentialOptions,
  AcceptCredentialProposalOptions,
  CredentialOfferOptions,
  CreateOfferOptions,
  AcceptCredential,
  CreateOfferOobOptions,
  ThreadId,
} from '../../types'
import { OutOfBandController } from '../outofband/OutOfBandController'

@Tags('DIDComm - Credentials')
@Security('jwt', [SCOPES.TENANT_AGENT, SCOPES.DEDICATED_AGENT])
@Route('/didcomm/credentials')
@injectable()
export class CredentialController extends Controller {
  private outOfBandController: OutOfBandController

  public constructor(outOfBandController: OutOfBandController) {
    super()
    this.outOfBandController = outOfBandController
  }

  /**
   * Retrieve all credential exchange records
   *
   * @returns CredentialExchangeRecord[]
   */
  @Example<DidCommCredentialExchangeRecordProps[]>([CredentialExchangeRecordExample])
  @Get('/')
  public async getAllCredentials(
    @Request() request: Req,
    @Query('threadId') threadId?: ThreadId,
    @Query('parentThreadId') parentThreadId?: ThreadId,
    @Query('connectionId') connectionId?: RecordId,
    @Query('state') state?: DidCommCredentialState,
    @Query('role') role?: DidCommCredentialRole,
  ) {
    try {
      const credentials = await request.agent.modules.didcomm.credentials.findAllByQuery({
        connectionId,
        threadId,
        state,
        parentThreadId,
        role,
      })

      return credentials.map((c) => c.toJSON())
    } catch (error) {
      throw ErrorHandlingService.handle(error)
    }
  }

  // TODO: Fix W3cCredentialRecordExample from example
  // @Example<W3cCredentialRecordOptions[]>([W3cCredentialRecordExample])
  @Get('/w3c')
  public async getAllW3c(@Request() request: Req) {
    try {
      const w3cCredentialService = await request.agent.dependencyManager.resolve(W3cCredentialService)
      const w3cCredentialRecords = await w3cCredentialService.getAllCredentialRecords(request.agent.context)
      return w3cCredentialRecords
    } catch (error) {
      throw ErrorHandlingService.handle(error)
    }
  }

  // TODO: Fix W3cCredentialRecordExample from example
  // @Example<W3cCredentialRecordOptions[]>([W3cCredentialRecordExample])
  @Get('/w3c/:id')
  public async getW3cById(@Request() request: Req, @Path('id') id: string) {
    try {
      const w3cCredentialService = await request.agent.dependencyManager.resolve(W3cCredentialService)
      const w3cRecord = await w3cCredentialService.getCredentialRecordById(request.agent.context, id)
      return w3cRecord
    } catch (error) {
      throw ErrorHandlingService.handle(error)
    }
  }

  /**
   * Delete a W3C credential record by id. Ported from the legacy
   * `/multi-tenancy/credential/w3c/:credentialRecordId/:tenantId` endpoint -- this agent's
   * contract never had an equivalent under `/didcomm/credentials`.
   *
   * @param id
   */
  @Delete('/w3c/:id')
  public async deleteW3cById(@Request() request: Req, @Path('id') id: string) {
    try {
      // W3cCredentialService.removeCredentialRecord is a bare delete with no reference checks --
      // a DidCommCredentialExchangeRecord for a DIDComm-issued (not self-attested) JSON-LD
      // credential stores { credentialRecordType: 'w3c', credentialRecordId } pointing at exactly
      // this kind of record. Deleting out from under one would orphan its credentialRecordId with
      // no cleanup path. credentialIds is a queryable default tag (derived from that same
      // credentials[] array), so this is a single indexed lookup, not a full scan. See the #85
      // review -- this endpoint is meant for self-attested credentials only; callers are expected
      // to route DIDComm-issued ones through deleteById instead.
      // credentialIds is stored as one flattened per-value tag per array entry (Askar's
      // representation of an array tag), so the query side must match with an array too -- a bare
      // string here would search a different, nonexistent flat tag key and never match anything.
      const referencingExchangeRecords = await request.agent.modules.didcomm.credentials.findAllByQuery({
        credentialIds: [id],
      })
      if (referencingExchangeRecords.length > 0) {
        throw new BadRequestError(
          `Cannot delete W3C credential '${id}' directly -- it is referenced by a DIDComm credential exchange record. Delete via the credential exchange record instead.`,
        )
      }

      this.setStatus(204)
      const w3cCredentialService = await request.agent.dependencyManager.resolve(W3cCredentialService)
      await w3cCredentialService.removeCredentialRecord(request.agent.context, id)
    } catch (error) {
      throw ErrorHandlingService.handle(error)
    }
  }

  /**
   * Retrieve credential exchange record by credential record id
   *
   * @param credentialRecordId
   * @returns CredentialExchangeRecord
   */
  @Example<DidCommCredentialExchangeRecordProps>(CredentialExchangeRecordExample)
  @Get('/:credentialRecordId')
  public async getCredentialById(@Request() request: Req, @Path('credentialRecordId') credentialRecordId: RecordId) {
    try {
      const credential = await request.agent.modules.didcomm.credentials.getById(credentialRecordId)
      return credential.toJSON()
    } catch (error) {
      throw ErrorHandlingService.handle(error)
    }
  }

  /**
   * Delete a credential exchange record (and, by default, its associated stored credential) by
   * id. Ported from the legacy `/multi-tenancy/credential/:credentialRecordId/:tenantId`
   * endpoint -- this agent's contract never had an equivalent under `/didcomm/credentials`.
   *
   * @param credentialRecordId
   */
  @Delete('/:credentialRecordId')
  public async deleteById(@Request() request: Req, @Path('credentialRecordId') credentialRecordId: RecordId) {
    try {
      // 204/no-body, matching this package's other didcomm/* deletes (ConnectionController.
      // deleteConnection, OutOfBandController.deleteOutOfBandRecord) -- previously returned
      // 200 + { message } instead, a shape borrowed from the unrelated openid4vc module. See the
      // #85 review.
      this.setStatus(204)
      await request.agent.modules.didcomm.credentials.deleteById(credentialRecordId)
    } catch (error) {
      throw ErrorHandlingService.handle(error)
    }
  }

  /**
   * Initiate a new credential exchange as holder by sending a propose credential message
   * to the connection with a specified connection id.
   *
   * @param options
   * @returns CredentialExchangeRecord
   */
  @Example<DidCommCredentialExchangeRecordProps>(CredentialExchangeRecordExample)
  @Post('/propose-credential')
  public async proposeCredential(@Request() request: Req, @Body() proposeCredentialOptions: ProposeCredentialOptions) {
    try {
      const credential = await request.agent.modules.didcomm.credentials.proposeCredential(proposeCredentialOptions)
      return credential
    } catch (error) {
      throw ErrorHandlingService.handle(error)
    }
  }

  /**
   * Accept a credential proposal as issuer by sending an accept proposal message
   * to the connection associated with the credential exchange record.
   *
   * @param credentialRecordId credential identifier
   * @param options
   * @returns CredentialExchangeRecord
   */
  @Example<DidCommCredentialExchangeRecordProps>(CredentialExchangeRecordExample)
  @Post('/accept-proposal')
  public async acceptProposal(
    @Request() request: Req,
    @Body() acceptCredentialProposal: AcceptCredentialProposalOptions,
  ) {
    try {
      const credential = await request.agent.modules.didcomm.credentials.acceptProposal(acceptCredentialProposal)

      return credential
    } catch (error) {
      throw ErrorHandlingService.handle(error)
    }
  }

  /**
   * Initiate a new credential exchange as issuer by creating a credential offer
   * without specifying a connection id
   *
   * @param options
   * @returns AgentMessage, CredentialExchangeRecord
   */
  @Example<DidCommCredentialExchangeRecordProps>(CredentialExchangeRecordExample)
  @Post('/create-offer')
  @SchedulePurge(PurgeRecordType.DIDCOMM_CREDENTIAL, (r) => (r as any)?.id)
  public async createOffer(@Request() request: Req, @Body() createOfferOptions: CreateOfferOptions) {
    try {
      const offer = await request.agent.modules.didcomm.credentials.offerCredential(createOfferOptions)
      return offer
    } catch (error) {
      throw ErrorHandlingService.handle(error)
    }
  }

  @Post('/create-offer-oob')
  @SchedulePurge(PurgeRecordType.DIDCOMM_CREDENTIAL, (r) => (r as any)?.credentialExchangeRecordId)
  public async createOfferOob(@Request() request: Req, @Body() outOfBandOption: CreateOfferOobOptions) {
    try {
      let invitationDid: string | undefined
      let routing: DidCommRouting
      await this.ensureLinkSecretExists(request.agent)

      if (outOfBandOption?.invitationDid) {
        invitationDid = outOfBandOption?.invitationDid
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
            keys,
            numAlgo: PeerDidNumAlgo.MultipleInceptionKeyWithoutDoc,
          },
        })
        invitationDid = did.didState.did
      }

      const offerOob = await request.agent.modules.didcomm.credentials.createOffer({
        protocolVersion: outOfBandOption.protocolVersion as CredentialProtocolVersionType<[]>,
        credentialFormats: outOfBandOption.credentialFormats,
        autoAcceptCredential: outOfBandOption.autoAcceptCredential,
        comment: outOfBandOption.comment,
        // parentThreadId is threaded into the offer message + exchange record by the
        // @credo-ts/didcomm patch (patches/@credo-ts+didcomm+0.6.2.patch), covering both this
        // OOB path and the connection-based offerCredential path with a single mechanism.
        parentThreadId: outOfBandOption.parentThreadId,
      })

      const credentialMessage = offerOob.message

      // RFC 0434 requires a message inside `requests~attach` to carry either no parent
      // thread id or one equal to the invitation's `@id` — the holder sets it to the
      // invitation id itself. The patch above put `parentThreadId` on `~thread.pthid`,
      // which every conformant holder rejects on receipt ("...contains parent thread id X
      // that does not match the invitation id Y"), silently discarding the offer while the
      // connection still completes. Correlation stays on the exchange record (also set by
      // the patch), so re-thread the attached message with the thread id only.
      if (outOfBandOption.parentThreadId) {
        credentialMessage.setThread({ threadId: offerOob.credentialExchangeRecord.threadId })
      }

      const outOfBandRecord = await request.agent.modules.didcomm.oob.createInvitation({
        label: outOfBandOption.label,
        messages: [credentialMessage],
        autoAcceptConnection: true,
        imageUrl: outOfBandOption?.imageUrl,
        goalCode: outOfBandOption?.goalCode,
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
        outOfBandRecordId: outOfBandRecord.id,
        credentialExchangeRecordId: offerOob.credentialExchangeRecord.id,
        credentialRequestThId: offerOob.credentialExchangeRecord.threadId,
        credentialRequestParentThId: offerOob.credentialExchangeRecord.parentThreadId,
        invitationDid,
      }
    } catch (error) {
      throw ErrorHandlingService.handle(error)
    }
  }

  /**
   * Accept a credential offer as holder by sending an accept offer message
   * to the connection associated with the credential exchange record.
   *
   * @param credentialRecordId credential identifier
   * @param options
   * @returns CredentialExchangeRecord
   */
  @Example<DidCommCredentialExchangeRecordProps>(CredentialExchangeRecordExample)
  @Post('/accept-offer')
  public async acceptOffer(@Request() request: Req, @Body() acceptCredentialOfferOptions: CredentialOfferOptions) {
    try {
      await this.ensureLinkSecretExists(request.agent)
      const acceptOffer = await request.agent.modules.didcomm.credentials.acceptOffer(acceptCredentialOfferOptions)
      return acceptOffer
    } catch (error) {
      throw ErrorHandlingService.handle(error)
    }
  }

  /**
   * Accept a credential request as issuer by sending an accept request message
   * to the connection associated with the credential exchange record.
   *
   * @param credentialRecordId credential identifier
   * @param options
   * @returns CredentialExchangeRecord
   */
  @Example<DidCommCredentialExchangeRecordProps>(CredentialExchangeRecordExample)
  @Post('/accept-request')
  public async acceptRequest(
    @Request() request: Req,
    @Body() acceptCredentialRequestOptions: AcceptCredentialRequestOptions,
  ) {
    try {
      const credential = await request.agent.modules.didcomm.credentials.acceptRequest(acceptCredentialRequestOptions)
      return credential
    } catch (error) {
      throw ErrorHandlingService.handle(error)
    }
  }

  /**
   * Accept a credential as holder by sending an accept credential message
   * to the connection associated with the credential exchange record.
   *
   * @param options
   * @returns CredentialExchangeRecord
   */
  @Example<DidCommCredentialExchangeRecordProps>(CredentialExchangeRecordExample)
  @Post('/accept-credential')
  public async acceptCredential(@Request() request: Req, @Body() acceptCredential: AcceptCredential) {
    try {
      const credential = await request.agent.modules.didcomm.credentials.acceptCredential(acceptCredential)
      return credential
    } catch (error) {
      throw ErrorHandlingService.handle(error)
    }
  }

  /**
   * Return credentialRecord
   *
   * @param credentialRecordId
   * @returns credentialRecord
   */
  @Get('/:credentialRecordId/form-data')
  public async credentialFormData(@Request() request: Req, @Path('credentialRecordId') credentialRecordId: string) {
    try {
      const credentialDetails = await request.agent.modules.didcomm.credentials.getFormatData(credentialRecordId)
      return credentialDetails
    } catch (error) {
      throw ErrorHandlingService.handle(error)
    }
  }

  private async ensureLinkSecretExists(agent: AgentType): Promise<void> {
    const linkSecretIds = await agent.modules.anoncreds.getLinkSecretIds()
    if (linkSecretIds.length === 0) {
      await agent.modules.anoncreds.createLinkSecret()
    }
  }
}
