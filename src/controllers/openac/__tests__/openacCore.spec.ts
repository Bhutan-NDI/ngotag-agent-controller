/**
 * The pure parts of the OpenAC PoC: low-S normalisation, nonce TTL and replay, the issuer trust check, the over18 cutoff.
 */
import { generateKeyPairSync, sign, verify } from 'crypto'

import { normalizeLowS, toDeviceSignature } from '../deviceSignature'
import { NONCE_TTL_MS, NonceStore } from '../nonceStore'
import { cutoffYmd, isSupportedPolicy, policyPredicate } from '../openacPolicy'
import { isTrustedIssuer, sameIssuerKey } from '../trustedIssuers'

const P256_N = BigInt('0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551')
const HALF_N = P256_N >> BigInt(1)
const sOf = (sig: Uint8Array) => BigInt(`0x${Buffer.from(sig.subarray(32)).toString('hex')}`)

describe('normalizeLowS', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const message = Buffer.from('nonce')
  const raw = () => sign('sha256', message, { key: privateKey, dsaEncoding: 'ieee-p1363' })

  // Node's OpenSSL happens to return low-S, Askar does not (about half are high-S), so make high-S inputs explicitly:
  // (r, n - s) is an equally valid signature for the same message.
  const highS = (sig: Uint8Array) => {
    const flipped = Buffer.from((P256_N - sOf(sig)).toString(16).padStart(64, '0'), 'hex')
    return Buffer.concat([Buffer.from(sig.subarray(0, 32)), flipped])
  }

  // The two halves of a signature's S, regardless of what the local OpenSSL returns.
  const lowOf = (sig: Uint8Array) => (sOf(sig) > HALF_N ? highS(sig) : Buffer.from(sig))
  const highOf = (sig: Uint8Array) => (sOf(sig) <= HALF_N ? highS(sig) : Buffer.from(sig))

  it('turns high-S signatures into low-S, over many random signatures', () => {
    for (let i = 0; i < 200; i++) {
      const high = highOf(raw())
      expect(sOf(high) > HALF_N).toBe(true)
      expect(sOf(normalizeLowS(high)) <= HALF_N).toBe(true)
    }
  })

  it('leaves a low-S signature unchanged', () => {
    const sig = lowOf(raw())
    expect(sOf(sig) <= HALF_N).toBe(true)
    expect(Buffer.from(normalizeLowS(sig)).equals(sig)).toBe(true)
  })

  it('keeps the signature valid for the same key and message', () => {
    for (let i = 0; i < 50; i++) {
      const input = highOf(raw())
      expect(verify('sha256', message, { key: publicKey, dsaEncoding: 'ieee-p1363' }, input)).toBe(true) // valid before
      const normalized = Buffer.from(normalizeLowS(input))
      expect(verify('sha256', message, { key: publicKey, dsaEncoding: 'ieee-p1363' }, normalized)).toBe(true) // and after
    }
  })

  it('rejects anything that is not 64 bytes', () => {
    expect(() => normalizeLowS(new Uint8Array(70))).toThrow('64-byte')
  })

  it('toDeviceSignature is base64url of 64 bytes', () => {
    const out = toDeviceSignature(raw())
    expect(out).toMatch(/^[A-Za-z0-9_-]{86}$/)
    expect(Buffer.from(out, 'base64url')).toHaveLength(64)
  })
})

