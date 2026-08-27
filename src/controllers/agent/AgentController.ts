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
    (100 === a && 64 <= b && 127 >= b) || // 100.64.0.0/10 (RFC 6598 CGNAT / shared address space)
    (169 === a && 254 === b) || // 169.254.0.0/16 (link-local, incl. cloud metadata endpoints)
    (172 === a && 16 <= b && 31 >= b) || // 172.16.0.0/12 (private)
    (192 === a && 168 === b) // 192.168.0.0/16 (private)
  )
}

// Node's URL parser canonicalizes any IPv6 address that embeds an IPv4 address to hex-group
// form, not the dotted-quad form (e.g. ::ffff:127.0.0.1 -> ::ffff:7f00:1, since 0x7f00 0x0001 =
// 127.0.0.1) -- so a naive dotted-quad string check never matches what actually reaches this
// function. Three real notations embed an IPv4 address this way, all real SSRF filter-bypass
// forms if not unwrapped: IPv4-mapped (::ffff:a.b.c.d), the deprecated IPv4-compatible form
// (::a.b.c.d, no ffff marker -- e.g. ::127.0.0.1 canonicalizes to ::7f00:1), and the NAT64/
// IPv4-translated form (::ffff:0:a.b.c.d). See the #75 review.
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
  // fe80::/10 link-local spans first-hextet 0xfe80-0xfebf (fe80::, fe90::, ..., febf:: are all
  // equally link-local) -- a literal 'fe80:' prefix match only catches the first of those and
  // misses the rest. Range-check the first hextet instead, same pattern as the IPv4 octet range
  // checks above. See the #75 review.
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
  // URL.hostname keeps the brackets around an IPv6 literal (e.g. "[::1]") -- isIP() and the
  // range checks below both expect the bare address. It also preserves trailing root dots on an
  // FQDN (e.g. "localhost." or even "localhost.." -- new URL() accepts any number of them
  // unmodified), which real DNS resolvers/HTTP clients treat identically to the same name
  // without one -- an unstripped dot is a bypass of the exact-match check below. Strips *all*
  // trailing dots, not just one. See the #75 review.
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

// See createW3cSelfAttestedCredential's SSRF-guard comment for scope. `@import` and term-scoped
// `@context` are two distinct JSON-LD 1.1 keywords that can each smuggle a URL into context
// processing from inside an object @context entry -- and term-scoped contexts can themselves
// nest further term definitions, each with their own scoped context, so this walks the whole
// entry rather than checking only its top-level keys. Only checks key *presence*, not value
// shape: neither keyword is ever legitimate here, so there's nothing further to validate once
// either is found.
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
      // findDefaultDidRecords (shared with DidController.getDids, see the #75 review) sorts by
      // createdAt descending so both endpoints agree on which of several tagged DIDs is current.
      const [defaultDidRecord] = await findDefaultDidRecords(
        request.agent.dependencyManager.resolve(DidRepository),
        request.agent.context,
      )
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
      //
      // The string-only type check below is itself a gap this guard previously had: JSON-LD 1.1
      // lets an object @context entry carry a URL two different ways -- an `@import` keyword, or a
      // term definition's own scoped `@context` (e.g. `{evilTerm: {"@context": "<url>"}}`, resolved
      // lazily whenever the term is actually used, e.g. in credentialSubject). Both are confirmed
      // (not theoretical) against the installed @digitalcredentials/jsonld, and term-scoped contexts
      // can themselves nest further term definitions with their own scoped contexts, so a shallow,
      // single-keyword check isn't enough -- containsForbiddenNestedContextKeyword walks the whole
      // entry for either keyword at any depth. Neither keyword is needed by any real caller of this
      // endpoint (real callers only ever send flat objects like {"@version": 1.1}), so any entry
      // carrying one is rejected outright rather than validated as a URL. See the #75 review.
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

      // Per the #75 review: the guard above only ever covered the top-level @context array, but
      // JSON-LD 1.1 lets *any* node object carry its own local @context key once the real vc/v1 or
      // vc/v2 context maps it as a term -- credentialSubject is exactly such a node object (spread
      // into `claims` below with no filtering), and there's no principled reason to assume it's the
      // only field capable of that. Rather than keep enumerating fields one at a time as each new
      // one is found, this scans the rest of the payload (everything except @context itself, which
      // already has its own more precise scheme/host validation above -- a blanket keyword ban
      // there would also reject the real https URLs this endpoint needs to allow) for a nested
      // '@context'/'@import' key at any depth, regardless of which field it's under.
      const restOfPayload: Record<string, unknown> = { ...selfAttestedCredentialOptions }
      delete restOfPayload['@context']
      if (containsForbiddenNestedContextKeyword(restOfPayload)) {
        throw new BadRequestError("credential fields may not contain a nested '@import' or '@context' key")
      }

      // A caller-supplied date must actually parse -- Date accepts near-anything and silently
      // yields Invalid Date otherwise, which would reach the signer as a broken expirationDate
      // string instead of a clear 400 here. Checked against `undefined` specifically, not
      // truthiness: `selfAttestedExpirationDate && ...` would let an empty string skip this
      // check entirely (`'' &&` short-circuits), then also skip the `??` default below (which
      // only coalesces null/undefined, not ''), reaching the signer as a literal empty string.
      // Date.parse('') is itself NaN, so this same check catches it once the truthiness gate is
      // gone. See the #75 review.
      if (undefined !== selfAttestedExpirationDate && Number.isNaN(Date.parse(selfAttestedExpirationDate))) {
        throw new BadRequestError(`expirationDate '${selfAttestedExpirationDate}' is not a valid date`)
      }
      // W3cCredential's constructor always assigns its own expirationDate field, even to
      // undefined, and @digitalcredentials/vc's issuer checks `'expirationDate' in credential`
      // rather than its truthiness -- so signing throws "must be a valid date: undefined" unless
      // a real date reaches it, regardless of whether the caller wanted one. There is no way to
      // omit the field entirely given that class's behavior, so default far enough out to be
      // effectively non-expiring for a caller who didn't ask for a real expiry. See the #75 review.
      //
      // A caller-supplied date is normalized to ISO 8601 via `new Date(...).toISOString()`,
      // not embedded verbatim: it's already confirmed parseable above, but Date.parse accepts
      // far more formats than ISO 8601 (e.g. "08/26/2026"), and every issued credential should
      // carry a spec-compliant date regardless of what format the caller sent. See the #75 review.
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
