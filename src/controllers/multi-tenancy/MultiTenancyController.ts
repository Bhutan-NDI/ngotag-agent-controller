import type { RestAgentModules, RestMultiTenantAgentModules } from '../../cliAgent'
import type { Version } from '../examples'
import type { RecipientKeyOption, SchemaMetadata } from '../types'
import type { PolygonDidCreateOptions } from '@ayanworks/credo-polygon-w3c-module/build/dids'
import type {
  AcceptProofRequestOptions,
  ConnectionRecordProps,
  CreateOutOfBandInvitationConfig,
  CredentialProtocolVersionType,
  KeyDidCreateOptions,
  OutOfBandRecord,
  PeerDidNumAlgo2CreateOptions,
  ProofExchangeRecordProps,
  ProofsProtocolVersionType,
  Routing,
} from '@credo-ts/core'
import type { IndyVdrDidCreateOptions, IndyVdrDidCreateResult } from '@credo-ts/indy-vdr'
import type { QuestionAnswerRecord, ValidResponse } from '@credo-ts/question-answer'
import type { TenantRecord } from '@credo-ts/tenants'
import type { TenantAgent } from '@credo-ts/tenants/build/TenantAgent'

import {
  getUnqualifiedSchemaId,
  getUnqualifiedCredentialDefinitionId,
  parseIndyCredentialDefinitionId,
  parseIndySchemaId,
  AnonCredsError,
} from '@credo-ts/anoncreds'
import {
  AcceptCredentialOfferOptions,
  Agent,
  CredoError,
  ConnectionRepository,
  CredentialRepository,
  CredentialState,
  DidDocumentBuilder,
  DidExchangeState,
  JsonTransformer,
  Key,
  KeyType,
  OutOfBandInvitation,
  RecordNotFoundError,
  TypedArrayEncoder,
  getBls12381G2Key2020,
  getEd25519VerificationKey2018,
  injectable,
  createPeerDidDocumentFromServices,
  PeerDidNumAlgo,
} from '@credo-ts/core'
import { QuestionAnswerRole, QuestionAnswerState } from '@credo-ts/question-answer'
import axios from 'axios'
import * as fs from 'fs'

import { CredentialEnum, DidMethod, Network, Role } from '../../enums/enum'
import { BCOVRIN_REGISTER_URL, INDICIO_NYM_URL } from '../../utils/util'
import { SchemaId, CredentialDefinitionId, RecordId, ProofRecordExample, ConnectionRecordExample } from '../examples'
import {
  RequestProofOptions,
  CreateOfferOptions,
  CreateTenantOptions,
  DidCreate,
  DidNymTransaction,
  EndorserTransaction,
  ReceiveInvitationByUrlProps,
  ReceiveInvitationProps,
  WriteTransaction,
  CreateProofRequestOobOptions,
  CreateOfferOobOptions,
} from '../types'

import {
  Body,
  Controller,
  Delete,
  Get,
  Post,
  Query,
  Res,
  Route,
  Tags,
  TsoaResponse,
  Path,
  Example,
  Security,
} from 'tsoa'

@Tags('MultiTenancy')
@Route('/multi-tenancy')
@injectable()
export class MultiTenancyController extends Controller {
  private readonly agent: Agent<RestMultiTenantAgentModules>

  public constructor(agent: Agent<RestMultiTenantAgentModules>) {
    super()
    this.agent = agent
  }

  //create wallet
  @Security('apiKey')
  @Post('/create-tenant')
  public async createTenant(
    @Body() createTenantOptions: CreateTenantOptions,
    @Res() notFoundError: TsoaResponse<404, { reason: string }>,
    @Res() internalServerError: TsoaResponse<500, { message: string }>
  ) {
    const { config } = createTenantOptions
    try {
      const tenantRecord: TenantRecord = await this.agent.modules.tenants.createTenant({ config })
      return tenantRecord
    } catch (error) {
      if (error instanceof RecordNotFoundError) {
        return notFoundError(404, {
          reason: `Tenant not created`,
        })
      }

      return internalServerError(500, { message: `Something went wrong: ${error}` })
    }
  }

  @Security('apiKey')
  @Post('/create-did/:tenantId')
  public async createDid(
    @Body() createDidOptions: DidCreate,
    @Path('tenantId') tenantId: string,
    @Res() notFoundError: TsoaResponse<404, { reason: string }>,
    @Res() internalServerError: TsoaResponse<500, { message: string }>
  ) {
    let didRes
    try {
      if (!createDidOptions.method) {
        throw Error('Method is required')
      }

      let result
      switch (createDidOptions.method) {
        case DidMethod.Indy:
          result = await this.handleIndy(createDidOptions, tenantId)
          break

        case DidMethod.Key:
          result = await this.handleKey(createDidOptions, tenantId)
          break

        case DidMethod.Web:
          result = await this.handleWeb(createDidOptions, tenantId)
          break

        case DidMethod.Polygon:
          result = await this.handlePolygon(createDidOptions, tenantId)
          break

        case DidMethod.Peer:
          result = await this.handleDidPeer(createDidOptions, tenantId)
          break

        default:
          return internalServerError(500, { message: `Invalid method: ${createDidOptions.method}` })
      }

      didRes = { ...result }

      return didRes
    } catch (error) {
      if (error instanceof RecordNotFoundError) {
        return notFoundError(404, {
          reason: `Did not created`,
        })
      }

      return internalServerError(500, { message: `Something went wrong: ${error}` })
    }
  }

  private async handleIndy(createDidOptions: DidCreate, tenantId: string) {
    let result
    await this.agent.modules.tenants.withTenantAgent({ tenantId }, async (tenantAgent) => {
      if (!createDidOptions.keyType) {
        throw Error('keyType is required')
      }

      if (!createDidOptions.seed) {
        throw Error('Seed is required')
      }

      if (!createDidOptions.network) {
        throw Error('For indy method network is required')
      }

      if (createDidOptions.keyType !== KeyType.Ed25519) {
        throw Error('Only ed25519 key type supported')
      }

      if (!Network.Bcovrin_Testnet && !Network.Indicio_Demonet && !Network.Indicio_Testnet) {
        throw Error(`Invalid network for 'indy' method: ${createDidOptions.network}`)
      }
      switch (createDidOptions?.network?.toLowerCase()) {
        case Network.Bcovrin_Testnet:
          result = await this.handleBcovrin(
            createDidOptions,
            tenantAgent,
            `did:${createDidOptions.method}:${createDidOptions.network}`
          )
          break

        case Network.Indicio_Demonet:
        case Network.Indicio_Testnet:
          result = await this.handleIndicio(
            createDidOptions,
            tenantAgent,
            `did:${createDidOptions.method}:${createDidOptions.network}`
          )
          break

        default:
          throw new Error(`Invalid network for 'indy' method: ${createDidOptions.network}`)
      }
    })
    return result
  }

  private async handleBcovrin(
    createDidOptions: DidCreate,
    tenantAgent: TenantAgent<RestAgentModules>,
    didMethod: string
  ) {
    let didDocument
    if (!createDidOptions.seed) {
      throw Error('Seed is required')
    }
    if (createDidOptions.did) {
      await this.importDid(didMethod, createDidOptions.did, createDidOptions.seed, tenantAgent)
      const getDid = await tenantAgent.dids.getCreatedDids({
        method: createDidOptions.method,
        did: `did:${createDidOptions.method}:${createDidOptions.network}:${createDidOptions.did}`,
      })
      if (getDid.length > 0) {
        didDocument = getDid[0].didDocument
      }
      return {
        did: `${didMethod}:${createDidOptions.did}`,
        didDocument: didDocument,
      }
    } else {
      if (createDidOptions?.role?.toLowerCase() === Role.Endorser) {
        await tenantAgent.wallet.createKey({
          privateKey: TypedArrayEncoder.fromString(createDidOptions.seed),
          keyType: KeyType.Ed25519,
        })

        const body = {
          role: 'ENDORSER',
          alias: 'Alias',
          seed: createDidOptions.seed,
        }

        const res = await axios.post(BCOVRIN_REGISTER_URL, body)
        if (res) {
          const { did } = res?.data || {}
          await this.importDid(didMethod, did, createDidOptions.seed, tenantAgent)
          const didRecord = await tenantAgent.dids.getCreatedDids({
            method: DidMethod.Indy,
            did: `did:${DidMethod.Indy}:${Network.Bcovrin_Testnet}:${res.data.did}`,
          })

          if (didRecord.length > 0) {
            didDocument = didRecord[0].didDocument
          }

          return {
            did: `${didMethod}:${res.data.did}`,
            didDocument: didDocument,
          }
        }
      } else {
        if (!createDidOptions.endorserDid) {
          throw Error('endorserDid or role is required')
        }

        const didCreateTxResult = (await this.agent.dids.create<IndyVdrDidCreateOptions>({
          method: DidMethod.Indy,
          options: {
            endorserMode: 'external',
            endorserDid: createDidOptions.endorserDid ? createDidOptions.endorserDid : '',
          },
        })) as IndyVdrDidCreateResult
        return { did: didCreateTxResult.didState.did, didDocument: didCreateTxResult.didState.didDocument }
      }
    }
  }