describe('NonceStore', () => {
  let now = 1_000_000
  const store = () => new NonceStore(() => now)
  beforeEach(() => {
    now = 1_000_000
  })

  it('issues 32-byte base64url nonces that expire after 2 minutes', () => {
    const { nonce, expiresAt } = store().issue('verifier-a', 'over18')
    expect(nonce).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(expiresAt.getTime()).toBe(now + 2 * 60 * 1000)
    expect(NONCE_TTL_MS).toBe(120_000)
  })

  it('accepts a fresh nonce once and returns its policy', () => {
    const s = store()
    const { nonce } = s.issue('verifier-a', 'over18')
    expect(s.consume('verifier-a', nonce)).toEqual({ result: 'ok', policy: 'over18' })
  })

  it('rejects a reused nonce', () => {
    const s = store()
    const { nonce } = s.issue('verifier-a', 'over18')
    s.consume('verifier-a', nonce)
    expect(s.consume('verifier-a', nonce).result).toBe('used')
  })

  it('rejects an expired nonce, and burns it', () => {
    const s = store()
    const { nonce } = s.issue('verifier-a', 'over18')
    now += NONCE_TTL_MS + 1
    expect(s.consume('verifier-a', nonce).result).toBe('expired')
    expect(s.consume('verifier-a', nonce).result).toBe('used')
  })

  it('accepts a nonce right up to its expiry', () => {
    const s = store()
    const { nonce } = s.issue('verifier-a', 'over18')
    now += NONCE_TTL_MS
    expect(s.consume('verifier-a', nonce).result).toBe('ok')
  })

  it('rejects an unknown nonce', () => {
    expect(store().consume('verifier-a', 'x'.repeat(43)).result).toBe('unknown')
  })

  it("does not accept another verifier's nonce, and does not burn it", () => {
    const s = store()
    const { nonce } = s.issue('verifier-a', 'over18')
    expect(s.consume('verifier-b', nonce).result).toBe('unknown')
    expect(s.consume('verifier-a', nonce).result).toBe('ok')
  })

  it('issues a different nonce each time', () => {
    const s = store()
    expect(s.issue('v', 'over18').nonce).not.toBe(s.issue('v', 'over18').nonce)
  })
})

describe('issuer trust check', () => {
  const jwk = () => {
    const { kty, crv, x, y } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey.export({
      format: 'jwk',
    }) as Record<string, string>
    return { kty: kty as 'EC', crv: crv as 'P-256', x, y }
  }
  const trustedKey = jwk()

  it('trusts a key in the list, ignoring kid', () => {
    expect(isTrustedIssuer({ ...trustedKey, kid: 'whatever' } as never, [jwk(), trustedKey])).toBe(true)
  })

  it('does not trust a key that is not in the list', () => {
    expect(isTrustedIssuer(jwk(), [trustedKey])).toBe(false)
  })

  it('trusts nothing when the list is empty (fail closed)', () => {
    expect(isTrustedIssuer(trustedKey, [])).toBe(false)
  })

  it('needs both coordinates to match', () => {
    expect(sameIssuerKey(trustedKey, { ...trustedKey, y: jwk().y })).toBe(false)
    expect(sameIssuerKey(trustedKey, { ...trustedKey, x: jwk().x })).toBe(false)
  })
})

describe('over18 policy', () => {
  const at = (iso: string) => new Date(`${iso}T12:00:00Z`)

  it('cutoff is today minus 18 years as YYYYMMDD', () => {
    expect(cutoffYmd(18, at('2026-11-04'))).toBe(20081104)
  })

  it('maps 29 February to 28 February in a non-leap target year', () => {
    expect(cutoffYmd(18, at('2028-02-29'))).toBe(20100228)
    expect(cutoffYmd(18, at('2032-02-29'))).toBe(20140228)
    expect(cutoffYmd(16, at('2032-02-29'))).toBe(20160229)
  })

  it('pads month and day', () => {
    expect(cutoffYmd(18, at('2026-01-05'))).toBe(20080105)
  })

  it('is an inclusive uint predicate on birth_ymd with a string literal', () => {
    expect(policyPredicate('over18', at('2026-11-04'))).toEqual({
      claim: 'birth_ymd',
      op: '<=',
      value: '20081104',
      format: 'uint',
    })
  })

  it('classifies birth dates around the cutoff (same comparison the circuit makes)', () => {
    const cutoff = cutoffYmd(18, at('2026-11-04'))
    const over18 = (birth: number) => birth <= cutoff
    expect(over18(20081104)).toBe(true) // turns 18 today
    expect(over18(20081105)).toBe(false) // tomorrow
    expect(over18(20000514)).toBe(true)
    expect(over18(20120101)).toBe(false)
  })

  it('knows its supported policies', () => {
    expect(isSupportedPolicy('over18')).toBe(true)
    expect(isSupportedPolicy('over21')).toBe(false)
    expect(isSupportedPolicy(undefined)).toBe(false)
  })
})
