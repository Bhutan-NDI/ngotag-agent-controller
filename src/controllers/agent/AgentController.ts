import type {
  AgentInfo,
  AgentToken,
  jsonLdCredentialOptions,
  SafeW3cJsonLdVerifyCredentialOptions,
  VerifyDataOptions,
} from '../types'
import type {
  JsonObject,
  SingleOrArray,
  W3cCredentialOptions,
  W3cCredentialSubjectOptions,
  W3cJsonLdSignCredentialOptions,
} from '@credo-ts/core'

import {
  ClaimFormat,
  JsonTransformer,
  W3cCredential,
  W3cCredentialRecord,
  W3cJsonLdVerifiableCredential,
} from '@credo-ts/core'
import { Request as Req } from 'express'
import jwt from 'jsonwebtoken'
import { Controller, Get, Route, Tags, Security, Request, Post, Body } from 'tsoa'
import { injectable } from 'tsyringe'

import { AgentRole, SCOPES } from '../../enums'
import ErrorHandlingService from '../../errorHandlingService'
import { NotFoundError } from '../../errors'
import { verifyDidBoundSignature } from '../../utils/didSignatureVerification'

@Tags('Agent')
@Route('/agent')
@injectable()
export class AgentController extends Controller {
  /**
   * Retrieve basic agent information
   */
  @Security('jwt', [SCOPES.TENANT_AGENT, SCOPES.DEDICATED_AGENT, SCOPES.MULTITENANT_BASE_AGENT])
  @Get('/')
  public async getAgentInfo(@Request() request: Req): Promise<AgentInfo> {
    try {
      // TODO: Need to update this config payload based on modules like didcom amd openid4vc
      return {
        label: request.agent.context.contextCorrelationId,
        endpoints: request.agent.modules.didcomm.config.endpoints,
        isInitialized: request.agent.isInitialized,
        publicDid: undefined,
      }
    } catch (error) {
      throw ErrorHandlingService.handle(error)
    }
  }

  /**
   * Retrieve agent token
   */
  @Post('/token')
  @Security('apiKey')
  public async getAgentToken(@Request() request: Req): Promise<AgentToken> {
    let token
    const genericRecords = await request.agent.genericRecords.findAllByQuery({ hasSecretKey: 'true' })
    const secretKey = genericRecords[0]?.content.secretKey as string
    if (!secretKey) {
      throw new Error('SecretKey not found')
    }
    if (!('tenants' in request.agent.modules)) {
      token = jwt.sign({ role: AgentRole.RestRootAgent }, secretKey)
    } else {
      token = jwt.sign({ role: AgentRole.RestRootAgentWithTenants }, secretKey)
    }
    return {
      token: token,
    }
  }

  //   /**
  //    * Delete wallet
  //    */
  //   @Security('jwt', [SCOPES.TENANT_AGENT, SCOPES.DEDICATED_AGENT])
  //   @Delete('/wallet')
  //   public async deleteWallet(@Request() request: Req) {
  //     try {
  //       const deleteWallet = await request.agent.wallet.delete()
  //       return deleteWallet
  //     } catch (error) {
  //       throw ErrorHandlingService.handle(error)
  //     }
  //   }

  //   /**
  //    * Verify data using a key
  //    *
  //    * @param tenantId Tenant identifier
  //    * @param request Verify options
  //    *  data - Data has to be in base64 format
  //    *  publicKeyBase58 - Public key in base58 format
  //    *  signature - Signature in base64 format
  //    * @returns isValidSignature - true if signature is valid, false otherwise
  //    */
  //   @Security('jwt', [SCOPES.TENANT_AGENT, SCOPES.DEDICATED_AGENT])
  //   @Post('/verify')
  //   public async verify(@Request() request: Req, @Body() body: VerifyDataOptions) {
  //     try {
  //       assertAskarWallet(request.agent.context.wallet)
  //       const isValidSignature = await request.agent.context.wallet.verify({
  //         data: TypedArrayEncoder.fromBase64(body.data),
  //         key: Key.fromPublicKeyBase58(body.publicKeyBase58, body.keyType),
  //         signature: TypedArrayEncoder.fromBase64(body.signature),
  //       })
  //       return isValidSignature
  //     } catch (error) {
  //       throw ErrorHandlingService.handle(error)
  //     }
  //   }