  private async handleIndicio(
    createDidOptions: DidCreate,
    tenantAgent: TenantAgent<RestAgentModules>,
    didMethod: string
  ) {
    let didDocument
    if (!createDidOptions.seed) {
      throw Error('Seed is required')
    }

    if (createDidOptions.did) {
      await this.importDid(didMethod, createDidOptions?.did, createDidOptions.seed, tenantAgent)
      const getDid = await tenantAgent.dids.getCreatedDids({
        method: createDidOptions.method,
        did: `did:${createDidOptions.method}:${createDidOptions.network}:${createDidOptions.did}`,
      })
      if (getDid.length > 0) {
        didDocument = getDid[0].didDocument
      }

      return {
        did: `${didMethod}:${createDidOptions.did}`,
        didDocument: didDocument,
      }
    } else {
      if (createDidOptions?.role?.toLowerCase() === Role.Endorser) {
        return await this.handleEndorserCreation(createDidOptions, tenantAgent, didMethod)
      } else {
        return await this.handleIndyDidCreation(createDidOptions, tenantAgent)
      }
    }
  }

  private async handleEndorserCreation(
    createDidOptions: DidCreate,
    tenantAgent: TenantAgent<RestAgentModules>,
    didMethod: string
  ) {
    let didDocument
    if (!createDidOptions.seed) {
      throw Error('Seed is required')
    }
    const key = await tenantAgent.wallet.createKey({
      privateKey: TypedArrayEncoder.fromString(createDidOptions.seed),
      keyType: KeyType.Ed25519,
    })
    const buffer = TypedArrayEncoder.fromBase58(key.publicKeyBase58)

    const did = TypedArrayEncoder.toBase58(buffer.slice(0, 16))

    let body
    if (createDidOptions.network === Network.Indicio_Testnet) {
      body = {
        network: 'testnet',
        did,
        verkey: TypedArrayEncoder.toBase58(buffer),
      }
    } else if (createDidOptions.network === Network.Indicio_Demonet) {
      body = {
        network: 'demonet',
        did,
        verkey: TypedArrayEncoder.toBase58(buffer),
      }
    }
    const res = await axios.post(INDICIO_NYM_URL, body)
    if (res.data.statusCode === 200) {
      await this.importDid(didMethod, did, createDidOptions.seed, tenantAgent)
      const didRecord = await tenantAgent.dids.getCreatedDids({
        method: DidMethod.Indy,
        did: `${didMethod}:${body?.did}`,
      })
      if (didRecord.length > 0) {
        didDocument = didRecord[0].didDocument
      }

      return {
        did: `${didMethod}:${body?.did}`,
        didDocument: didDocument,
      }
    }
  }

  private async handleIndyDidCreation(createDidOptions: DidCreate, tenantAgent: TenantAgent<RestAgentModules>) {
    if (!createDidOptions.endorserDid) {
      throw Error('endorserDid or role is required')
    }

    const didCreateTxResult = await tenantAgent.dids.create({
      method: DidMethod.Indy,
      options: {
        endorserMode: 'external',
        endorserDid: createDidOptions.endorserDid ? createDidOptions.endorserDid : '',
      },
    })
    return { didTx: didCreateTxResult.didState.did }
  }

  private async handleKey(createDidOptions: DidCreate, tenantId: string) {
    let didResponse
    let did: string
    let didDocument: any

    await this.agent.modules.tenants.withTenantAgent({ tenantId }, async (tenantAgent) => {
      if (!createDidOptions.seed) {
        throw Error('Seed is required')
      }
      if (!createDidOptions.keyType) {
        throw Error('keyType is required')
      }

      if (createDidOptions.keyType !== KeyType.Ed25519 && createDidOptions.keyType !== KeyType.Bls12381g2) {
        throw Error('Only ed25519 and bls12381g2 key type supported')
      }

      if (!createDidOptions.did) {
        await tenantAgent.wallet.createKey({
          keyType: createDidOptions.keyType,
          seed: TypedArrayEncoder.fromString(createDidOptions.seed),
        })
        const didKeyResponse = await tenantAgent.dids.create<KeyDidCreateOptions>({
          method: DidMethod.Key,
          options: {
            keyType: KeyType.Ed25519,
          },
          secret: {
            privateKey: TypedArrayEncoder.fromString(createDidOptions.seed),
          },
        })
        did = `${didKeyResponse.didState.did}`
        didDocument = didKeyResponse.didState.didDocument
      } else {
        did = createDidOptions.did
        const createdDid = await tenantAgent.dids.getCreatedDids({
          did: createDidOptions.did,
          method: DidMethod.Key,
        })
        didDocument = createdDid[0]?.didDocument
      }

      await tenantAgent.dids.import({
        did,
        overwrite: true,
        didDocument,
      })

      didResponse = {
        did,
        didDocument,
      }
    })
    return didResponse
  }

  private async handleDidPeer(createDidOptions: DidCreate, tenantId: string) {
    let didResponse
    let did: any

    if (!createDidOptions.keyType) {
      throw Error('keyType is required')
    }

    await this.agent.modules.tenants.withTenantAgent({ tenantId }, async (tenantAgent) => {
      const didRouting = await tenantAgent.mediationRecipient.getRouting({})
      const didDocument = createPeerDidDocumentFromServices([
        {
          id: 'didcomm',
          recipientKeys: [didRouting.recipientKey],
          routingKeys: didRouting.routingKeys,
          serviceEndpoint: didRouting.endpoints[0],
        },
      ])
      const didPeerResponse = await tenantAgent.dids.create<PeerDidNumAlgo2CreateOptions>({
        didDocument,
        method: DidMethod.Peer,
        options: {
          numAlgo: PeerDidNumAlgo.MultipleInceptionKeyWithoutDoc,
        },
      })

      did = didPeerResponse.didState.did
      didResponse = {
        did,
      }
    })
    return didResponse
  }

  private async handleWeb(createDidOptions: DidCreate, tenantId: string) {
    let did
    let didDocument: any

    if (!createDidOptions.domain) {
      throw Error('For web method domain is required')
    }

    if (!createDidOptions.keyType) {
      throw Error('keyType is required')
    }

    if (createDidOptions.keyType !== KeyType.Ed25519 && createDidOptions.keyType !== KeyType.Bls12381g2) {
      throw Error('Only ed25519 and bls12381g2 key type supported')
    }

    await this.agent.modules.tenants.withTenantAgent({ tenantId }, async (tenantAgent) => {
      if (!createDidOptions.seed) {
        throw Error('Seed is required')
      }

      did = `did:${createDidOptions.method}:${createDidOptions.domain}`
      const keyId = `${did}#key-1`
      const key = await tenantAgent.wallet.createKey({
        keyType: createDidOptions.keyType,
        seed: TypedArrayEncoder.fromString(createDidOptions.seed),
      })
      if (createDidOptions.keyType === KeyType.Ed25519) {
        didDocument = new DidDocumentBuilder(did)
          .addContext('https://w3id.org/security/suites/ed25519-2018/v1')
          .addVerificationMethod(getEd25519VerificationKey2018({ key, id: keyId, controller: did }))
          .addAuthentication(keyId)
          .build()
      }
      if (createDidOptions.keyType === KeyType.Bls12381g2) {
        didDocument = new DidDocumentBuilder(did)
          .addContext('https://w3id.org/security/bbs/v1')
          .addVerificationMethod(getBls12381G2Key2020({ key, id: keyId, controller: did }))
          .addAuthentication(keyId)
          .build()
      }

      await tenantAgent.dids.import({
        did,
        overwrite: true,
        didDocument,
      })
    })
    return { did, didDocument }
  }

