import type { SchemaMetadata } from '../types'

import { generateSecp256k1KeyPair } from '@ayanworks/credo-polygon-w3c-module'
import { CredoError } from '@credo-ts/core'
import { Request as Req } from 'express'
import * as fs from 'fs'
import { Route, Tags, Security, Controller, Post, TsoaResponse, Res, Body, Get, Path, Request } from 'tsoa'
import { injectable } from 'tsyringe'

import { SCOPES } from '../../enums'
import {
  addressFromEthrDid,
  checkSchemaRecord,
  loadSchemaDocument,
  type SchemaVerificationResult,
} from '../../utils/schemaVerification'

@Tags('Ethereum')
@Route('/ethereum')
@injectable()
export class Ethereum extends Controller {
  /**
   * Create Ethereum key pair for ethereum DID
   *
   * @returns Secp256k1KeyPair
   */
  @Security('jwt', [SCOPES.TENANT_AGENT, SCOPES.DEDICATED_AGENT, SCOPES.MULTITENANT_BASE_AGENT])
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
   * Create ethereum based W3C schema
   *
   * @returns Schema JSON
   */
  @Security('jwt', [SCOPES.TENANT_AGENT, SCOPES.DEDICATED_AGENT])
  @Post('create-schema')
  public async createSchema(
    @Request() request: Req,
    @Body()
    createSchemaRequest: {
      did: string
      schemaName: string
      schema: { [key: string]: any }
    },
    @Res() internalServerError: TsoaResponse<500, { message: string }>,
    @Res() badRequestError: TsoaResponse<400, { reason: string }>,
  ): Promise<unknown> {
    try {
      const { did, schemaName, schema } = createSchemaRequest
      if (!did || !schemaName || !schema) {
        return badRequestError(400, {
          reason: `One or more parameters are empty or undefined.`,
        })
      }

      const schemaResponse = await request.agent.modules.ethereum.createSchema({
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
        // schemaTxnHash: schemaResponse?.resourceTxnHash,
      }
      return schemaPayload
    } catch (error) {
      return internalServerError(500, { message: `something went wrong: ${error}` })
    }
  }

  /**
   * Migrate W3C based schema to ethereum
   *
   * @returns Schema JSON
   */
  @Security('jwt', [SCOPES.TENANT_AGENT, SCOPES.DEDICATED_AGENT])
  @Post('migrate-schema')
  public async migrateSchema(
    @Request() request: Req,
    @Body()
    migrateSchemaRequest: {
      did: string
      schemaId: string
    },
    @Res() internalServerError: TsoaResponse<500, { message: string }>,
    @Res() badRequestError: TsoaResponse<400, { reason: string }>,
  ): Promise<unknown> {
    try {
      const { did, schemaId } = migrateSchemaRequest
      if (!did) {
        return badRequestError(400, {
          reason: `DID is required.`,
        })
      }

      if (!schemaId) {
        return badRequestError(400, {
          reason: `Existing Schema Id is required.`,
        })
      }

      const schemaResponse = await request.agent.modules.ethereum.createExistingSchema({
        did,
        schemaId,
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
      }
      return schemaPayload
    } catch (error) {
      return internalServerError(500, { message: `something went wrong: ${error}` })
    }
  }

  /**
   * Verify an ethereum based W3C schema against its on-chain record
   *
   * @returns Verification result; status is `verified`, `legacy` (record predates checksums) or `failed`
   */
  @Security('jwt', [SCOPES.TENANT_AGENT, SCOPES.DEDICATED_AGENT])
  @Post('verify-schema')
  public async verifySchema(
    @Request() request: Req,
    @Body()
    verifySchemaRequest: {
      did: string
      schemaId: string
      /** URL the credential references; defaults to the schema file server URL for the schema ID */
      schemaUrl?: string
    },
    @Res() internalServerError: TsoaResponse<500, { message: string }>,
    @Res() badRequestError: TsoaResponse<400, { reason: string }>,
  ): Promise<SchemaVerificationResult> {
    const { did, schemaId } = verifySchemaRequest
    if (!did || !schemaId) {
      return badRequestError(400, { reason: 'did and schemaId are required.' })
    }
    try {
      addressFromEthrDid(did)
    } catch (error) {
      return badRequestError(400, { reason: `${(error as Error).message}` })
    }

    try {
      let schemaUrl = verifySchemaRequest.schemaUrl
      if (!schemaUrl) {
        const configJson = JSON.parse(fs.readFileSync('config.json', 'utf-8'))
        if (!configJson.schemaFileServerURL) {
          throw new Error('Please provide valid schema file server URL')
        }
        schemaUrl = configJson.schemaFileServerURL + schemaId
      }

      const [recordJson, schema] = await Promise.all([
        request.agent.modules.ethereum.getSchemaById(did, schemaId).catch((error: Error) => {
          if (error.message.includes('Schema not found on ledger')) return null
          throw error
        }),
        loadSchemaDocument(request.agent.context, schemaUrl),
      ])

      if (!recordJson) {
        return {
          status: 'failed',
          reason: 'No on-chain record for this DID and schema ID',
          schemaUrl,
          writerChecked: false,
        }
      }
      return { ...checkSchemaRecord(did, schemaId, recordJson, schema), schemaUrl, writerChecked: false }
    } catch (error) {
      return internalServerError(500, { message: `something went wrong: ${error}` })
    }
  }

  /**
   * Fetch schema details
   *
   * @returns Schema Object
   */
  @Security('jwt', [SCOPES.TENANT_AGENT, SCOPES.DEDICATED_AGENT])
  @Get(':did/:schemaId')
  public async getSchemaById(
    @Request() request: Req,
    @Path('did') did: string,
    @Path('schemaId') schemaId: string,
    @Res() internalServerError: TsoaResponse<500, { message: string }>,
    @Res() forbiddenError: TsoaResponse<401, { reason: string }>,
  ): Promise<unknown> {
    try {
      return await request.agent.modules.ethereum.getSchemaById(did, schemaId)
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
