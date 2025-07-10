import type { RestAgentModules, RestMultiTenantAgentModules } from '../../cliAgent'
import type {
  CustomW3cJsonLdSignCredentialOptions,
  RecipientKeyOption,
  SafeW3cJsonLdVerifyCredentialOptions,
  SchemaMetadata,
  SignDataOptions,
} from '../types'
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

import { Agent, JsonTransformer, injectable, RecordNotFoundError } from '@credo-ts/core'
import { Request as Req } from 'express'
import jwt from 'jsonwebtoken'
import { Body, Controller, Delete, Post, Route, Tags, Path, Security, Request, Res, TsoaResponse, Get } from 'tsoa'

import { CredentialEnum, DidMethod, Network, Role } from '../../enums/enum'
import { BCOVRIN_REGISTER_URL, INDICIO_NYM_URL } from '../../utils/util'
import { W3cJsonLdVerifiableCredential } from '@credo-ts/core'
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
  SignDataOptions,
  VerifyDataOptions,
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


  /**
   * Send a question to a connection
   *
   * @param tenantId Tenant identifier
   * @param connectionId Connection identifier
   * @param content The content of the message
   */
  @Security('apiKey')
  @Post('/basic-message/:connectionId/:tenantId')
  public async sendBasicMessage(
    @Path('connectionId') connectionId: RecordId,
    @Path('tenantId') tenantId: string,
    @Body() request: Record<'content', string>,
    @Res() notFoundError: TsoaResponse<404, { reason: string }>,
    @Res() internalServerError: TsoaResponse<500, { message: string }>
  ) {
    try {
      let basicMessageRecord
      await this.agent.modules.tenants.withTenantAgent({ tenantId }, async (tenantAgent) => {
        basicMessageRecord = await tenantAgent.basicMessages.sendMessage(connectionId, request.content)
        basicMessageRecord = basicMessageRecord?.toJSON()
      })
      return basicMessageRecord
    } catch (error) {
      if (error instanceof RecordNotFoundError) {
        return notFoundError(404, { reason: `connection with connection id "${connectionId}" not found.` })
      }
      return internalServerError(500, { message: `something went wrong: ${error}` })
    }
  }

  /**
   * Sign data using a key
   *
   * @param tenantId Tenant identifier
   * @param request Sign options
   *  data - Data has to be in base64 format
   *  publicKeyBase58 - Public key in base58 format
   * @returns Signature in base64 format
   */
  @Security('apiKey')
  @Post('/sign/:tenantId')
  public async sign(
    @Path('tenantId') tenantId: string,
    @Body() request: CustomW3cJsonLdSignCredentialOptions | SignDataOptions | any,
    @Res() badRequestError: TsoaResponse<400, { reason: string }>,
    @Res() notFoundError: TsoaResponse<404, { reason: string }>,
    @Res() internalServerError: TsoaResponse<500, { message: string }>
  ) {
    try {
      const signature = await this.agent.modules.tenants.withTenantAgent({ tenantId }, async (tenantAgent) => {
        assertAskarWallet(tenantAgent.context.wallet)

        // Raw Data Signing
        const rawData = request as SignDataOptions

        if (!rawData.data) return notFoundError(404, { reason: `Missing "data" for raw data signing` })

        const hasDidOrMethod = rawData.did || rawData.method
        const hasPublicKey = rawData.publicKeyBase58 && rawData.keyType

        if (!hasDidOrMethod && !hasPublicKey) {
          return badRequestError(400, {
            reason: `Either (did or method) OR (publicKeyBase58 and keyType) must be provided.`,
          })
        }

        let keyToUse: Key

        if (hasDidOrMethod) {
          const dids = await tenantAgent.dids.getCreatedDids({
            method: rawData.method || undefined,
            did: rawData.did || undefined,
          })

          const verificationMethod = dids[0]?.didDocument?.verificationMethod?.[0]?.publicKeyBase58
          if (!verificationMethod) {
            return badRequestError(400, {
              reason: `No publicKeyBase58 found for the given DID or method.`,
            })
          }

          keyToUse = Key.fromPublicKeyBase58(verificationMethod, rawData.keyType)
        } else {
          keyToUse = Key.fromPublicKeyBase58(rawData.publicKeyBase58, rawData.keyType)
        }

        if (!keyToUse) {
          throw new Error('Unable to construct signing key.')
        }

        const signature = await tenantAgent.context.wallet.sign({
          data: TypedArrayEncoder.fromBase64(rawData.data),
          key: keyToUse,
        })
        return TypedArrayEncoder.toBase64(signature)
      })
      return signature
    } catch (error) {
      if (error instanceof RecordNotFoundError) {
        return notFoundError(404, { reason: `record with key "${request.publicKeyBase58}" not found.` })
      }
      return internalServerError(500, { message: `something went wrong: ${error}` })
    }
  }

  /**
   * Verify data using a key
   *
   * @param tenantId Tenant identifier
   * @param request Verify options
   *  data - Data has to be in base64 format
   *  publicKeyBase58 - Public key in base58 format
   *  signature - Signature in base64 format
   * @returns isValidSignature - true if signature is valid, false otherwise
   */
  @Security('apiKey')
  @Post('/verify/:tenantId')
  public async verify(
    @Path('tenantId') tenantId: string,
    @Body() request: VerifyDataOptions,
    @Res() badRequestError: TsoaResponse<400, { reason: string }>,
    @Res() notFoundError: TsoaResponse<404, { reason: string }>,
    @Res() internalServerError: TsoaResponse<500, { message: string }>
  ) {
    try {
      const isValidSignature = await this.agent.modules.tenants.withTenantAgent({ tenantId }, async (tenantAgent) => {
        assertAskarWallet(tenantAgent.context.wallet)

        const hasDidOrMethod = request.did || request.method
        const hasPublicKey = request.publicKeyBase58 && request.keyType

        if (!hasDidOrMethod && !hasPublicKey) {
          return badRequestError(400, {
            reason: `Either (did or method) OR (publicKeyBase58 and keyType) must be provided.`,
          })
        }

        let keyToUse: Key

        if (hasDidOrMethod) {
          const dids = await tenantAgent.dids.getCreatedDids({
            method: request.method || undefined,
            did: request.did || undefined,
          })
          const verificationMethod = dids[0]?.didDocument?.verificationMethod?.[0]?.publicKeyBase58
          if (!verificationMethod) {
            return badRequestError(400, {
              reason: `No publicKeyBase58 found for the given DID or method.`,
            })
          }
          keyToUse = Key.fromPublicKeyBase58(verificationMethod, request.keyType)
        } else {
          keyToUse = Key.fromPublicKeyBase58(request.publicKeyBase58, request.keyType)
        }

        if (!keyToUse) {
          throw new Error('Unable to construct key.')
        }

        const isValidSignature = await tenantAgent.context.wallet.verify({
          data: TypedArrayEncoder.fromBase64(request.data),
          key: keyToUse,
          signature: TypedArrayEncoder.fromBase64(request.signature),
        })
        return isValidSignature
      })
      return isValidSignature
    } catch (error) {
      if (error instanceof RecordNotFoundError) {
        return notFoundError(404, { reason: `record with key "${request.publicKeyBase58}" not found.` })
      }
      return internalServerError(500, { message: `something went wrong: ${error}` })
    }
  }

  @Security('apiKey')
  @Post('/credential/verify/:tenantId')
  public async verifyCredential(
    @Path('tenantId') tenantId: string,
    @Body() credentialToVerify: SafeW3cJsonLdVerifyCredentialOptions | any,
    @Res() internalServerError: TsoaResponse<500, { message: string }>
  ) {
    let formattedCredential
    try {
      await this.agent.modules.tenants.withTenantAgent({ tenantId }, async (tenantAgent) => {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { credential, ...credentialOptions } = credentialToVerify
        const transformedCredential = JsonTransformer.fromJSON(
          credentialToVerify?.credential,
          W3cJsonLdVerifiableCredential
        )
        const signedCred = await tenantAgent.w3cCredentials.verifyCredential({
          credential: transformedCredential,
          ...credentialOptions,
        })
        formattedCredential = signedCred
      })
      return formattedCredential
    } catch (error) {
      return internalServerError(500, { message: `Something went wrong: ${error}` })
    }
  }
}