  public async handlePolygon(createDidOptions: DidCreate, tenantId: string) {
    let createDidResponse
    let didResponse
    await this.agent.modules.tenants.withTenantAgent({ tenantId }, async (tenantAgent) => {
      // need to discuss try catch logic

      const networkDetails = createDidOptions.network
      const networkName = networkDetails?.split(':')[1]

      const { endpoint, privatekey } = createDidOptions
      if (networkName !== 'mainnet' && networkName !== 'testnet') {
        throw Error('Invalid network type')
      }
      if (!privatekey || typeof privatekey !== 'string' || !privatekey.trim() || privatekey.length !== 64) {
        throw Error('Invalid private key or not supported')
      }

      createDidResponse = await tenantAgent.dids.create<PolygonDidCreateOptions>({
        method: DidMethod.Polygon,
        options: {
          network: networkName,
          endpoint,
        },
        secret: {
          privateKey: TypedArrayEncoder.fromHex(`${privatekey}`),
        },
      })
      didResponse = {
        did: createDidResponse?.didState?.did,
        didDoc: createDidResponse?.didState?.didDocument,
      }
    })
    return didResponse
  }

  private async importDid(didMethod: string, did: string, seed: string, tenantAgent: TenantAgent<RestAgentModules>) {
    await tenantAgent.dids.import({
      did: `${didMethod}:${did}`,
      overwrite: true,
      privateKeys: [
        {
          keyType: KeyType.Ed25519,
          privateKey: TypedArrayEncoder.fromString(seed),
        },
      ],
    })
  }

  @Security('apiKey')
  @Get('/dids/:tenantId')
  public async getDids(
    @Path('tenantId') tenantId: string,
    @Res() internalServerError: TsoaResponse<500, { message: string }>
  ) {
    try {
      let getDids
      await this.agent.modules.tenants.withTenantAgent({ tenantId }, async (tenantAgent) => {
        getDids = await tenantAgent.dids.getCreatedDids()
      })
      return getDids
    } catch (error) {
      return internalServerError(500, { message: `something went wrong: ${error}` })
    }
  }

  @Security('apiKey')
  @Post('/transactions/set-endorser-role/:tenantId')
  public async didNymTransaction(
    @Path('tenantId') tenantId: string,
    @Body() didNymTransaction: DidNymTransaction,
    @Res() internalServerError: TsoaResponse<500, { message: string }>
  ) {
    let didCreateSubmitResult
    try {
      await this.agent.modules.tenants.withTenantAgent({ tenantId }, async (tenantAgent) => {
        didCreateSubmitResult = await tenantAgent.dids.create({
          did: didNymTransaction.did,
          options: {
            endorserMode: 'external',
            endorsedTransaction: {
              nymRequest: didNymTransaction.nymRequest,
            },
          },
        })
        await tenantAgent.dids.import({
          did: didNymTransaction.did,
          overwrite: true,
        })
      })

      return didCreateSubmitResult
    } catch (error) {
      return internalServerError(500, { message: `something went wrong: ${error}` })
    }
  }

  @Security('apiKey')
  @Post('/transactions/endorse/:tenantId')
  public async endorserTransaction(
    @Path('tenantId') tenantId: string,
    @Body() endorserTransaction: EndorserTransaction,
    @Res() internalServerError: TsoaResponse<500, { message: string }>,
    @Res() forbiddenError: TsoaResponse<400, { reason: string }>
  ) {
    let signedTransaction
    try {
      await this.agent.modules.tenants.withTenantAgent({ tenantId }, async (tenantAgent) => {
        signedTransaction = await tenantAgent.modules.indyVdr.endorseTransaction(
          endorserTransaction.transaction,
          endorserTransaction.endorserDid
        )
      })

      return { signedTransaction }
    } catch (error) {
      if (error instanceof CredoError) {
        if (error.message.includes('UnauthorizedClientRequest')) {
          return forbiddenError(400, {
            reason: 'this action is not allowed.',
          })
        }
      }

      return internalServerError(500, { message: `something went wrong: ${error}` })
    }
  }

  @Example<ConnectionRecordProps>(ConnectionRecordExample)
  @Security('apiKey')
  @Get('/connections/:connectionId/:tenantId')
  public async getConnectionById(
    @Path('tenantId') tenantId: string,
    @Path('connectionId') connectionId: RecordId,
    @Res() notFoundError: TsoaResponse<404, { reason: string }>
  ) {
    let connectionRecord
    await this.agent.modules.tenants.withTenantAgent({ tenantId }, async (tenantAgent) => {
      const connection = await tenantAgent.connections.findById(connectionId)

      if (!connection)
        return notFoundError(404, { reason: `connection with connection id "${connectionId}" not found.` })
      connectionRecord = connection.toJSON()
    })

    return connectionRecord
  }

  @Security('apiKey')
  @Post('/create-invitation/:tenantId')
  public async createInvitation(
    @Res() internalServerError: TsoaResponse<500, { message: string }>,
    @Path('tenantId') tenantId: string,
    @Body() config?: Omit<CreateOutOfBandInvitationConfig, 'routing'> & RecipientKeyOption // Remove routing property from type
  ) {
    let outOfBandRecord: OutOfBandRecord | undefined
    let invitationDid: string | undefined
    try {
      await this.agent.modules.tenants.withTenantAgent({ tenantId }, async (tenantAgent) => {
        if (config?.invitationDid) {
          invitationDid = config?.invitationDid
        } else {
          const didRouting = await tenantAgent.mediationRecipient.getRouting({})
          const didDocument = createPeerDidDocumentFromServices([
            {
              id: 'didcomm',
              recipientKeys: [didRouting.recipientKey],
              routingKeys: didRouting.routingKeys,
              serviceEndpoint: didRouting.endpoints[0],
            },
          ])
          const did = await tenantAgent.dids.create<PeerDidNumAlgo2CreateOptions>({
            didDocument,
            method: 'peer',
            options: {
              numAlgo: PeerDidNumAlgo.MultipleInceptionKeyWithoutDoc,
            },
          })
          invitationDid = did.didState.did
        }

        outOfBandRecord = await tenantAgent.oob.createInvitation({ ...config, invitationDid })
      })

      return {
        invitationUrl: outOfBandRecord?.outOfBandInvitation.toUrl({
          domain: this.agent.config.endpoints[0],
        }),
        invitation: outOfBandRecord?.outOfBandInvitation.toJSON({
          useDidSovPrefixWhereAllowed: this.agent.config.useDidSovPrefixWhereAllowed,
        }),
        outOfBandRecord: outOfBandRecord?.toJSON(),
        invitationDid: config?.invitationDid ? '' : invitationDid,
      }
    } catch (error) {
      return internalServerError(500, { message: `something went wrong: ${error}` })
    }
  }

  @Security('apiKey')
  @Post('/create-legacy-invitation/:tenantId')
  public async createLegacyInvitation(
    @Res() internalServerError: TsoaResponse<500, { message: string }>,
    @Path('tenantId') tenantId: string,
    @Body()
    config?: Omit<CreateOutOfBandInvitationConfig, 'routing' | 'appendedAttachments' | 'messages'> & RecipientKeyOption // props removed because of issues with serialization
  ) {
    let getInvitation
    try {
      let routing: Routing
      await this.agent.modules.tenants.withTenantAgent({ tenantId }, async (tenantAgent) => {
        if (config?.recipientKey) {
          routing = {
            endpoints: tenantAgent.config.endpoints,
            routingKeys: [],
            recipientKey: Key.fromPublicKeyBase58(config.recipientKey, KeyType.Ed25519),
            mediatorId: undefined,
          }
        } else {
          routing = await tenantAgent.mediationRecipient.getRouting({})
        }
        const { outOfBandRecord, invitation } = await tenantAgent.oob.createLegacyInvitation({ ...config, routing })
        getInvitation = {
          invitationUrl: invitation.toUrl({
            domain: this.agent.config.endpoints[0],
            useDidSovPrefixWhereAllowed: this.agent.config.useDidSovPrefixWhereAllowed,
          }),
          invitation: invitation.toJSON({
            useDidSovPrefixWhereAllowed: this.agent.config.useDidSovPrefixWhereAllowed,
          }),
          outOfBandRecord: outOfBandRecord.toJSON(),
          ...(config?.recipientKey ? {} : { recipientKey: routing.recipientKey.publicKeyBase58 }),
        }
      })

      return getInvitation
    } catch (error) {
      return internalServerError(500, { message: `something went wrong: ${error}` })
    }
  }

