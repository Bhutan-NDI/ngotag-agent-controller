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
import { verifyDidBoundSignature } from '../../utils/didSignatureVerification'

// 100 years: effectively non-expiring default for a self-attested credential whose caller didn't
// request a real expiry. See createW3cSelfAttestedCredential's own comment for why some value is
// unavoidable here regardless of caller intent.
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
    (169 === a && 254 === b) || // 169.254.0.0/16 (link-local, incl. cloud metadata endpoints)
    (172 === a && 16 <= b && 31 >= b) || // 172.16.0.0/12 (private)
    (192 === a && 168 === b) // 192.168.0.0/16 (private)
  )
}

// Node's URL parser canonicalizes an IPv4-mapped IPv6 address to hex-group form (e.g.
// ::ffff:127.0.0.1 -> ::ffff:7f00:1, since 0x7f00 0x0001 = 127.0.0.1), not the dotted-quad form
// -- so a naive string-suffix check for "127.0.0.1" never matches what actually reaches this
// function. Extract the address either way.
function ipv4MappedToIPv4(ip: string): string | undefined {
  const dotted = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(ip)
  if (dotted) {
    return dotted[1]
  }
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(ip)
  if (!hex) {
    return undefined
  }
  const high = parseInt(hex[1], 16)
  const low = parseInt(hex[2], 16)
  return [(high >> 8) & 0xff, 0xff & high, (low >> 8) & 0xff, 0xff & low].join('.')
}

