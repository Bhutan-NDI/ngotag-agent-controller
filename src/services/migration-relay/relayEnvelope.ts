import { JsonEncoder, Kms, TypedArrayEncoder } from '@credo-ts/core'

const MAX_RECIPIENTS = 16
// The protected header is base64url, so it can never contain a quote or backslash: a flat scan finds it without
// parsing a body of up to 5 MB, which the transport parses again straight afterwards.
const PROTECTED_PATTERN = /"protected"\s*:\s*"([A-Za-z0-9_-]+)"/

/**
 * Recipient key fingerprints of a DIDComm v1 JWE, computed exactly as Credo's tenant routing does (base58 Ed25519
 * `kid` -> public key -> fingerprint), so they match the fingerprints stored in TenantRoutingRecords. Never throws:
 * anything that is not a readable JWE yields no fingerprints and is left to Credo.
 */
export const extractRecipientFingerprints = (rawBody: unknown): string[] => {
  if ('string' !== typeof rawBody) return []
  const match = PROTECTED_PATTERN.exec(rawBody)
  if (!match) return []

  let header: unknown
  try {
    header = JsonEncoder.fromBase64(match[1])
  } catch {
    return []
  }
  const recipients = (header as { recipients?: unknown })?.recipients
  if (!Array.isArray(recipients)) return []

  const fingerprints = new Set<string>()
  for (const recipient of recipients.slice(0, MAX_RECIPIENTS)) {
    const kid = (recipient as { header?: { kid?: unknown } })?.header?.kid
    if ('string' !== typeof kid) continue
    try {
      fingerprints.add(
        Kms.PublicJwk.fromPublicKey({
          crv: 'Ed25519',
          kty: 'OKP',
          publicKey: TypedArrayEncoder.fromBase58(kid),
        }).fingerprint,
      )
    } catch {
      // not a base58 Ed25519 key: nothing for the relay to route on
    }
  }
  return [...fingerprints]
}