  @Security('apiKey')
  @Post('/receive-invitation/:tenantId')
  public async receiveInvitation(
    @Body() invitationRequest: ReceiveInvitationProps,
    @Path('tenantId') tenantId: string,
    @Res() internalServerError: TsoaResponse<500, { message: string }>
  ) {
    let receiveInvitationRes
    try {
      await this.agent.modules.tenants.withTenantAgent({ tenantId }, async (tenantAgent) => {
        const { invitation, ...config } = invitationRequest
        const invite = new OutOfBandInvitation({ ...invitation, handshakeProtocols: invitation.handshake_protocols })
        const { outOfBandRecord, connectionRecord } = await tenantAgent.oob.receiveInvitation(invite, config)
        receiveInvitationRes = {
          outOfBandRecord: outOfBandRecord.toJSON(),
          connectionRecord: connectionRecord?.toJSON(),
        }
      })

      return receiveInvitationRes
    } catch (error) {
      return internalServerError(500, { message: `something went wrong: ${error}` })
    }
  }

  @Security('apiKey')
  @Post('/receive-invitation-url/:tenantId')
  public async receiveInvitationFromUrl(
    @Body() invitationRequest: ReceiveInvitationByUrlProps,
    @Path('tenantId') tenantId: string,
    @Res() internalServerError: TsoaResponse<500, { message: string }>
  ) {
    let receiveInvitationUrl
    try {
      await this.agent.modules.tenants.withTenantAgent({ tenantId }, async (tenantAgent) => {
        const { invitationUrl, ...config } = invitationRequest
        const { outOfBandRecord, connectionRecord } = await tenantAgent.oob.receiveInvitationFromUrl(
          invitationUrl,
          config
        )
        receiveInvitationUrl = {
          outOfBandRecord: outOfBandRecord.toJSON(),
          connectionRecord: connectionRecord?.toJSON(),
        }
      })

      return receiveInvitationUrl
    } catch (error) {
      return internalServerError(500, { message: `something went wrong: ${error}` })
    }
  }

  @Security('apiKey')
  @Get('/oob/:invitationId/:tenantId')
  public async getAllOutOfBandRecords(
    @Path('tenantId') tenantId: string,
    @Res() internalServerError: TsoaResponse<500, { message: string }>,
    @Path('invitationId') invitationId?: string
  ) {
    let outOfBandRecordsRes
    try {
      await this.agent.modules.tenants.withTenantAgent({ tenantId }, async (tenantAgent) => {
        let outOfBandRecords
        outOfBandRecords = await tenantAgent.oob.getAll()

        if (invitationId)
          outOfBandRecords = outOfBandRecords.filter((o: any) => o.outOfBandInvitation.id === invitationId)
        outOfBandRecordsRes = outOfBandRecords.map((c: any) => c.toJSON())
      })

      return outOfBandRecordsRes
    } catch (error) {
      return internalServerError(500, { message: `something went wrong: ${error}` })
    }
  }

  @Security('apiKey')
  @Get('/connections/:tenantId')
  public async getAllConnections(
    @Path('tenantId') tenantId: string,
    @Res() internalServerError: TsoaResponse<500, { message: string }>,
    @Query('outOfBandId') outOfBandId?: string,
    @Query('alias') alias?: string,
    @Query('state') state?: DidExchangeState,
    @Query('myDid') myDid?: string,
    @Query('theirDid') theirDid?: string,
    @Query('theirLabel') theirLabel?: string
  ) {
    let connectionRecord
    try {
      await this.agent.modules.tenants.withTenantAgent({ tenantId }, async (tenantAgent) => {
        if (outOfBandId) {
          connectionRecord = await tenantAgent.connections.findAllByOutOfBandId(outOfBandId)
        } else {
          const connectionRepository = tenantAgent.dependencyManager.resolve(ConnectionRepository)

          const connections = await connectionRepository.findByQuery(tenantAgent.context, {
            alias,
            myDid,
            theirDid,
            theirLabel,
            state,
          })

          connectionRecord = connections.map((c: any) => c.toJSON())
        }
      })
      return connectionRecord
    } catch (error) {
      return internalServerError(500, { message: `something went wrong: ${error}` })
    }
  }

  @Get('/url/:tenantId/:invitationId')
  public async getInvitation(
    @Path('invitationId') invitationId: string,
    @Path('tenantId') tenantId: string,
    @Res() notFoundError: TsoaResponse<404, { reason: string }>
  ) {
    let invitationJson
    await this.agent.modules.tenants.withTenantAgent({ tenantId }, async (tenantAgent) => {
      const outOfBandRecord = await tenantAgent.oob.findByCreatedInvitationId(invitationId)

      if (!outOfBandRecord || outOfBandRecord.state !== 'await-response')
        return notFoundError(404, { reason: `connection with invitationId "${invitationId}" not found.` })

      invitationJson = outOfBandRecord.outOfBandInvitation.toJSON({ useDidSovPrefixWhereAllowed: true })
    })
    return invitationJson
  }

  @Security('apiKey')
  @Post('/schema/:tenantId')
  public async createSchema(
    @Body()
    schema: {
      issuerId: string
      name: string
      version: Version
      attributes: string[]
      endorse?: boolean
      endorserDid?: string
    },
    @Path('tenantId') tenantId: string,
    @Res() forbiddenError: TsoaResponse<400, { reason: string }>,
    @Res() internalServerError: TsoaResponse<500, { message: string }>
  ) {
    let schemaRecord
    try {
      await this.agent.modules.tenants.withTenantAgent({ tenantId }, async (tenantAgent) => {
        if (!schema.endorse) {
          const { schemaState } = await tenantAgent.modules.anoncreds.registerSchema({
            schema: {
              issuerId: schema.issuerId,
              name: schema.name,
              version: schema.version,
              attrNames: schema.attributes,
            },
            options: {
              endorserMode: 'internal',
              endorserDid: schema.issuerId,
            },
          })

          if (!schemaState.schemaId) {
            throw Error('SchemaId not found')
          }

          const indySchemaId = parseIndySchemaId(schemaState.schemaId)
          const getSchemaId = await getUnqualifiedSchemaId(
            indySchemaId.namespaceIdentifier,
            indySchemaId.schemaName,
            indySchemaId.schemaVersion
          )
          if (schemaState.state === CredentialEnum.Finished) {
            schemaState.schemaId = getSchemaId
          }

          schemaRecord = schemaState
        } else {
          if (!schema.endorserDid) {
            throw new Error('Please provide the endorser DID')
          }

          const createSchemaTxResult = await tenantAgent.modules.anoncreds.registerSchema({
            options: {
              endorserMode: 'external',
              endorserDid: schema.endorserDid ? schema.endorserDid : '',
            },
            schema: {
              attrNames: schema.attributes,
              issuerId: schema.issuerId,
              name: schema.name,
              version: schema.version,
            },
          })

          schemaRecord = createSchemaTxResult
        }
      })

      return schemaRecord
    } catch (error) {
      if (error instanceof CredoError) {
        if (error.message.includes('UnauthorizedClientRequest')) {
          return forbiddenError(400, {
            reason: 'this action is not allowed.',
          })
        }
      }

      return internalServerError(500, { message: `something went wrong: ${error}` })
    }
  }

  @Security('apiKey')
  @Post('/polygon-wc3/schema/:tenantId')
  public async createPolygonW3CSchema(
    @Body()
    createSchemaRequest: {
      did: string
      schemaName: string
      schema: { [key: string]: any }
    },
    @Path('tenantId') tenantId: string,
    @Res() internalServerError: TsoaResponse<500, { message: string }>
  ): Promise<SchemaMetadata> {
    try {
      const { did, schemaName, schema } = createSchemaRequest
      if (!did || !schemaName || !schema) {
        throw Error('One or more parameters are empty or undefined.')
      }

      const schemaResponse = await this.agent.modules.tenants.withTenantAgent({ tenantId }, async (tenantAgent) => {
        return await tenantAgent.modules.polygon.createSchema({
          did,
          schemaName,
          schema,
        })
      })

      const configFileData = fs.readFileSync('config.json', 'utf-8')
      const config = JSON.parse(configFileData)
      if (!config.schemaFileServerURL) {
        throw new Error('Please provide valid schema file server URL')
      }

      if (!schemaResponse?.schemaId) {
        throw new Error('Invalid schema response')
      }
      const schemaPayload: SchemaMetadata = {
        schemaUrl: config.schemaFileServerURL + schemaResponse?.schemaId,
        did: schemaResponse?.did,
        schemaId: schemaResponse?.schemaId,
        schemaTxnHash: schemaResponse?.resourceTxnHash,
      }

      return schemaPayload
    } catch (error) {
      return internalServerError(500, { message: `something went wrong: ${error}` })
    }
  }