function isPrivateOrLoopbackIPv6(ip: string): boolean {
  const lower = ip.toLowerCase()
  if ('::1' === lower || lower.startsWith('fe80:') || lower.startsWith('fc') || lower.startsWith('fd')) {
    return true // loopback, link-local, or unique-local (fc00::/7)
  }
  // IPv4-mapped IPv6 (e.g. ::ffff:127.0.0.1) -- a known SSRF filter bypass if not unwrapped.
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
  // URL.hostname keeps the brackets around an IPv6 literal (e.g. "[::1]") -- isIP() and the
  // range checks below both expect the bare address.
  const rawHostname = parsed.hostname.toLowerCase()
  const hostname = rawHostname.startsWith('[') ? rawHostname.slice(1, -1) : rawHostname
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
  ): Promise<SelfAttestedW3cCredentialResponse> {
    try {
      // Default DID is tracked as a tag on the DID's own DidRecord (see DidController.writeDid),
      // not a separate pointer record. Verified directly against this repo's installed
      // @credo-ts/core/@credo-ts/askar: BaseRecord.setTag accepts arbitrary tag names, and
      // AskarStorageService applies the same transformFromRecordTagValues encoding on both save
      // and query, so a query of `{ isDefault: true }` genuinely matches a DidRecord tagged that
      // way. findByQuery (not findSingleByQuery) is used deliberately: it tolerates more than one
      // tagged record rather than throwing RecordDuplicateError, since a wallet migrated from the
      // legacy stack may already carry more than one isDefault-tagged DID from before
      // DidController.writeDid started clearing the previous default on every write.
      // findByQuery applies no ordering of its own (a plain Askar scan, no createdAt sort) — for
      // a wallet carrying more than one isDefault-tagged record (the legacy-migration case the
      // comment above describes), an unordered [0] pick is whatever the store happens to return
      // first, which for Askar's rowid-ordered scan is the EARLIEST tagged record, not the one
      // DidController.writeDid's clearing loop most recently (re-)tagged. Sorting by createdAt
      // descending makes the pick deterministic and favors the DID an operator actually tagged
      // most recently over a stale, long-superseded one. See the #73 review.
      const [defaultDidRecord] = (
        await request.agent.dependencyManager.resolve(DidRepository).findByQuery(request.agent.context, {
          isDefault: true,
        })
      ).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      let selfDid = defaultDidRecord?.did

      // Fallback for wallets that have never explicitly marked a DID as default at all (no client
      // ever called POST /dids/write with isDefault: true) — the tag lookup above correctly finds
      // nothing for these regardless of storage mechanism, tag or otherwise. Only kicks in when
      // unambiguous: a tenant with exactly one created DID has an obvious "the" DID to self-issue
      // from even though it was never explicitly marked default; a tenant with more than one gets
      // the same 404 as before, since guessing among several would risk silently issuing under the
      // wrong identity.
      //
      // did:peer entries are excluded from the candidate list before that count: getCreatedDids()
      // is a role filter ("everything with role: Created"), not "DIDs the operator explicitly
      // wrote" — PeerDidRegistrar saves every DIDComm connection/mediation-routing DID with that
      // same role. A holder wallet's whole purpose is DIDComm, so having made at least one
      // connection is the common case, not the exception; without this exclusion, length === 1
      // would almost never hold for exactly the wallets this fallback exists to unblock.
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
      // Select from assertionMethod only, not by falling through to verificationMethod (or, before
      // that, authentication) when it's absent. This signs with proofPurpose: assertionMethod
      // below, and a verification method being listed under verificationMethod does not authorize
      // it for that purpose -- only an explicit assertionMethod entry does. A verificationMethod
      // (or authentication) fallback here fixes did:peer's 500 (handleDidPeer's documents have a
      // verificationMethod/authentication but no assertionMethod) by replacing it with a *worse*
      // failure: signCredential succeeds (nothing at issuance time checks the key's authorized
      // purpose), returns 200, and stores a credential that fails verification everywhere else
      // (ControllerProofPurpose.validate rejects it as "not authorized by controller for proof
      // purpose 'assertionMethod'"). A loud, immediate error here is strictly better than a
      // silently unverifiable credential persisted in a holder's wallet -- this is the same
      // reasoning an earlier pass already applied to remove the authentication fallback; a bare
      // verificationMethod fallback is not any safer. See the #73/#75 reviews. If did:peer
      // genuinely needs to be usable here, the fix belongs upstream in how the DID is created
      // (give it an assertion-capable key), not in which key is chosen at signing time.
      //
      // assertionMethod entries can legitimately be either a plain DID-URL string or an embedded
      // VerificationMethod object, hence the typeof check.
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

      // Scope-limited SSRF guard, per the #75 review: @context is caller-controlled, and any URL
      // outside CachedDocumentLoader's small static map falls through to Credo's native JSON-LD
      // loader with no egress restrictions -- an authenticated tenant could otherwise reach
      // internal/loopback/link-local services. This blocks non-https schemes and literal
      // loopback/private/link-local IP addresses before the credential is ever built. It does
      // NOT resolve hostnames via DNS, so a public-looking hostname that resolves to an internal
      // address (DNS rebinding) is not covered -- that needs a constrained loader (allowlist +
      // DNS-time resolution + redirect revalidation + timeout/size limits), tracked separately as
      // item 16/26 in cloud-wallet-security-escalations.md. This closes the immediate,
      // trivially-exploitable hole without that larger design.
      for (const contextEntry of selfAttestedContext) {
        if ('string' === typeof contextEntry) {
          assertSafeContextUrl(contextEntry)
        }
      }

      // A caller-supplied date must actually parse -- Date accepts near-anything and silently
      // yields Invalid Date otherwise, which would reach the signer as a broken expirationDate
      // string instead of a clear 400 here.
      if (selfAttestedExpirationDate && Number.isNaN(Date.parse(selfAttestedExpirationDate))) {
        throw new BadRequestError(`expirationDate '${selfAttestedExpirationDate}' is not a valid date`)
      }
      // W3cCredential's constructor always assigns its own expirationDate field, even to
      // undefined, and @digitalcredentials/vc's issuer checks `'expirationDate' in credential`
      // rather than its truthiness -- so signing throws "must be a valid date: undefined" unless
      // a real date reaches it, regardless of whether the caller wanted one. There is no way to
      // omit the field entirely given that class's behavior, so default far enough out to be
      // effectively non-expiring for a caller who didn't ask for a real expiry. See the #75 review.
      const selfAttestedExpiration =
        selfAttestedExpirationDate ?? new Date(Date.now() + SELF_ATTESTED_DEFAULT_EXPIRATION_MS).toISOString()

      const toSubject = (subject: JsonObject): W3cCredentialSubjectOptions => ({
        id: selfDid,
        claims: subject,
      })
      const selfAttestedSubject: SingleOrArray<W3cCredentialSubjectOptions> = Array.isArray(selfAttestedSubjectOptions)
        ? selfAttestedSubjectOptions.map(toSubject)
        : toSubject(selfAttestedSubjectOptions)
      const selfAttestedW3cCredential: W3cCredentialOptions = {
        // Same unconditional-class-field issue as expirationDate above: W3cCredential's
        // constructor always assigns its own `id`, and the vc/v1 @context aliases the JSON key
        // "id" to "@id" -- an undefined id reaches jsonld-signatures as a literal `@id: undefined`
        // and fails canonicalization with "'@id' value must a string" before signing even gets to
        // check the proof purpose. A caller-supplied id isn't part of this endpoint's contract
        // (self-attested credentials aren't tracked by an external id), so this is always
        // generated, not defaulted-when-absent like expirationDate. See the #75 review.
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
      // Sanitized catch around signCredential specifically (not the outer one, which still returns
      // clear, safe messages like the assertionMethod check above): CachedDocumentLoader falls
      // back to Credo's native JSON-LD loader for any @context URL outside its small static map,
      // which can reach attacker-chosen or internal addresses (SSRF) via this caller-controlled
      // field. ErrorHandlingService's generic branch serializes error.message verbatim into the
      // HTTP response, which would turn that into a probing oracle (resolved URL, HTTP status,
      // redirect/network failure detail). Log the real cause server-side; the caller only ever
      // sees a generic failure. See the #75 review.
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
        // JsonTransformer.toJSON<T>() is declared Record<string, any> regardless of T, so the
        // compiler can't verify the spread above actually carries id/createdAt/credentialInstances
        // -- it does; they're BaseRecord/W3cCredentialRecord's own real, always-present fields.
        // The cast exists only so this method's return type can be declared explicitly for tsoa
        // (see SelfAttestedW3cCredentialResponse's own comment); it isn't asserting anything the
        // runtime object doesn't already guarantee.
      } as SelfAttestedW3cCredentialResponse
    } catch (error) {
      throw ErrorHandlingService.handle(error)
    }
  }
}
