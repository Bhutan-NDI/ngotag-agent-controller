/** P-256 group order and half of it. */
const P256_N = BigInt('0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551')
const HALF_N = P256_N >> BigInt(1)

const toBigInt = (bytes: Uint8Array): bigint => BigInt(`0x${Buffer.from(bytes).toString('hex')}`)

/**
 * Normalises a raw ES256 signature (r||s, 64 bytes) to low-S, as the brief requires. Askar returns a random S, so about
 * half of its signatures are high-S. The Prepare and Show witnesses accept either half (checked in openacSdkPatch.spec),
 * so this is defensive: it keeps the signature canonical in case the proving step is stricter than the witness.
 */
export const normalizeLowS = (signature: Uint8Array): Uint8Array => {
  if (signature.length !== 64) throw new Error(`Expected a 64-byte raw r||s signature, got ${signature.length} bytes`)
  const s = toBigInt(signature.subarray(32))
  if (s <= HALF_N) return Uint8Array.from(signature)
  const flipped = Buffer.from((P256_N - s).toString(16).padStart(64, '0'), 'hex')
  return Uint8Array.from(Buffer.concat([Buffer.from(signature.subarray(0, 32)), flipped]))
}

/** base64url of the low-S normalised signature, the form `present({ deviceSignature })` takes. */
export const toDeviceSignature = (signature: Uint8Array): string =>
  Buffer.from(normalizeLowS(signature)).toString('base64url')