  @Security('apiKey')
  @Get('polygon-wc3/schema/:did/:schemaId/:tenantId')
  public async getPolygonW3CSchemaById(
    @Path('tenantId') tenantId: string,
    @Path('did') did: string,
    @Path('schemaId') schemaId: string,
    @Res() internalServerError: TsoaResponse<500, { message: string }>,
    @Res() badRequestError: TsoaResponse<400, { reason: string }>,
    @Res() forbiddenError: TsoaResponse<401, { reason: string }>
  ): Promise<unknown> {
    if (!tenantId || !did || !schemaId) {
      return badRequestError(400, { reason: 'Missing or invalid parameters.' })
    }

    try {
      await this.agent.modules.tenants.withTenantAgent({ tenantId }, async (tenantAgent) => {
        return tenantAgent.modules.polygon.getSchemaById(did, schemaId)
      })
    } catch (error) {
      if (error instanceof CredoError) {
        if (error.message.includes('UnauthorizedClientRequest')) {
          return forbiddenError(401, {
            reason: 'this action is not allowed.',
          })
        }
      }
      return internalServerError(500, { message: `something went wrong: ${error}` })
    }
  }

  @Security('apiKey')
  @Post('/transactions/write/:tenantId')
  public async writeSchemaAndCredDefOnLedger(
    @Path('tenantId') tenantId: string,
    @Res() forbiddenError: TsoaResponse<400, { reason: string }>,
    @Res() internalServerError: TsoaResponse<500, { message: string }>,
    @Body()
    writeTransaction: WriteTransaction
  ) {
    try {
      if (writeTransaction.schema) {
        const writeSchema = await this.submitSchemaOnLedger(
          writeTransaction.schema,
          writeTransaction.endorsedTransaction,
          tenantId
        )
        return writeSchema
      } else if (writeTransaction.credentialDefinition) {
        const writeCredDef = await this.submitCredDefOnLedger(
          writeTransaction.credentialDefinition,
          writeTransaction.endorsedTransaction,
          tenantId
        )
        return writeCredDef
      } else {
        throw new Error('Please provide valid schema or credential-def!')
      }
    } catch (error) {
      if (error instanceof CredoError) {
        if (error.message.includes('UnauthorizedClientRequest')) {
          return forbiddenError(400, {
            reason: 'this action is not allowed.',
          })
        }
      }
      return internalServerError(500, { message: `something went wrong: ${error}` })
    }
  }

  public async submitSchemaOnLedger(
    schema: {
      issuerId: string
      name: string
      version: Version
      attributes: string[]
    },
    endorsedTransaction: string,
    tenantId: string
  ) {
    let schemaRecord
    await this.agent.modules.tenants.withTenantAgent({ tenantId }, async (tenantAgent) => {
      const { issuerId, name, version, attributes } = schema
      const { schemaState } = await tenantAgent.modules.anoncreds.registerSchema({
        options: {
          endorserMode: 'external',
          endorsedTransaction,
        },
        schema: {
          attrNames: attributes,
          issuerId: issuerId,
          name: name,
          version: version,
        },
      })

      if (!schemaState.schemaId) {
        throw Error('SchemaId not found')
      }

      const indySchemaId = parseIndySchemaId(schemaState.schemaId)
      const getSchemaUnqualifiedId = await getUnqualifiedSchemaId(
        indySchemaId.namespaceIdentifier,
        indySchemaId.schemaName,
        indySchemaId.schemaVersion
      )
      if (schemaState.state === CredentialEnum.Finished || schemaState.state === CredentialEnum.Action) {
        schemaState.schemaId = getSchemaUnqualifiedId
      }
      schemaRecord = schemaState
    })
    return schemaRecord
  }

  public async submitCredDefOnLedger(
    credentialDefinition: {
      schemaId: string
      issuerId: string
      tag: string
      value: unknown
      type: string
    },
    endorsedTransaction: string,
    tenantId: string
  ) {
    let credentialDefinitionRecord
    await this.agent.modules.tenants.withTenantAgent({ tenantId }, async (tenantAgent) => {
      const { credentialDefinitionState } = await tenantAgent.modules.anoncreds.registerCredentialDefinition({
        credentialDefinition,
        options: {
          endorserMode: 'external',
          endorsedTransaction: endorsedTransaction,
          // TODO: Update this later
          supportRevocation: false,
        },
      })

      if (!credentialDefinitionState.credentialDefinitionId) {
        throw Error('Credential Definition Id not found')
      }

      const indyCredDefId = parseIndyCredentialDefinitionId(credentialDefinitionState.credentialDefinitionId)
      const getCredentialDefinitionId = await getUnqualifiedCredentialDefinitionId(
        indyCredDefId.namespaceIdentifier,
        indyCredDefId.schemaSeqNo,
        indyCredDefId.tag
      )
      if (
        credentialDefinitionState.state === CredentialEnum.Finished ||
        credentialDefinitionState.state === CredentialEnum.Action
      ) {
        credentialDefinitionState.credentialDefinitionId = getCredentialDefinitionId
      }

      credentialDefinitionRecord = credentialDefinitionState
    })
    return credentialDefinitionRecord
  }

  @Security('apiKey')
  @Get('/schema/:schemaId/:tenantId')
  public async getSchemaById(
    @Path('schemaId') schemaId: SchemaId,
    @Path('tenantId') tenantId: string,
    @Res() notFoundError: TsoaResponse<404, { reason: string }>,
    @Res() forbiddenError: TsoaResponse<403, { reason: string }>,
    @Res() badRequestError: TsoaResponse<400, { reason: string }>,
    @Res() internalServerError: TsoaResponse<500, { message: string }>
  ) {
    let getSchema
    try {
      await this.agent.modules.tenants.withTenantAgent({ tenantId }, async (tenantAgent) => {
        getSchema = await tenantAgent.modules.anoncreds.getSchema(schemaId)
      })

      return getSchema
    } catch (error) {
      if (error instanceof AnonCredsError && error.message === 'IndyError(LedgerNotFound): LedgerNotFound') {
        return notFoundError(404, {
          reason: `schema definition with schemaId "${schemaId}" not found.`,
        })
      } else if (error instanceof AnonCredsError && error.cause instanceof AnonCredsError) {
        if ((error.cause.cause, 'LedgerInvalidTransaction')) {
          return forbiddenError(403, {
            reason: `schema definition with schemaId "${schemaId}" can not be returned.`,
          })
        }
        if ((error.cause.cause, 'CommonInvalidStructure')) {
          return badRequestError(400, {
            reason: `schemaId "${schemaId}" has invalid structure.`,
          })
        }
      }

      return internalServerError(500, { message: `something went wrong: ${error}` })
    }
  }

