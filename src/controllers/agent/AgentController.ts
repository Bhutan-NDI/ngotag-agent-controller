import type {
  AgentInfo,
  AgentToken,
  jsonLdCredentialOptions,
  SafeW3cJsonLdVerifyCredentialOptions,
  SelfAttestedW3cCredentialResponse,
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
  DidRepository,
  JsonTransformer,
  W3cCredential,
  W3cCredentialRecord,
  W3cJsonLdVerifiableCredential,
} from '@credo-ts/core'
import { Request as Req } from 'express'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'node:crypto'
import { isIP } from 'node:net'
import { Controller, Get, Route, Tags, Security, Request, Post, Body } from 'tsoa'
import { injectable } from 'tsyringe'

import { AgentRole, SCOPES } from '../../enums'
import ErrorHandlingService from '../../errorHandlingService'
import { NotFoundError, BadRequestError } from '../../errors'
import { findDefaultDidRecords } from '../../utils/defaultDid'
import { verifyDidBoundSignature } from '../../utils/didSignatureVerification'

// 100 years: effectively non-expiring default when the caller doesn't request an expiry (W3cCredential requires some value).
const SELF_ATTESTED_DEFAULT_EXPIRATION_MS = 100 * 365.25 * 24 * 60 * 60 * 1000

const BLOCKED_CONTEXT_HOSTNAMES = new Set(['localhost'])

function isPrivateOrLoopbackIPv4(ip: string): boolean {
  const octets = ip.split('.').map(Number)
  if (4 !== octets.length || octets.some((n) => Number.isNaN(n))) {
    return false
  }
  const [a, b] = octets
  return (
    0 === a || // 0.0.0.0/8
    10 === a || // 10.0.0.0/8 (private)
    127 === a || // 127.0.0.0/8 (loopback)
    (100 === a && 64 <= b && 127 >= b) || // 100.64.0.0/10 (RFC 6598 CGNAT / shared address space)
    (169 === a && 254 === b) || // 169.254.0.0/16 (link-local, incl. cloud metadata endpoints)
    (172 === a && 16 <= b && 31 >= b) || // 172.16.0.0/12 (private)
    (192 === a && 168 === b) // 192.168.0.0/16 (private)
  )
}

