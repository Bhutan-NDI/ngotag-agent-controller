import type { VerifyDataOptions } from '../controllers/types'
import type { DidDocument, DidsApi, Kms, VerificationMethod } from '@credo-ts/core'

import { TypedArrayEncoder, getPublicJwkFromVerificationMethod } from '@credo-ts/core'

import { BadRequestError } from '../errors'

/**
 * Resolve the verification method that should be used to authenticate the holder.
 *
 * Prefers the first `authentication` relationship, falling back to `assertionMethod`
 * and finally any `verificationMethod`. String references are dereferenced against
 * the DID Document.
 */
function getAuthenticationVerificationMethod(didDocument: DidDocument): VerificationMethod {
  const entry = didDocument.authentication?.[0] ?? didDocument.assertionMethod?.[0]
  if (entry) {
    return typeof entry === 'string' ? didDocument.dereferenceVerificationMethod(entry) : entry
  }

  const verificationMethod = didDocument.verificationMethod?.[0]
  if (!verificationMethod) {
    throw new BadRequestError(`DID document for "${didDocument.id}" has no usable verification method`)
  }
  return verificationMethod
}

/**
 * Verify an Ed25519 challenge signature using the key bound to the holder's DID.
 *
 * The public key is resolved from the DID Document (self-certifying for did:key) and
 * the signature is verified against it. Any `publicKeyBase58` supplied by the caller is
 * deliberately ignored, so a caller cannot impersonate a DID by presenting their own key.
 *
 * `data` and `signature` are base64 encoded (matches the mobile wallet contract).
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
  const verificationMethod = getAuthenticationVerificationMethod(didDocument)
  const publicJwk = getPublicJwkFromVerificationMethod(verificationMethod)

  const result = await kms.verify({
    key: { publicJwk: publicJwk.toJson() },
    algorithm: publicJwk.signatureAlgorithm,
    data: TypedArrayEncoder.fromBase64(data),
    signature: TypedArrayEncoder.fromBase64(signature),
  })

  return result.verified
}