  @Security('apiKey')
  @Post('/credential-definition/:tenantId')
  public async createCredentialDefinition(
    @Body()
    credentialDefinitionRequest: {
      issuerId: string
      schemaId: string
      tag: string
      endorse?: boolean
      endorserDid?: string
    },
    @Path('tenantId') tenantId: string,
    @Res() notFoundError: TsoaResponse<404, { reason: string }>,
    @Res() internalServerError: TsoaResponse<500, { message: string }>
  ) {
    let credentialDefinitionRecord
    try {
      await this.agent.modules.tenants.withTenantAgent({ tenantId }, async (tenantAgent) => {
        credentialDefinitionRequest.endorse = credentialDefinitionRequest.endorse
          ? credentialDefinitionRequest.endorse
          : false

        if (!credentialDefinitionRequest.endorse) {
          const { credentialDefinitionState } = await tenantAgent.modules.anoncreds.registerCredentialDefinition({
            credentialDefinition: {
              issuerId: credentialDefinitionRequest.issuerId,
              schemaId: credentialDefinitionRequest.schemaId,
              tag: credentialDefinitionRequest.tag,
            },
            options: {
              // TODO: update this later
              supportRevocation: false,
            },
          })

          if (!credentialDefinitionState?.credentialDefinitionId) {
            throw new Error('Credential Definition Id not found')
          }
          const indyCredDefId = parseIndyCredentialDefinitionId(credentialDefinitionState.credentialDefinitionId)
          const getCredentialDefinitionId = await getUnqualifiedCredentialDefinitionId(
            indyCredDefId.namespaceIdentifier,
            indyCredDefId.schemaSeqNo,
            indyCredDefId.tag
          )
          if (credentialDefinitionState.state === CredentialEnum.Finished) {
            credentialDefinitionState.credentialDefinitionId = getCredentialDefinitionId
          }

          credentialDefinitionRecord = credentialDefinitionState
        } else {
          const createCredDefTxResult = await tenantAgent.modules.anoncreds.registerCredentialDefinition({
            credentialDefinition: {
              issuerId: credentialDefinitionRequest.issuerId,
              tag: credentialDefinitionRequest.tag,
              schemaId: credentialDefinitionRequest.schemaId,
              // TODO: Need to check this
              // type: 'CL',
            },
            options: {
              // TODO: update this later
              supportRevocation: false,
              endorserMode: 'external',
              endorserDid: credentialDefinitionRequest.endorserDid ? credentialDefinitionRequest.endorserDid : '',
            },
          })

          credentialDefinitionRecord = createCredDefTxResult
        }
      })

      return credentialDefinitionRecord
    } catch (error) {
      if (error instanceof notFoundError) {
        return notFoundError(404, {
          reason: `schema with schemaId "${credentialDefinitionRequest.schemaId}" not found.`,
        })
      }

      return internalServerError(500, { message: `something went wrong: ${error}` })
    }
  }

  @Security('apiKey')
  @Get('/credential-definition/:credentialDefinitionId/:tenantId')
  public async getCredentialDefinitionById(
    @Path('credentialDefinitionId') credentialDefinitionId: CredentialDefinitionId,
    @Path('tenantId') tenantId: string,
    @Res() badRequestError: TsoaResponse<400, { reason: string }>,
    @Res() notFoundError: TsoaResponse<404, { reason: string }>,
    @Res() internalServerError: TsoaResponse<500, { message: string }>
  ) {
    let getCredDef
    try {
      await this.agent.modules.tenants.withTenantAgent({ tenantId }, async (tenantAgent) => {
        getCredDef = await tenantAgent.modules.anoncreds.getCredentialDefinition(credentialDefinitionId)
      })

      return getCredDef
    } catch (error) {
      if (error instanceof CredoError && error.message === 'IndyError(LedgerNotFound): LedgerNotFound') {
        return notFoundError(404, {
          reason: `credential definition with credentialDefinitionId "${credentialDefinitionId}" not found.`,
        })
      } else if (error instanceof AnonCredsError && error.cause instanceof CredoError) {
        if ((error.cause.cause, 'CommonInvalidStructure')) {
          return badRequestError(400, {
            reason: `credentialDefinitionId "${credentialDefinitionId}" has invalid structure.`,
          })
        }
      }

      return internalServerError(500, { message: `something went wrong: ${error}` })
    }
  }

  @Security('apiKey')
  @Post('/credentials/create-offer/:tenantId')
  public async createOffer(
    @Body() createOfferOptions: CreateOfferOptions,
    @Path('tenantId') tenantId: string,
    @Res() internalServerError: TsoaResponse<500, { message: string }>
  ) {
    let offer
    try {
      await this.agent.modules.tenants.withTenantAgent({ tenantId }, async (tenantAgent) => {
        offer = await tenantAgent.credentials.offerCredential({
          connectionId: createOfferOptions.connectionId,
          protocolVersion: createOfferOptions.protocolVersion as CredentialProtocolVersionType<[]>,
          credentialFormats: createOfferOptions.credentialFormats,
          autoAcceptCredential: createOfferOptions.autoAcceptCredential,
        })
      })

      return offer
    } catch (error) {
      return internalServerError(500, { message: `something went wrong: ${error}` })
    }
  }

  @Security('apiKey')
  @Post('/credentials/create-offer-oob/:tenantId')
  public async createOfferOob(
    @Path('tenantId') tenantId: string,
    @Body() createOfferOptions: CreateOfferOobOptions,
    @Res() internalServerError: TsoaResponse<500, { message: string }>
  ) {
    let createOfferOobRecord

    try {
      let invitationDid: string | undefined
      await this.agent.modules.tenants.withTenantAgent({ tenantId }, async (tenantAgent) => {
        const linkSecretIds = await tenantAgent.modules.anoncreds.getLinkSecretIds()
        if (linkSecretIds.length === 0) {
          await tenantAgent.modules.anoncreds.createLinkSecret()
        }

        if (createOfferOptions?.invitationDid) {
          invitationDid = createOfferOptions?.invitationDid
        } else {
          const didRouting = await tenantAgent.mediationRecipient.getRouting({})
          const didDocument = createPeerDidDocumentFromServices([
            {
              id: 'didcomm',
              recipientKeys: [didRouting.recipientKey],
              routingKeys: didRouting.routingKeys,
              serviceEndpoint: didRouting.endpoints[0],
            },
          ])
          const did = await tenantAgent.dids.create<PeerDidNumAlgo2CreateOptions>({
            didDocument,
            method: 'peer',
            options: {
              numAlgo: PeerDidNumAlgo.MultipleInceptionKeyWithoutDoc,
            },
          })
          invitationDid = did.didState.did
        }

        const offerOob = await tenantAgent.credentials.createOffer({
          protocolVersion: createOfferOptions.protocolVersion as CredentialProtocolVersionType<[]>,
          credentialFormats: createOfferOptions.credentialFormats,
          autoAcceptCredential: createOfferOptions.autoAcceptCredential,
          comment: createOfferOptions.comment,
        })

        const credentialMessage = offerOob.message
        const outOfBandRecord = await tenantAgent.oob.createInvitation({
          label: createOfferOptions.label,
          messages: [credentialMessage],
          autoAcceptConnection: true,
          imageUrl: createOfferOptions?.imageUrl,
          goalCode: createOfferOptions?.goalCode,
          invitationDid,
        })

        createOfferOobRecord = {
          invitationUrl: outOfBandRecord.outOfBandInvitation.toUrl({
            domain: this.agent.config.endpoints[0],
          }),
          invitation: outOfBandRecord.outOfBandInvitation.toJSON({
            useDidSovPrefixWhereAllowed: this.agent.config.useDidSovPrefixWhereAllowed,
          }),
          outOfBandRecord: outOfBandRecord.toJSON(),
          outOfBandRecordId: outOfBandRecord.id,
          credentialRequestThId: offerOob.credentialRecord.threadId,
          invitationDid: createOfferOptions?.invitationDid ? '' : invitationDid,
        }
      })
      return createOfferOobRecord
    } catch (error) {
      return internalServerError(500, { message: `something went wrong: ${error}` })
    }
  }

  @Security('apiKey')
  @Post('/credentials/accept-offer/:tenantId')
  public async acceptOffer(
    @Res() notFoundError: TsoaResponse<404, { reason: string }>,
    @Res() internalServerError: TsoaResponse<500, { message: string }>,
    @Path('tenantId') tenantId: string,
    @Body() acceptCredentialOfferOptions: AcceptCredentialOfferOptions
  ) {
    let acceptOffer
    try {
      await this.agent.modules.tenants.withTenantAgent({ tenantId }, async (tenantAgent) => {
        const linkSecretIds = await tenantAgent.modules.anoncreds.getLinkSecretIds()
        if (linkSecretIds.length === 0) {
          await tenantAgent.modules.anoncreds.createLinkSecret()
        }
        acceptOffer = await tenantAgent.credentials.acceptOffer({
          credentialRecordId: acceptCredentialOfferOptions.credentialRecordId,
          credentialFormats: acceptCredentialOfferOptions.credentialFormats,
          autoAcceptCredential: acceptCredentialOfferOptions.autoAcceptCredential,
          comment: acceptCredentialOfferOptions.comment,
        })
      })

      return acceptOffer
    } catch (error) {
      if (error instanceof RecordNotFoundError) {
        return notFoundError(404, {
          reason: `credential with credential record id "${acceptCredentialOfferOptions.credentialRecordId}" not found.`,
        })
      }

      return internalServerError(500, { message: `something went wrong: ${error}` })
    }
  }