// Node's URL parser canonicalizes any embedded IPv4 in an IPv6 literal to hex-group form (e.g.
// ::ffff:127.0.0.1 -> ::ffff:7f00:1), including the un-prefixed/NAT64 forms -- unwrap before checking.
function ipv4MappedToIPv4(ip: string): string | undefined {
  const dotted = /^::(?:ffff:)?(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(ip)
  if (dotted) {
    return dotted[1]
  }
  const hex = /^::(?:ffff:0:|ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(ip)
  if (!hex) {
    return undefined
  }
  const high = parseInt(hex[1], 16)
  const low = parseInt(hex[2], 16)
  return [(high >> 8) & 0xff, 0xff & high, (low >> 8) & 0xff, 0xff & low].join('.')
}

function isPrivateOrLoopbackIPv6(ip: string): boolean {
  const lower = ip.toLowerCase()
  if (
    '::1' === lower || // loopback
    '::' === lower || // unspecified address -- loops back to the host on most stacks
    lower.startsWith('fc') || // fc00::/7 unique-local -- 'fc'/'fd' as hex-nibble prefixes exactly
    lower.startsWith('fd') // cover this /7 range, unlike the fe80::/10 case below
  ) {
    return true
  }
  // fe80::/10 spans first-hextet 0xfe80-0xfebf; a literal 'fe80:' prefix only matches one of them.
  const firstHextet = parseInt(lower.split(':')[0], 16)
  if (!Number.isNaN(firstHextet) && 0xfe80 <= firstHextet && 0xfebf >= firstHextet) {
    return true
  }
  const mappedIPv4 = ipv4MappedToIPv4(lower)
  if (mappedIPv4) {
    return isPrivateOrLoopbackIPv4(mappedIPv4)
  }
  return false
}

// See createW3cSelfAttestedCredential's SSRF-guard comment for scope. Only checks literal
// addresses/hostnames -- deliberately not a full constrained loader.
function assertSafeContextUrl(context: string): void {
  let parsed: URL
  try {
    parsed = new URL(context)
  } catch {
    // Not a URL (e.g. a bare JSON-LD term/prefix) -- nothing gets fetched, nothing to guard.
    return
  }
  if ('https:' !== parsed.protocol) {
    throw new BadRequestError(`@context entry '${context}' must use https`)
  }
  // URL.hostname retains IPv6 brackets and any number of trailing root dots (both accepted verbatim
  // by new URL()) -- strip both before the exact-match/IP checks below, or 'localhost.' bypasses them.
  const rawHostname = parsed.hostname.toLowerCase()
  const bracketless = rawHostname.startsWith('[') ? rawHostname.slice(1, -1) : rawHostname
  const hostname = bracketless.replace(/\.+$/, '')
  if (BLOCKED_CONTEXT_HOSTNAMES.has(hostname)) {
    throw new BadRequestError(`@context entry '${context}' points at a disallowed host`)
  }
  const ipVersion = isIP(hostname)
  const isBlockedIp =
    (4 === ipVersion && isPrivateOrLoopbackIPv4(hostname)) || (6 === ipVersion && isPrivateOrLoopbackIPv6(hostname))
  if (isBlockedIp) {
    throw new BadRequestError(`@context entry '${context}' points at a disallowed host`)
  }
}

// @import and a term's own scoped @context can each smuggle a URL into JSON-LD processing from
// inside an object @context entry, and scoped contexts can nest further -- so this recurses.
function containsForbiddenNestedContextKeyword(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some((entry) => containsForbiddenNestedContextKeyword(entry))
  }
  if (value && 'object' === typeof value) {
    return Object.entries(value as Record<string, unknown>).some(
      ([key, nestedValue]) =>
        '@import' === key || '@context' === key || containsForbiddenNestedContextKeyword(nestedValue),
    )
  }
  return false
}

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
   * Lives on request.agent, not /multi-tenancy/:tenantId + withTenantAgent(): the auth layer
   * already resolves the tenant agent per request for a tenant token, matching verifyCredential/
   * verify above.
   *
   * credentialSubject's claims are nested under a `claims` key — W3cCredentialSubject's
   * constructor only reads options.id/options.claims, so spreading claims at the top level would
   * silently drop them. The response restores a top-level `credential` field for back-compat,
   * since 0.6.2's W3cCredentialRecord otherwise only exposes `credentialInstances`.
   */
  @Security('jwt', [SCOPES.TENANT_AGENT, SCOPES.DEDICATED_AGENT])
  @Post('/credential/self-attested')
  public async createW3cSelfAttestedCredential(
    @Request() request: Req,
    @Body() selfAttestedCredentialOptions: jsonLdCredentialOptions,
  ): Promise<SelfAttestedW3cCredentialResponse> {
    try {
      // Default DID is tracked as an `isDefault` tag on the DID's own DidRecord (see DidController.writeDid).
      // findByQuery (not findSingleByQuery) tolerates a wallet carrying more than one tagged DID (e.g. legacy
      // migration); findDefaultDidRecords sorts by createdAt so this agrees with DidController.getDids.
      const [defaultDidRecord] = await findDefaultDidRecords(
        request.agent.dependencyManager.resolve(DidRepository),
        request.agent.context,
      )
      let selfDid = defaultDidRecord?.did

      // Fallback for wallets that never explicitly set a default DID: only fires when exactly one
      // non-peer created DID exists (did:peer is excluded -- DIDComm connections use the same role tag).
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

      // resolveCreatedDidDocumentWithKeys, not record.didDocument directly: Credo doesn't persist a
      // document for did:key, and only for did:peer numAlgo 1 (this endpoint uses numAlgo 2).
      const { didDocument: defaultDidDocument } = await request.agent.dids.resolveCreatedDidDocumentWithKeys(selfDid)
      // assertionMethod only, no verificationMethod/authentication fallback: proofPurpose is always
      // assertionMethod below, and a verificationMethod-only key would sign successfully but produce a
      // credential that fails verification everywhere else -- a loud error here beats a silently-
      // unverifiable credential in a holder's wallet. did:peer lacking an assertionMethod key is a
      // DID-creation gap, not something to work around at signing time.
      const vmRef = defaultDidDocument?.assertionMethod?.[0]
      const selfDidVerificationMethod = typeof vmRef === 'string' ? vmRef : vmRef?.id

      if (!selfDidVerificationMethod) {
        throw new Error(
          `Default DID '${selfDid}' has no assertionMethod verification method; it cannot be used to issue credentials`,
        )
      }

      const {
        '@context': selfAttestedContext,
        type: selfAttestedType,
        credentialSubject: selfAttestedSubjectOptions,
        proofType: selfAttestedProofType,
        expirationDate: selfAttestedExpirationDate,
      } = selfAttestedCredentialOptions

      // Caller-controlled @context can reach Credo's native JSON-LD loader with no egress restriction
      // (SSRF) for any URL outside its small static context cache. Blocks non-https and literal
      // loopback/private/link-local addresses; does NOT resolve hostnames via DNS, so DNS rebinding is
      // still possible -- tracked separately (cloud-wallet-security-escalations.md item 16/26).
      for (const contextEntry of selfAttestedContext) {
        if ('string' === typeof contextEntry) {
          assertSafeContextUrl(contextEntry)
        } else if (
          contextEntry &&
          'object' === typeof contextEntry &&
          containsForbiddenNestedContextKeyword(contextEntry)
        ) {
          throw new BadRequestError("@context entries with a nested '@import' or '@context' are not allowed")
        }
      }

      // Any node object can carry its own local @context once the real vc context maps a field as a term
      // (credentialSubject does) -- rather than enumerate fields, scan the rest of the payload (excluding
      // @context itself, already validated above) for a nested '@context'/'@import' key at any depth.
      const restOfPayload: Record<string, unknown> = { ...selfAttestedCredentialOptions }
      delete restOfPayload['@context']
      if (containsForbiddenNestedContextKeyword(restOfPayload)) {
        throw new BadRequestError("credential fields may not contain a nested '@import' or '@context' key")
      }

      // Checked against undefined, not truthiness -- '' && ... would skip this and the default below, letting an empty string reach the signer. Date.parse('') is NaN, so this catches it once fixed.
      if (undefined !== selfAttestedExpirationDate && Number.isNaN(Date.parse(selfAttestedExpirationDate))) {
        throw new BadRequestError(`expirationDate '${selfAttestedExpirationDate}' is not a valid date`)
      }
      // W3cCredential's constructor always sets expirationDate (even to undefined), and the issuer checks
      // 'expirationDate' in credential rather than truthiness -- a real date is required, so default to
      // 100 years out when the caller doesn't ask for a real expiry, and normalize a caller-supplied date
      // to ISO 8601 (Date.parse accepts far more formats than that).
      const selfAttestedExpiration =
        undefined !== selfAttestedExpirationDate
          ? new Date(selfAttestedExpirationDate).toISOString()
          : new Date(Date.now() + SELF_ATTESTED_DEFAULT_EXPIRATION_MS).toISOString()

      const toSubject = (subject: JsonObject): W3cCredentialSubjectOptions => ({
        id: selfDid,
        claims: subject,
      })
      const selfAttestedSubject: SingleOrArray<W3cCredentialSubjectOptions> = Array.isArray(selfAttestedSubjectOptions)
        ? selfAttestedSubjectOptions.map(toSubject)
        : toSubject(selfAttestedSubjectOptions)
      const selfAttestedW3cCredential: W3cCredentialOptions = {
        // id always generated (not caller-supplied): an undefined id reaches jsonld-signatures as literal @id: undefined and fails canonicalization before signing even checks the proof purpose.
        id: `urn:uuid:${randomUUID()}`,
        context: selfAttestedContext,
        type: selfAttestedType,
        issuer: selfDid,
        issuanceDate: new Date().toISOString(),
        expirationDate: selfAttestedExpiration,
        credentialSubject: selfAttestedSubject,
      }
      const selfAttestedJsonLdCredential: W3cJsonLdSignCredentialOptions = {
        format: ClaimFormat.LdpVc,
        credential: new W3cCredential(selfAttestedW3cCredential),
        proofType: selfAttestedProofType,
        verificationMethod: selfDidVerificationMethod,
      }
      // Sanitized catch around signCredential specifically: it can reach attacker-chosen/internal
      // addresses via the caller-controlled @context (SSRF), and the outer catch's generic branch
      // serializes error.message verbatim -- that would turn failures into a probing oracle.
      let signedCred
      try {
        signedCred = await request.agent.w3cCredentials.signCredential(selfAttestedJsonLdCredential)
      } catch (signError) {
        request.agent.config.logger.error(
          `[AgentController] createW3cSelfAttestedCredential: signCredential failed for DID '${selfDid}': ${signError}`,
        )
        throw new Error('Failed to sign the self-attested credential')
      }
      const selfAttestedStoredCredential = await request.agent.w3cCredentials.store({
        record: W3cCredentialRecord.fromCredential(signedCred),
      })
      return {
        ...JsonTransformer.toJSON(selfAttestedStoredCredential),
        credential: JsonTransformer.toJSON(selfAttestedStoredCredential.firstCredential),
        // Cast to SelfAttestedW3cCredentialResponse: JsonTransformer.toJSON<T>() is typed Record<string, any> regardless of T, but the spread genuinely carries BaseRecord/W3cCredentialRecord's real fields.
      } as SelfAttestedW3cCredentialResponse
    } catch (error) {
      throw ErrorHandlingService.handle(error)
    }
  }
}
