import type {
  OpenAcChallengeRequest,
  OpenAcChallengeResponse,
  OpenAcPrecomputeRequest,
  OpenAcPrecomputeResponse,
  OpenAcPresentRequest,
  OpenAcTrustedIssuerRequest,
  OpenAcTrustedIssuerResponse,
  OpenAcProof,
  OpenAcVerifyRequest,
  OpenAcVerifyResponse,
} from './openac.types'
import type { Request as Req } from 'express'
import type { EcdsaPublicKey, PrecomputedCredential } from 'openac-sdk'

import { Kms, TypedArrayEncoder } from '@credo-ts/core'

import { BadRequestError, NotFoundError } from '../../errors/errors'

import { toDeviceSignature } from './deviceSignature'
import { findHolderKeyId } from './holderKeyRegistry'
import { NonceStore } from './nonceStore'
import { BIRTH_CLAIM, isSupportedPolicy, policyPredicate } from './openacPolicy'
import { getOpenAcRuntime } from './openacSdk'
import { isTrustedIssuer } from './trustedIssuers'

type AgentType = Req['agent']
type IssuerKey = Pick<EcdsaPublicKey, 'kty' | 'crv' | 'x' | 'y'>

const tenantScope = (agent: AgentType): string => agent.context.contextCorrelationId

const requirePolicy = (policy: unknown) => {
  if (!isSupportedPolicy(policy)) throw new BadRequestError(`Unsupported policy: ${String(policy)}`)
  return policy
}

const decodeSegment = (segment: string): unknown => JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'))

/**
 * OpenAC PoC: the holder (precompute, present) and verifier (challenge, verify) sides, each running as the tenant agent
 * of the request. In memory state (nonces, precomputed credentials) is lost on restart and is single instance only.
 */
export class OpenAcService {
  public readonly nonces = new NonceStore()
  // key: `${tenant}:${credentialId}`. Holds Prepare proofs: bearer-credential grade data, so never persisted or logged.
  private readonly precomputed = new Map<string, PrecomputedCredential>()

  // Registered at runtime by the verifier tenant itself: tenant -> did -> issuer key. In memory, like the nonces.
  private readonly registeredIssuers = new Map<string, Map<string, IssuerKey>>()

  /**
   * Trusted issuers for this verifier: the dids registered by this tenant through the route, plus the deployment wide
   * seed in OPENAC_TRUSTED_ISSUER_DIDS (comma separated did:key). Keys are resolved by the verifier's own agent from a
   * did the verifier supplied, never from anything in a proof. Empty means nothing is trusted.
   */
  public async trustedIssuerKeys(agent: AgentType): Promise<IssuerKey[]> {
    const seed = (process.env.OPENAC_TRUSTED_ISSUER_DIDS ?? '')
      .split(',')
      .map((d) => d.trim())
      .filter(Boolean)
    const seeded = await Promise.all(seed.map((did) => this.issuerKeyFromDid(agent, did)))
    return [...seeded, ...(this.registeredIssuers.get(tenantScope(agent))?.values() ?? [])]
  }

  public async registerTrustedIssuer(req: Req, body: OpenAcTrustedIssuerRequest): Promise<OpenAcTrustedIssuerResponse> {
    if (!body?.did) throw new BadRequestError('did is required')
    const key = await this.issuerKeyFromDid(req.agent, body.did)
    const scope = tenantScope(req.agent)
    const forTenant = this.registeredIssuers.get(scope) ?? new Map<string, IssuerKey>()
    forTenant.set(body.did, key)
    this.registeredIssuers.set(scope, forTenant)
    return { did: body.did, trustedIssuers: forTenant.size }
  }

  private async issuerKeyFromDid(agent: AgentType, did: string): Promise<IssuerKey> {
    const resolved = await agent.dids.resolveDidDocument(did)
    // Same rule as src/utils/oid4vc-agent.ts: the first verification method signs.
    const jwk = resolved.verificationMethod?.[0]?.publicKeyJwk as Record<string, string> | undefined
    if (!jwk || jwk.kty !== 'EC' || jwk.crv !== 'P-256') {
      throw new BadRequestError(`${did} does not resolve to a P-256 key (OpenAC needs ES256 issuers)`)
    }
    return { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y }
  }

  // --- verifier ---------------------------------------------------------------------------------------------------

  public createChallenge(req: Req, body: OpenAcChallengeRequest): OpenAcChallengeResponse {
    const policy = requirePolicy(body.policy)
    const { nonce, expiresAt } = this.nonces.issue(tenantScope(req.agent), policy)
    return { nonce, expiresAt: expiresAt.toISOString(), policy }
  }