  @Security('apiKey')
  @Get('/credentials/:credentialRecordId/:tenantId')
  public async getCredentialById(
    @Path('credentialRecordId') credentialRecordId: RecordId,
    @Path('tenantId') tenantId: string,
    @Res() notFoundError: TsoaResponse<404, { reason: string }>,
    @Res() internalServerError: TsoaResponse<500, { message: string }>
  ) {
    let credentialRecord
    try {
      await this.agent.modules.tenants.withTenantAgent({ tenantId }, async (tenantAgent) => {
        const credential = await tenantAgent.credentials.getById(credentialRecordId)
        credentialRecord = credential.toJSON()
      })

      return credentialRecord
    } catch (error) {
      if (error instanceof RecordNotFoundError) {
        return notFoundError(404, {
          reason: `credential with credential record id "${credentialRecordId}" not found.`,
        })
      }

      return internalServerError(500, { message: `something went wrong: ${error}` })
    }
  }

  @Security('apiKey')
  @Get('/credentials/:tenantId')
  public async getAllCredentials(
    @Path('tenantId') tenantId: string,
    @Query('threadId') threadId?: string,
    @Query('connectionId') connectionId?: string,
    @Query('state') state?: CredentialState
  ) {
    let credentialRecord
    await this.agent.modules.tenants.withTenantAgent({ tenantId }, async (tenantAgent) => {
      const credentialRepository = tenantAgent.dependencyManager.resolve(CredentialRepository)
      const credentials = await credentialRepository.findByQuery(tenantAgent.context, {
        connectionId,
        threadId,
        state,
      })
      credentialRecord = credentials.map((c: any) => c.toJSON())
    })
    return credentialRecord
  }

  @Security('apiKey')
  @Get('/proofs/:tenantId')
  public async getAllProofs(@Path('tenantId') tenantId: string, @Query('threadId') threadId?: string) {
    let proofRecord
    await this.agent.modules.tenants.withTenantAgent({ tenantId }, async (tenantAgent) => {
      let proofs = await tenantAgent.proofs.getAll()
      if (threadId) proofs = proofs.filter((p: any) => p.threadId === threadId)
      proofRecord = proofs.map((proof: any) => proof.toJSON())
    })
    return proofRecord
  }

