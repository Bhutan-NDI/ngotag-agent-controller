import type { VerifyDataOptions } from '../controllers/types'
import type { DidsApi, Kms } from '@credo-ts/core'

import { TypedArrayEncoder, getPublicJwkFromVerificationMethod } from '@credo-ts/core'

import { BadRequestError } from '../errors'

/**
 * Verify a challenge signature against every key in the holder's DID `authentication`
 * relationship.
 *
 * - The verification key is always resolved from the DID Document server-side; any
 *   `publicKeyBase58` supplied by the caller is deliberately ignored.
 * - Only `authentication`-relationship keys are tried — falling back to `assertionMethod`
 *   or `verificationMethod` would violate purpose-scoping in the DID Core spec.
 * - All authentication methods are tried; returns `true` on the first successful verify
 *   so that DID Documents with multiple auth keys (e.g. did:web, did:peer) are handled
 *   correctly. For did:key there is always exactly one authentication entry.
 * - `data` and `signature` are standard base64 encoded (matches the mobile wallet contract).
 */
export async function verifyDidBoundSignature(
  dids: DidsApi,
  kms: Kms.KeyManagementApi,
  options: VerifyDataOptions,
): Promise<boolean> {
  const { did, data, signature } = options

  if (!did) throw new BadRequestError('Missing "did" to resolve the verification key')
  if (!data) throw new BadRequestError('Missing "data" to verify')
  if (!signature) throw new BadRequestError('Missing "signature" to verify')

  const didDocument = await dids.resolveDidDocument(did)

  const authEntries = didDocument.authentication
  if (!authEntries || authEntries.length === 0) {
    throw new BadRequestError(`DID document for "${did}" has no authentication verification method`)
  }

  const dataBytes = TypedArrayEncoder.fromBase64(data)
  const signatureBytes = TypedArrayEncoder.fromBase64(signature)

  for (const entry of authEntries) {
    const vm = typeof entry === 'string' ? didDocument.dereferenceVerificationMethod(entry) : entry
    const publicJwk = getPublicJwkFromVerificationMethod(vm)
    const result = await kms.verify({
      key: { publicJwk: publicJwk.toJson() },
      algorithm: publicJwk.signatureAlgorithm,
      data: dataBytes,
      signature: signatureBytes,
    })
    if (result.verified) return true
  }

  return false
}
