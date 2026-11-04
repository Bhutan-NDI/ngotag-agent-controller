import type { EcdsaPublicKey } from 'openac-sdk'

/** Two P-256 public keys are the same issuer when kty, crv, x and y match. `kid` and other members are ignored. */
export const sameIssuerKey = (a: Pick<EcdsaPublicKey, 'kty' | 'crv' | 'x' | 'y'>, b: typeof a): boolean =>
  a.kty === b.kty && a.crv === b.crv && a.x === b.x && a.y === b.y

export const isTrustedIssuer = (
  issuerKey: Pick<EcdsaPublicKey, 'kty' | 'crv' | 'x' | 'y'>,
  trusted: readonly Pick<EcdsaPublicKey, 'kty' | 'crv' | 'x' | 'y'>[],
): boolean => trusted.some((t) => sameIssuerKey(issuerKey, t))