  @Security('apiKey')
  @Get('/form-data/:tenantId/:proofRecordId')
  @Example<ProofExchangeRecordProps>(ProofRecordExample)
  public async proofFormData(
    @Path('proofRecordId') proofRecordId: string,
    @Path('tenantId') tenantId: string,
    @Res() notFoundError: TsoaResponse<404, { reason: string }>,
    @Res() internalServerError: TsoaResponse<500, { message: string }>
  ) {
    let proof
    try {
      await this.agent.modules.tenants.withTenantAgent({ tenantId }, async (tenantAgent) => {
        proof = await tenantAgent.proofs.getFormatData(proofRecordId)
      })
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

  @Security('apiKey')
  @Post('/proofs/request-proof/:tenantId')
  @Example<ProofExchangeRecordProps>(ProofRecordExample)
  public async requestProof(
    @Body() requestProofOptions: RequestProofOptions,
    @Path('tenantId') tenantId: string,
    @Res() notFoundError: TsoaResponse<404, { reason: string }>,
    @Res() internalServerError: TsoaResponse<500, { message: string }>
  ) {
    let proof
    try {
      await this.agent.modules.tenants.withTenantAgent({ tenantId }, async (tenantAgent) => {
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
        proof = await tenantAgent.proofs.requestProof(requestProofPayload)
      })

      return proof
    } catch (error) {
      return internalServerError(500, { message: `something went wrong: ${error}` })
    }
  }

  @Security('apiKey')
  @Post('/proofs/create-request-oob/:tenantId')
  public async createRequest(
    @Path('tenantId') tenantId: string,
    @Body() createRequestOptions: CreateProofRequestOobOptions,
    @Res() internalServerError: TsoaResponse<500, { message: string }>
  ) {
    let oobProofRecord
    try {
      let invitationDid: string | undefined
      await this.agent.modules.tenants.withTenantAgent({ tenantId }, async (tenantAgent) => {
        if (createRequestOptions?.invitationDid) {
          invitationDid = createRequestOptions?.invitationDid
        } else {
          const didRouting = await tenantAgent.mediationRecipient.getRouting({})
          const didDocument = createPeerDidDocumentFromServices([
            {
              id: 'didcomm',
              recipientKeys: [didRouting.recipientKey],
              routingKeys: didRouting.routingKeys,
              serviceEndpoint: didRouting.endpoints[0],
            },
          ])
          const did = await tenantAgent.dids.create<PeerDidNumAlgo2CreateOptions>({
            didDocument,
            method: 'peer',
            options: {
              numAlgo: PeerDidNumAlgo.MultipleInceptionKeyWithoutDoc,
            },
          })
          invitationDid = did.didState.did
        }
        const proof = await tenantAgent.proofs.createRequest({
          protocolVersion: createRequestOptions.protocolVersion as ProofsProtocolVersionType<[]>,
          proofFormats: createRequestOptions.proofFormats,
          goalCode: createRequestOptions.goalCode,
          willConfirm: createRequestOptions.willConfirm,
          parentThreadId: createRequestOptions.parentThreadId,
          autoAcceptProof: createRequestOptions.autoAcceptProof,
          comment: createRequestOptions.comment,
        })

        const proofMessage = proof.message
        const outOfBandRecord = await tenantAgent.oob.createInvitation({
          label: createRequestOptions.label,
          messages: [proofMessage],
          autoAcceptConnection: true,
          imageUrl: createRequestOptions?.imageUrl,
          invitationDid,
          goalCode: createRequestOptions?.goalCode,
        })

        oobProofRecord = {
          invitationUrl: outOfBandRecord.outOfBandInvitation.toUrl({
            domain: this.agent.config.endpoints[0],
          }),
          invitation: outOfBandRecord.outOfBandInvitation.toJSON({
            useDidSovPrefixWhereAllowed: this.agent.config.useDidSovPrefixWhereAllowed,
          }),
          outOfBandRecord: outOfBandRecord.toJSON(),
          proofRecordThId: proof.proofRecord.threadId,
          proofMessageId: proof.message.thread?.threadId
            ? proof.message.thread?.threadId
            : proof.message.threadId
            ? proof.message.thread
            : proof.message.id,
          invitationDid: createRequestOptions?.invitationDid ? '' : invitationDid,
        }
      })

      return oobProofRecord
    } catch (error) {
      return internalServerError(500, { message: `something went wrong: ${error}` })
    }
  }

  @Security('apiKey')
  @Post('/proofs/:proofRecordId/accept-request/:tenantId')
  @Example<ProofExchangeRecordProps>(ProofRecordExample)
  public async acceptRequest(
    @Path('tenantId') tenantId: string,
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
    let proofRecord
    try {
      await this.agent.modules.tenants.withTenantAgent({ tenantId }, async (tenantAgent) => {
        const requestedCredentials = await tenantAgent.proofs.selectCredentialsForRequest({
          proofRecordId,
        })

        const acceptProofRequest: AcceptProofRequestOptions = {
          proofRecordId,
          comment: request.comment,
          proofFormats: requestedCredentials.proofFormats,
        }

        const proof = await tenantAgent.proofs.acceptRequest(acceptProofRequest)

        proofRecord = proof.toJSON()
      })
      return proofRecord
    } catch (error) {
      if (error instanceof RecordNotFoundError) {
        return notFoundError(404, {
          reason: `proof with proofRecordId "${proofRecordId}" not found.`,
        })
      }

      return internalServerError(500, { message: `something went wrong: ${error}` })
    }
  }

  @Security('apiKey')
  @Post('/proofs/:proofRecordId/accept-presentation/:tenantId')
  @Example<ProofExchangeRecordProps>(ProofRecordExample)
  public async acceptPresentation(
    @Path('tenantId') tenantId: string,
    @Path('proofRecordId') proofRecordId: string,
    @Res() notFoundError: TsoaResponse<404, { reason: string }>,
    @Res() internalServerError: TsoaResponse<500, { message: string }>
  ) {
    let proof
    try {
      await this.agent.modules.tenants.withTenantAgent({ tenantId }, async (tenantAgent) => {
        proof = await tenantAgent.proofs.acceptPresentation({ proofRecordId })
      })

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

  @Security('apiKey')
  @Get('/proofs/:proofRecordId/:tenantId')
  @Example<ProofExchangeRecordProps>(ProofRecordExample)
  public async getProofById(
    @Path('tenantId') tenantId: string,
    @Path('proofRecordId') proofRecordId: RecordId,
    @Res() notFoundError: TsoaResponse<404, { reason: string }>,
    @Res() internalServerError: TsoaResponse<500, { message: string }>
  ) {
    let proofRecord
    try {
      await this.agent.modules.tenants.withTenantAgent({ tenantId }, async (tenantAgent) => {
        const proof = await tenantAgent.proofs.getById(proofRecordId)
        proofRecord = proof.toJSON()
      })
      return proofRecord
    } catch (error) {
      if (error instanceof RecordNotFoundError) {
        return notFoundError(404, {
          reason: `proof with proofRecordId "${proofRecordId}" not found.`,
        })
      }

      return internalServerError(500, { message: `something went wrong: ${error}` })
    }
  }

  @Security('apiKey')
  @Delete(':tenantId')
  public async deleteTenantById(
    @Path('tenantId') tenantId: string,
    @Res() notFoundError: TsoaResponse<404, { reason: string }>,
    @Res() internalServerError: TsoaResponse<500, { message: string }>
  ) {
    try {
      const deleteTenant = await this.agent.modules.tenants.deleteTenantById(tenantId)
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

  @Security('apiKey')
  @Post('/did/web/:tenantId')
  public async createDidWeb(
    @Path('tenantId') tenantId: string,
    @Body() didOptions: DidCreate,
    @Res() internalServerError: TsoaResponse<500, { message: string }>
  ) {
    try {
      let didDoc
      await this.agent.modules.tenants.withTenantAgent({ tenantId }, async (tenantAgent) => {
        if (!didOptions.seed) {
          throw Error('Seed is required')
        }
        if (!didOptions.keyType) {
          throw Error('keyType is required')
        }
        if (didOptions.keyType !== KeyType.Ed25519 && didOptions.keyType !== KeyType.Bls12381g2) {
          throw Error('Only ed25519 and bls12381g2 key type supported')
        }
        const did = `did:${didOptions.method}:${didOptions.domain}`
        let didDocument: any
        const keyId = `${did}#key-1`
        const key = await tenantAgent.wallet.createKey({
          keyType: didOptions.keyType,
          seed: TypedArrayEncoder.fromString(didOptions.seed),
        })
        if (didOptions.keyType === 'ed25519') {
          didDocument = new DidDocumentBuilder(did)
            .addContext('https://w3id.org/security/suites/ed25519-2018/v1')
            .addVerificationMethod(getEd25519VerificationKey2018({ key, id: keyId, controller: did }))
            .addAuthentication(keyId)
            .build()
        }
        if (didOptions.keyType === 'bls12381g2') {
          didDocument = new DidDocumentBuilder(did)
            .addContext('https://w3id.org/security/bbs/v1')
            .addVerificationMethod(getBls12381G2Key2020({ key, id: keyId, controller: did }))
            .addAuthentication(keyId)
            .build()
        }

        didDoc = {
          did,
          didDocument: didDocument.toJSON(),
        }
      })
      return didDoc
    } catch (error) {
      return internalServerError(500, {
        message: `something went wrong: ${error}`,
      })
    }
  }

  @Security('apiKey')
  @Post('/did/key:tenantId')
  public async createDidKey(
    @Path('tenantId') tenantId: string,
    @Body() didOptions: DidCreate,
    @Res() internalServerError: TsoaResponse<500, { message: string }>
  ) {
    try {
      let didCreateResponse
      await this.agent.modules.tenants.withTenantAgent({ tenantId }, async (tenantAgent) => {
        if (!didOptions.seed) {
          throw Error('Seed is required')
        }
        didCreateResponse = await tenantAgent.dids.create<KeyDidCreateOptions>({
          method: 'key',
          options: {
            keyType: KeyType.Ed25519,
          },
          secret: {
            privateKey: TypedArrayEncoder.fromString(didOptions.seed),
          },
        })
      })
      return didCreateResponse
    } catch (error) {
      return internalServerError(500, {
        message: `something went wrong: ${error}`,
      })
    }
  }

  /**
   * Retrieve question and answer records by query
   *
   * @param tenantId Tenant identifier
   * @param connectionId Connection identifier
   * @param role Role of the question
   * @param state State of the question
   * @param threadId Thread identifier
   * @returns QuestionAnswerRecord[]
   */
  @Security('apiKey')
  @Get('/question-answer/:tenantId')
  public async getQuestionAnswerRecords(
    @Path('tenantId') tenantId: string,
    @Query('connectionId') connectionId?: string,
    @Query('role') role?: QuestionAnswerRole,
    @Query('state') state?: QuestionAnswerState,
    @Query('threadId') threadId?: string
  ) {
    let questionAnswerRecords: QuestionAnswerRecord[] = []
    await this.agent.modules.tenants.withTenantAgent({ tenantId }, async (tenantAgent) => {
      questionAnswerRecords = await tenantAgent.modules.questionAnswer.findAllByQuery({
        connectionId,
        role,
        state,
        threadId,
      })
    })
    return questionAnswerRecords.map((record) => record.toJSON())
  }

  /**
   * Send a question to a connection
   *
   * @param tenantId Tenant identifier
   * @param connectionId Connection identifier
   * @param content The content of the message
   */
  @Security('apiKey')
  @Post('/question-answer/question/:connectionId/:tenantId')
  public async sendQuestion(
    @Path('connectionId') connectionId: RecordId,
    @Path('tenantId') tenantId: string,
    @Body()
    config: {
      question: string
      validResponses: ValidResponse[]
      detail?: string
    },
    @Res() notFoundError: TsoaResponse<404, { reason: string }>,
    @Res() internalServerError: TsoaResponse<500, { message: string }>
  ) {
    try {
      const { question, validResponses, detail } = config
      let questionAnswerRecord
      await this.agent.modules.tenants.withTenantAgent({ tenantId }, async (tenantAgent) => {
        questionAnswerRecord = await tenantAgent.modules.questionAnswer.sendQuestion(connectionId, {
          question,
          validResponses,
          detail,
        })
        questionAnswerRecord = questionAnswerRecord?.toJSON()
      })

      return questionAnswerRecord
    } catch (error) {
      if (error instanceof RecordNotFoundError) {
        return notFoundError(404, { reason: `connection with connection id "${connectionId}" not found.` })
      }
      return internalServerError(500, { message: `something went wrong: ${error}` })
    }
  }

  /**
   * Send a answer to question
   *
   * @param tenantId Tenant identifier
   * @param id Question Answer Record identifier
   * @param response The response of the question
   */
  @Security('apiKey')
  @Post('/question-answer/answer/:id/:tenantId')
  public async sendAnswer(
    @Path('id') id: RecordId,
    @Path('tenantId') tenantId: string,
    @Body() request: Record<'response', string>,
    @Res() notFoundError: TsoaResponse<404, { reason: string }>,
    @Res() internalServerError: TsoaResponse<500, { message: string }>
  ) {
    try {
      let questionAnswerRecord
      await this.agent.modules.tenants.withTenantAgent({ tenantId }, async (tenantAgent) => {
        const record = await tenantAgent.modules.questionAnswer.sendAnswer(id, request.response)
        questionAnswerRecord = record.toJSON()
      })
      return questionAnswerRecord
    } catch (error) {
      if (error instanceof RecordNotFoundError) {
        return notFoundError(404, { reason: `record with connection id "${id}" not found.` })
      }
      return internalServerError(500, { message: `something went wrong: ${error}` })
    }
  }

  /**
   * Retrieve question answer record by id
   *
   * @param id Question Answer Record identifier
   * @param tenantId Tenant identifier
   * @returns ConnectionRecord
   */
  @Security('apiKey')
  @Get('/question-answer/:id/:tenantId')
  public async getQuestionAnswerRecordById(
    @Path('id') id: RecordId,
    @Path('tenantId') tenantId: string,
    @Res() notFoundError: TsoaResponse<404, { reason: string }>
  ) {
    let questionAnswerRecord
    await this.agent.modules.tenants.withTenantAgent({ tenantId }, async (tenantAgent) => {
      const record = await tenantAgent.modules.questionAnswer.findById(id)
      questionAnswerRecord = record
    })

    if (!questionAnswerRecord) {
      return notFoundError(404, {
        reason: `Question Answer Record with id "${id}" not found.`,
      })
    }

    return questionAnswerRecord
  }
}
