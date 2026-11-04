/** Request and response shapes for the OpenAC PoC routes. */

export type OpenAcPolicyName = 'over18'

export interface OpenAcChallengeRequest {
  policy: OpenAcPolicyName
}

export interface OpenAcChallengeResponse {
  /** 32 random bytes, base64url. Single use. */
  nonce: string
  /** ISO 8601 time after which the nonce is rejected (2 minutes after issue). */
  expiresAt: string
  policy: OpenAcPolicyName
}

export interface OpenAcPrecomputeRequest {
  /** Id of the SD-JWT VC record in the holder wallet */
  credentialId: string
  policy: OpenAcPolicyName
}

export interface OpenAcPrecomputeResponse {
  ok: boolean
  durationMs: number
}

export interface OpenAcPresentRequest {
  credentialId: string
  /** The nonce from the verifier's challenge */
  nonce: string
  policy: OpenAcPolicyName
}

/** The proof, as `PresentationProof.toJSON()` from openac-sdk. The four proof fields are standard base64. */
export interface OpenAcProof {
  version: string
  prepareProof: string
  showProof: string
  prepareInstance: string
  showInstance: string
  /** Computed by the holder. The verifier ignores it and uses its own verification result. */
  publicValues?: { expressionResult?: boolean }
}

export interface OpenAcVerifyRequest {
  nonce: string
  proof: OpenAcProof
}

export interface OpenAcVerifyResponse {
  /** The proof is valid for this nonce and policy, and the credential was issued by a trusted issuer. */
  accepted: boolean
  /** The policy result. Only meaningful when `accepted` is true. */
  over18: boolean
  /** Why the proof was not accepted. */
  reason?: string
}

export interface OpenAcTrustedIssuerRequest {
  /** A did:key (P-256) whose first verification method is an issuer key this verifier trusts */
  did: string
}

export interface OpenAcTrustedIssuerResponse {
  did: string
  /** How many issuers this verifier now trusts through this route */
  trustedIssuers: number
}
