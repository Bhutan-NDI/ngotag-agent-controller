import type { RestAgentModules } from '../../cliAgent'
import type { SchemaMetadata } from '../types'

import { generateSecp256k1KeyPair } from '@ayanworks/credo-polygon-w3c-module'
import { DidOperation } from '@ayanworks/credo-polygon-w3c-module/build/ledger'
import { Agent, CredoError } from '@credo-ts/core'
import * as fs from 'fs'
import { injectable } from 'tsyringe'

import { Route, Tags, Security, Controller, Post, TsoaResponse, Res, Body, Get, Path } from 'tsoa'

@Tags('Polygon')
@Security('apiKey')
@Route('/polygon')
@injectable()
export class Polygon extends Controller {
  private agent: Agent<RestAgentModules>

  public constructor(agent: Agent<RestAgentModules>) {
    super()
    this.agent = agent
  }

  /**
   * Create Secp256k1 key pair for polygon DID
   *
   * @returns Secp256k1KeyPair
   */
  @Post('create-keys')
  public async createKeyPair(@Res() internalServerError: TsoaResponse<500, { message: string }>): Promise<{
    privateKey: string
    publicKeyBase58: string
    address: string
  }> {
    try {
      return await generateSecp256k1KeyPair()
    } catch (error) {
      // Handle the error here
      return internalServerError(500, { message: `something went wrong: ${error}` })
    }
  }

  /**
   * Create polygon based W3C schema
   *
   * @returns Schema JSON
   */
  @Post('create-schema')
  public async createSchema(
    @Body()
    createSchemaRequest: {
      did: string
      schemaName: string
      schema: { [key: string]: any }
    },
    @Res() internalServerError: TsoaResponse<500, { message: string }>,
    @Res() badRequestError: TsoaResponse<400, { reason: string }>
  ): Promise<unknown> {
    try {
      const { did, schemaName, schema } = createSchemaRequest
      if (!did || !schemaName || !schema) {
        return badRequestError(400, {
          reason: `One or more parameters are empty or undefined.`,
        })
      }

      const schemaResponse = await this.agent.modules.polygon.createSchema({
        did,
        schemaName,
        schema,
      })

      const schemaServerConfig = fs.readFileSync('config.json', 'utf-8')
      const configJson = JSON.parse(schemaServerConfig)
      if (!configJson.schemaFileServerURL) {
        throw new Error('Please provide valid schema file server URL')
      }

      if (!schemaResponse?.schemaId) {
        throw new Error('Invalid schema response')
      }
      const schemaPayload: SchemaMetadata = {
        schemaUrl: configJson.schemaFileServerURL + schemaResponse?.schemaId,
        did: schemaResponse?.did,
        schemaId: schemaResponse?.schemaId,
        schemaTxnHash: schemaResponse?.resourceTxnHash,
      }
      return schemaPayload
    } catch (error) {
      return internalServerError(500, { message: `something went wrong: ${error}` })
    }
  }

  /**
   * Estimate transaction
   *
   * @returns Transaction Object
   */
  @Post('estimate-transaction')
  public async estimateTransaction(
    @Body()
    estimateTransactionRequest: {
      operation: any
      transaction: any
    },
    @Res() internalServerError: TsoaResponse<500, { message: string }>,
    @Res() badRequestError: TsoaResponse<400, { reason: string }>
  ): Promise<unknown> {
    try {
      const { operation } = estimateTransactionRequest

      if (!(operation in DidOperation)) {
        return badRequestError(400, {
          reason: `Invalid method parameter!`,
        })
      }
      if (operation === DidOperation.Create) {
        return this.agent.modules.polygon.estimateFeeForDidOperation({ operation })
      } else if (operation === DidOperation.Update) {
        return this.agent.modules.polygon.estimateFeeForDidOperation({ operation })
      }
    } catch (error) {
      return internalServerError(500, { message: `something went wrong: ${error}` })
    }
  }

  /**
   * Fetch schema details
   *
   * @returns Schema Object
   */
  @Get(':did/:schemaId')
  public async getSchemaById(
    @Path('did') did: string,
    @Path('schemaId') schemaId: string,
    @Res() internalServerError: TsoaResponse<500, { message: string }>,
    @Res() forbiddenError: TsoaResponse<401, { reason: string }>
  ): Promise<unknown> {
    try {
      return this.agent.modules.polygon.getSchemaById(did, schemaId)
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
}
