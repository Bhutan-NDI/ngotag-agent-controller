import type { DidDocument, SignatureSuiteRegistry, VerificationMethod } from '@credo-ts/core'

import { getPublicJwkFromVerificationMethod } from '@credo-ts/core'

// Picks the key a DID should sign with. The first entry is not always usable: a did:ethr
// document lists `#controller` (EcdsaSecp256k1RecoveryMethod2020, only a blockchainAccountId)
// before `#controllerKey` (EcdsaSecp256k1VerificationKey2019, the actual public key), and
// nothing can sign with an entry that carries no public key.

type DidDocumentLike = Pick<DidDocument, 'assertionMethod' | 'verificationMethod'> & {
  dereferenceVerificationMethod?: DidDocument['dereferenceVerificationMethod']
}
type VerificationMethodEntry = string | VerificationMethod

export interface SelectedVerificationMethod {
  id: string
  // Undefined when a string reference could not be dereferenced against the document.
  verificationMethod?: VerificationMethod
}

const resolveEntry = (
  didDocument: DidDocumentLike,
  entry: VerificationMethodEntry,
): SelectedVerificationMethod | undefined => {
  if ('string' === typeof entry) {
    try {
      return { id: entry, verificationMethod: didDocument.dereferenceVerificationMethod?.(entry) }
    } catch {
      return { id: entry }
    }
  }
  return entry?.id ? { id: entry.id, verificationMethod: entry } : undefined
}

export const hasPublicKeyMaterial = (verificationMethod: VerificationMethod): boolean =>
  Boolean(
    verificationMethod.publicKeyBase58 ||
    verificationMethod.publicKeyJwk ||
    verificationMethod.publicKeyMultibase ||
    verificationMethod.publicKeyHex ||
    verificationMethod.publicKeyBase64 ||
    verificationMethod.publicKeyPem,
  )

/**
 * The assertionMethod entry to sign with for a proof type: the first one whose type the suite
 * lists, else the first one that still might sign (it carries a public key, or its type cannot be
 * read), leaving the signer to judge it as before. Entries with no public key are never chosen.
 * @param acceptedTypes the suite's verification method types
 * @returns undefined when every entry is keyless
 */
export function selectAssertionMethod(
  didDocument: DidDocumentLike,
  acceptedTypes: readonly string[],
): SelectedVerificationMethod | undefined {
  const entries = (didDocument.assertionMethod ?? [])
    .map((entry) => resolveEntry(didDocument, entry))
    .filter((entry): entry is SelectedVerificationMethod => undefined !== entry)
  const matching = entries.find(
    ({ verificationMethod }) => verificationMethod && acceptedTypes.includes(verificationMethod.type),
  )
  return (
    matching ??
    entries.find(({ verificationMethod }) => !verificationMethod?.type || hasPublicKeyMaterial(verificationMethod))
  )
}

/**
 * Whether the key in a verification method can sign the proof type: the signer's own key-type check
 * (W3cJsonLdCredentialService.signCredential), run before signing so a misfit is a clear 400 rather
 * than a generic signing failure. False when the method's key cannot be read.
 */
export function keyFitsProofType(
  registry: Pick<SignatureSuiteRegistry, 'getByProofType' | 'getAllByPublicJwkType'>,
  verificationMethod: VerificationMethod,
  proofType: string,
): boolean {
  try {
    const { suiteClass } = registry.getByProofType(proofType)
    return registry
      .getAllByPublicJwkType(getPublicJwkFromVerificationMethod(verificationMethod))
      .some((suite) => suite.suiteClass === suiteClass)
  } catch {
    return false
  }
}

/** The first entry of a relationship that carries a public key, skipping keyless ones. */
export function firstVerificationMethodWithKey(
  didDocument: DidDocumentLike,
  relationship: 'assertionMethod' | 'verificationMethod',
): VerificationMethod | undefined {
  for (const entry of didDocument[relationship] ?? []) {
    const verificationMethod = resolveEntry(didDocument, entry)?.verificationMethod
    if (verificationMethod && hasPublicKeyMaterial(verificationMethod)) {
      return verificationMethod
    }
  }
  return undefined
}