  public async verify(req: Req, body: OpenAcVerifyRequest): Promise<OpenAcVerifyResponse> {
    const reject = (reason: string): OpenAcVerifyResponse => ({ accepted: false, over18: false, reason })

    if (!body?.nonce || !body.proof) throw new BadRequestError('nonce and proof are required')

    // Burns the nonce whatever happens next, so a failed attempt cannot be retried with it.
    const consumed = this.nonces.consume(tenantScope(req.agent), body.nonce)
    if (consumed.result === 'used') return reject('nonce already used')
    if (consumed.result === 'unknown') return reject('unknown nonce')
    if (consumed.result === 'expired') return reject('nonce expired')
    const policy = requirePolicy(consumed.policy) // the policy the verifier issued with this nonce, not the holder's

    const trusted = await this.trustedIssuerKeys(req.agent)
    if (trusted.length === 0) return reject('no trusted issuers are registered for this verifier')

    const { sdk, openac, keys } = await getOpenAcRuntime()

    // The verifier compiles its own statement. Slot 0 is the policy claim, which is where the holder puts it.
    const compiled = sdk.compilePredicateExpression(policyPredicate(policy), [
      { index: 0, name: BIRTH_CLAIM, salt: '', value: '', raw: '', digest: '' },
    ])
    const expected = {
      nonce: body.nonce,
      predicates: compiled.predicates,
      logicExpression: compiled.logicExpression,
      claimNormalization: sdk.requiredNormalization(compiled),
      trustedIssuers: trusted as EcdsaPublicKey[],
    }

    let result
    try {
      const p = body.proof
      result = await openac.verify(
        {
          prepareProof: sdk.base64Decode(p.prepareProof),
          showProof: sdk.base64Decode(p.showProof),
          prepareInstance: sdk.base64Decode(p.prepareInstance),
          showInstance: sdk.base64Decode(p.showInstance),
        } as never,
        keys.verifyingKeys(),
        expected,
      )
    } catch (error) {
      return reject(`proof could not be verified: ${error instanceof Error ? error.message : String(error)}`)
    }

    if (!result.valid || !result.issuerKey)
      return reject(result.error ?? 'proof is not valid for this nonce and policy')
    // The SDK reports the issuer; it does not decide. Checked here too, independently of `trustedIssuers` above.
    if (!isTrustedIssuer(result.issuerKey.jwk, trusted)) return reject('credential issuer is not trusted')

    // The verifier's own result. `proof.publicValues.expressionResult` is holder supplied and is not read.
    return { accepted: true, over18: result.expressionResult === true }
  }

  // --- holder -----------------------------------------------------------------------------------------------------

  public async precompute(req: Req, body: OpenAcPrecomputeRequest): Promise<OpenAcPrecomputeResponse> {
    const policy = requirePolicy(body.policy)
    if (!body.credentialId) throw new BadRequestError('credentialId is required')
    const started = Date.now()
    await this.precomputeCredential(req.agent, body.credentialId, policy)
    return { ok: true, durationMs: Date.now() - started }
  }

  public async present(req: Req, body: OpenAcPresentRequest): Promise<OpenAcProof> {
    const policy = requirePolicy(body.policy)
    if (!body.credentialId || !body.nonce) throw new BadRequestError('credentialId and nonce are required')
    const agent = req.agent
    const { openac, keys } = await getOpenAcRuntime()

    const key = `${tenantScope(agent)}:${body.credentialId}`
    const precomputed = this.precomputed.get(key) ?? (await this.precomputeCredential(agent, body.credentialId, policy))

    // The holder key lives in Askar and cannot be exported, so Askar signs the nonce and the SDK takes the signature.
    const keyId = await this.holderKeyId(agent, body.credentialId, precomputed)
    const { signature } = await agent.context.resolve(Kms.KeyManagementApi).sign({
      keyId,
      algorithm: 'ES256',
      data: TypedArrayEncoder.fromString(body.nonce),
    })

    const proof = await openac.present({
      precomputed,
      verifierNonce: body.nonce,
      deviceSignature: toDeviceSignature(signature),
      keys,
      predicates: policyPredicate(policy),
    })
    agent.config.logger.info('OpenAC present', { ...proof.timing })
    return proof.toJSON() as unknown as OpenAcProof
  }

  /**
   * The registry (written when the key was created, matched on the cnf.jwk thumbprint) is authoritative. Credo also
   * stores a `kmsKeyId` on the credential record, used when the registry has no entry, e.g. a credential issued before
   * the registry existed.
   */
  private async holderKeyId(agent: AgentType, credentialId: string, precomputed: PrecomputedCredential) {
    try {
      return await findHolderKeyId(agent.context, precomputed.deviceKey)
    } catch (error) {
      if (!(error instanceof NotFoundError)) throw error
      const record = await agent.sdJwtVc.getById(credentialId)
      const kmsKeyId = record.credentialInstances[0].kmsKeyId
      if (!kmsKeyId) throw error
      return kmsKeyId
    }
  }

  private async precomputeCredential(
    agent: AgentType,
    credentialId: string,
    policy: 'over18',
  ): Promise<PrecomputedCredential> {
    const record = await agent.sdJwtVc.getById(credentialId).catch(() => null)
    if (!record) throw new NotFoundError(`SD-JWT credential ${credentialId} not found`)

    // compact SD-JWT: <jwt>~<disclosure>~...~[<kb-jwt>]
    const [jwt, ...rest] = record.credentialInstances[0].compactSdJwtVc.split('~')
    const disclosures = rest.filter(Boolean)
    const payload = decodeSegment(jwt.split('.')[1]) as { iss?: string }
    if (!payload.iss) throw new BadRequestError('Credential has no iss')

    // The circuit addresses claims by position. The verifier's statement reads the policy claim at slot 0, so the
    // holder puts it first. Disclosure order is free in SD-JWT, the digests live in the signed JWT.
    const ordered = [...disclosures].sort(
      (a, b) =>
        Number((decodeSegment(b) as string[])[1] === BIRTH_CLAIM) -
        Number((decodeSegment(a) as string[])[1] === BIRTH_CLAIM),
    )
    if ((decodeSegment(ordered[0]) as string[])[1] !== BIRTH_CLAIM) {
      throw new BadRequestError(`Credential has no ${BIRTH_CLAIM} disclosure`)
    }

    const { openac, keys } = await getOpenAcRuntime()
    const started = Date.now()
    const precomputed = await openac.precompute({
      jwt,
      disclosures: ordered,
      issuerPublicKey: await this.issuerKeyFromDid(agent, payload.iss),
      keys,
      predicates: policyPredicate(policy),
    })
    agent.config.logger.info('OpenAC precompute', { ...precomputed.timing, wallMs: Date.now() - started })
    this.precomputed.set(`${tenantScope(agent)}:${credentialId}`, precomputed)
    return precomputed
  }
}

export const openAcService = new OpenAcService()