  //   //Triage: Do we want the BW to be able to sign and verify as well?
  //   @Security('jwt', [SCOPES.TENANT_AGENT, SCOPES.DEDICATED_AGENT])
  //   @Post('/credential/sign')
  //   public async signCredential(
  //     @Request() request: Req,
  //     @Query('storeCredential') storeCredential: boolean,
  //     @Query('dataTypeToSign') dataTypeToSign: 'rawData' | 'jsonLd',
  //     @Body() data: CustomW3cJsonLdSignCredentialOptions | SignDataOptions | unknown,
  //   ) {
  //     try {
  //       // JSON-LD VC Signing
  //       if (dataTypeToSign === 'jsonLd') {
  //         const credentialData = data as unknown as W3cJsonLdSignCredentialOptions
  //         credentialData.format = ClaimFormat.LdpVc
  //         const signedCredential = (await request.agent.w3cCredentials.signCredential(
  //           credentialData,
  //         )) as W3cJsonLdVerifiableCredential
  //         if (storeCredential) {
  //           return await request.agent.w3cCredentials.storeCredential({ credential: signedCredential })
  //         }
  //         return signedCredential.toJson()
  //       }

  //       // Raw Data Signing
  //       const rawData = data as SignDataOptions
  //       if (!rawData.data) throw new BadRequestError('Missing "data" for raw data signing.')

  //       const hasDidOrMethod = rawData.did || rawData.method
  //       const hasPublicKey = rawData.publicKeyBase58 && rawData.keyType
  //       if (!hasDidOrMethod && !hasPublicKey) {
  //         throw new BadRequestError('Either (did or method) OR (publicKeyBase58 and keyType) must be provided.')
  //       }

  //       let keyToUse: Key
  //       if (hasDidOrMethod) {
  //         const dids = await request.agent.dids.getCreatedDids({
  //           method: rawData.method || undefined,
  //           did: rawData.did || undefined,
  //         })
  //         const verificationMethod = dids[0]?.didDocument?.verificationMethod?.[0]?.publicKeyBase58
  //         if (!verificationMethod) {
  //           throw new BadRequestError('No publicKeyBase58 found for the given DID or method.')
  //         }
  //         keyToUse = Key.fromPublicKeyBase58(verificationMethod, rawData.keyType)
  //       } else {
  //         keyToUse = Key.fromPublicKeyBase58(rawData.publicKeyBase58, rawData.keyType)
  //       }

  //       if (!keyToUse) {
  //         throw new Error('Unable to construct signing key. ')
  //       }

  //       const signature = await request.agent.context.wallet.sign({
  //         data: TypedArrayEncoder.fromBase64(rawData.data),
  //         key: keyToUse,
  //       })

  //       return TypedArrayEncoder.toBase64(signature)
  //     } catch (error) {
  //       throw ErrorHandlingService.handle(error)
  //     }
  //   }

  /**
   * Verify a DID-bound challenge-response signature.
   *
   * The signing algorithm is determined by the key type in the holder's DID Document
   * (e.g. EdDSA for Ed25519 did:key, ES256 for P-256) — the endpoint is not
   * restricted to Ed25519. Any algorithm supported by the resolved authentication
   * key is accepted.
   *
   * @param body Verify options
   *  did - DID whose authentication key is used to verify (resolved server-side)
   *  data - Signed data, base64 encoded
   *  signature - Signature to verify, base64 encoded
   * @returns true if the signature is valid for the DID-resolved key, false otherwise
   */
  @Security('jwt', [SCOPES.TENANT_AGENT, SCOPES.DEDICATED_AGENT])
  @Post('/verify')
  public async verify(@Request() request: Req, @Body() body: VerifyDataOptions): Promise<boolean> {
    try {
      return await verifyDidBoundSignature(request.agent.dids, request.agent.kms, body)
    } catch (error) {
      throw ErrorHandlingService.handle(error)
    }
  }

  @Security('jwt', [SCOPES.TENANT_AGENT, SCOPES.DEDICATED_AGENT])
  @Post('/credential/verify')
  public async verifyCredential(
    @Request() request: Req,
    @Body() credentialToVerify: SafeW3cJsonLdVerifyCredentialOptions | any,
  ) {
    try {
      const { credential, ...credentialOptions } = credentialToVerify
      const transformedCredential = JsonTransformer.fromJSON(
        credentialToVerify?.credential,
        W3cJsonLdVerifiableCredential,
      )
      const signedCred = await request.agent.w3cCredentials.verifyCredential({
        credential: transformedCredential,
        ...credentialOptions,
      })
      return signedCred
    } catch (error) {
      throw ErrorHandlingService.handle(error)
    }
  }

  /**
   * Create and store a self-attested W3C JSON-LD credential — the agent issues a credential to
   * itself using its own default DID, rather than an external issuer signing over a subject DID.
   *
   * Lives on request.agent, not /multi-tenancy/:tenantId + withTenantAgent() — matching
   * verifyCredential/verify above rather than the legacy pipeline-implementation placement. The
   * auth layer already resolves the tenant agent per request for a tenant token (see
   * authentication.ts), which is why no live controller on develop calls withTenantAgent(); the
   * /multi-tenancy/:tenantId placement is base-wallet-token only (MULTITENANT_BASE_AGENT), so a
   * dedicated agent or a tenant's own token could never have reached it there.
   *
   * Ported from pipeline-implementation, adapted for the current Credo version:
   * - request.agent instead of the legacy this.agent field (no longer exists on this controller).
   * - credentialSubject's claims are nested under a `claims` key when building the subject —
   *   W3cCredentialSubject's constructor only reads options.id/options.claims, so spreading the
   *   request's claims at the top level (as the legacy code effectively did, via a plain object
   *   that bypassed the class transform) would silently drop every claim from the issued
   *   credential. Handles a single object or an array of subjects.
   * - w3cCredentials.store({ record }) instead of the removed storeCredential({ credential });
   *   W3cCredentialRecord.fromCredential(signedCred) builds the record directly from the signed
   *   credential — signCredential() already returns a typed W3cVerifiableCredential instance, so
   *   the legacy JsonTransformer.fromJSON re-parse step is no longer needed either.
   * - the response restores a top-level `credential` field for back-compat: 0.6.2's
   *   W3cCredentialRecord replaces 0.5.x's top-level `credential` with a `credentialInstances`
   *   array (credential survives only as a private write-only setter), which would otherwise
   *   silently change the response shape for downstream consumers (platform's apps/cloud-wallet
   *   -> agent-service -> mobile wallet) that read response.credential directly.
   */
  @Security('jwt', [SCOPES.TENANT_AGENT, SCOPES.DEDICATED_AGENT])
  @Post('/credential/self-attested')
  public async createW3cSelfAttestedCredential(
    @Request() request: Req,
    @Body() selfAttestedCredentialOptions: jsonLdCredentialOptions,
  ) {
    try {
      // Default DID is tracked via a GenericRecord (see DidController.writeDid), not a DidRecord
      // tag — Credo 0.6.2's DidRecord custom tags are typed to just recipientKeyFingerprints/
      // alternativeDids, so a query like the legacy findSingleByQuery(..., {isDefault: true})
      // matches nothing on this Credo version, 404ing unconditionally regardless of how the DID
      // was created.
      const [defaultDidGenericRecord] = await request.agent.genericRecords.findAllByQuery({ isDefaultDid: 'true' })
      let selfDid = defaultDidGenericRecord?.content.did as string | undefined

      // Fallback for existing/migrated wallets that predate the GenericRecord-based tracking
      // above — every one of those had its default written as a DidRecord tag under the legacy
      // stack, which the GenericRecord lookup above can never see, and there is no backfill step.
      // Without this, every such wallet permanently 404s here, with a brand-new (re-anchored, for
      // did:indy/did:web) DID as the only workaround. Only kicks in when unambiguous: a tenant
      // with exactly one created DID has an obvious "the" DID to self-issue from even though it
      // was never explicitly marked default; a tenant with more than one gets the same 404 as
      // before, since guessing among several would risk silently issuing under the wrong identity.
      //
      // did:peer entries are excluded from the candidate list before that count: getCreatedDids()
      // is a role filter ("everything with role: Created"), not "DIDs the operator explicitly
      // wrote" — PeerDidRegistrar saves every DIDComm connection/mediation-routing DID with that
      // same role. A holder wallet's whole purpose is DIDComm, so having made at least one
      // connection is the common case, not the exception; without this exclusion, length === 1
      // would almost never hold for exactly the migrated wallets this fallback exists to unblock.
      if (!selfDid) {
        const createdDids = (await request.agent.dids.getCreatedDids()).filter(
          (record) => !record.did.startsWith('did:peer:'),
        )
        if (createdDids.length === 1) {
          selfDid = createdDids[0].did
        }
      }

      if (!selfDid) {
        throw new NotFoundError('Default DID not found')
      }

      // resolveCreatedDidDocumentWithKeys, not getCreatedDids({did}) + record.didDocument directly:
      // Credo only persists didDocument on the DidRecord for some methods —
      // KeyDidRegistrar never saves one at all, and PeerDidRegistrar only saves one for numAlgo 1
      // (DidController's handleDidPeer uses numAlgo 2). Reading record.didDocument straight off
      // the record would silently be undefined for did:key/did:peer defaults, the two most likely
      // methods for this endpoint. This API resolves the document when it wasn't persisted, and
      // throws RecordNotFoundError (mapped to 404 by ErrorHandlingService below) when the DID
      // itself is gone — covering the old !defaultDidRecord branch too.
      const { didDocument: defaultDidDocument } = await request.agent.dids.resolveCreatedDidDocumentWithKeys(selfDid)
      // Select by purpose, not array position: did:peer's numAlgo2 document is built purely
      // through purpose-specific setters (addAssertionMethod/addAuthentication/addKeyAgreement),
      // none of which touch didDocument.verificationMethod at all — so for every did:peer,
      // verificationMethod is undefined even though the document is otherwise complete.
      // assertionMethod/authentication entries can legitimately be either a plain DID-URL string
      // or an embedded VerificationMethod object, hence the typeof check. Falling back to
      // verificationMethod[0] last keeps the previous behavior for did:indy/did:web, where
      // preferring an assertion-capable key first is also more correct than an arbitrary index.
      const vmRef =
        defaultDidDocument?.assertionMethod?.[0] ??
        defaultDidDocument?.authentication?.[0] ??
        defaultDidDocument?.verificationMethod?.[0]
      const selfDidVerificationMethod = typeof vmRef === 'string' ? vmRef : vmRef?.id

      if (!selfDidVerificationMethod) {
        throw new Error('Default DID Verification method is missing or undefined')
      }

      const {
        '@context': selfAttestedContext,
        type: selfAttestedType,
        credentialSubject: selfAttestedSubjectOptions,
        proofType: selfAttestedProofType,
      } = selfAttestedCredentialOptions

      const toSubject = (subject: JsonObject): W3cCredentialSubjectOptions => ({
        id: selfDid,
        claims: subject,
      })
      const selfAttestedSubject: SingleOrArray<W3cCredentialSubjectOptions> = Array.isArray(selfAttestedSubjectOptions)
        ? selfAttestedSubjectOptions.map(toSubject)
        : toSubject(selfAttestedSubjectOptions)
      const selfAttestedW3cCredential: W3cCredentialOptions = {
        context: selfAttestedContext,
        type: selfAttestedType,
        issuer: selfDid,
        issuanceDate: new Date().toISOString(),
        credentialSubject: selfAttestedSubject,
      }
      const selfAttestedJsonLdCredential: W3cJsonLdSignCredentialOptions = {
        format: ClaimFormat.LdpVc,
        credential: new W3cCredential(selfAttestedW3cCredential),
        proofType: selfAttestedProofType,
        verificationMethod: selfDidVerificationMethod,
      }
      const signedCred = await request.agent.w3cCredentials.signCredential(selfAttestedJsonLdCredential)
      const selfAttestedStoredCredential = await request.agent.w3cCredentials.store({
        record: W3cCredentialRecord.fromCredential(signedCred),
      })
      return {
        ...JsonTransformer.toJSON(selfAttestedStoredCredential),
        credential: JsonTransformer.toJSON(selfAttestedStoredCredential.firstCredential),
      }
    } catch (error) {
      throw ErrorHandlingService.handle(error)
    }
  }
}
