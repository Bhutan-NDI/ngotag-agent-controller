/**
 * Guards the local patch to openac-sdk@5.0.0 (patches/openac-sdk+5.0.0.patch):
 *  - present() accepts a ready-made `deviceSignature`, because the holder key lives in Askar and cannot be exported;
 *  - the SDK's witness calculator loads (the published package ships it as CommonJS inside an ESM package).
 *
 * The real Prepare and Show circuit witnesses run (the circuit itself checks the issuer signature and the device
 * signature), so a wrong or malformed signature is rejected here exactly as it would be when proving. Only the
 * Spartan proving step is stubbed, because it needs the 1k proving keys.
 */
import { createHash, createPrivateKey, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'crypto'
import { Prover, WitnessCalculator } from 'openac-sdk'

const P256_N = BigInt('0xffffffffffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551')
const HALF_N = P256_N >> BigInt(1)

const b64u = (data: Uint8Array | string) => Buffer.from(data).toString('base64url')
const json = (value: unknown) => b64u(JSON.stringify(value))
const sha256 = (data: string) => createHash('sha256').update(data).digest()

const newKey = () => generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
const publicJwk = (key: KeyObject) => {
  const { kty, crv, x, y } = key.export({ format: 'jwk' }) as Record<string, string>
  return { kty, crv, x, y }
}
const privateHex = (key: KeyObject) =>
  Buffer.from((key.export({ format: 'jwk' }) as { d: string }).d, 'base64url').toString('hex')

/** Raw r||s ES256 signature with the requested S half, like what Askar returns (S is random). */
const signRaw = (key: KeyObject, message: string, s: 'low' | 'high') => {
  const raw = sign('sha256', Buffer.from(message), { key, dsaEncoding: 'ieee-p1363' })
  const sValue = BigInt(`0x${raw.subarray(32).toString('hex')}`)
  if ((s === 'low') === sValue <= HALF_N) return raw
  const flipped = (P256_N - sValue).toString(16).padStart(64, '0')
  return Buffer.concat([raw.subarray(0, 32), Buffer.from(flipped, 'hex')])
}

// Credo's saltGenerator slices base64url to 16 characters (SdJwtVcService.mjs), so use the same here.
const credoSalt = () => randomBytes(16).toString('base64url').slice(0, 16)

const buildCredential = (issuer: KeyObject, holder: KeyObject, birthYmd: string) => {
  const disclosures = [
    [credoSalt(), 'birth_ymd', birthYmd],
    [credoSalt(), 'country_of_residence', 'BT'],
  ].map((d) => json(d))
  const did = 'did:key:zDnaerDaTF5BXEavCrfRZEk316dpbLsfPDZ3WJ5hRTPFU2169'
  const header = { alg: 'ES256', typ: 'dc+sd-jwt', kid: `${did}#${did.slice('did:key:'.length)}` }
  const payload = {
    iss: did,
    iat: Math.floor(Date.now() / 1000),
    vct: 'AgeCredential',
    cnf: { jwk: publicJwk(holder) },
    _sd: disclosures.map((d) => b64u(sha256(d))),
    _sd_alg: 'sha-256',
  }
  const signingInput = `${json(header)}.${json(payload)}`
  const jwt = `${signingInput}.${b64u(signRaw(issuer, signingInput, 'low'))}`
  return { jwt, disclosures, issuerPublicKey: publicJwk(issuer) }
}

const stub = () => new Uint8Array([1])
const stubBridge = {
  precomputeFromWitness: async () => ({ proof: stub(), instance: stub(), witness: stub() }),
  precomputeShowFromWitness: async () => ({ proof: stub(), instance: stub(), witness: stub() }),
  present: async () => ({ prepareProof: stub(), prepareInstance: stub(), showProof: stub(), showInstance: stub() }),
}
const keys = {
  prepareProvingKey: stub(),
  prepareVerifyingKey: stub(),
  showProvingKey: stub(),
  showVerifyingKey: stub(),
}
const predicates = { claim: 'birth_ymd', op: '<=', value: 20081104, format: 'uint' } as const

describe('openac-sdk patch: deviceSignature', () => {
  let prover: Prover
  const issuer = newKey().privateKey
  const holder = newKey().privateKey
  let precomputed: Awaited<ReturnType<Prover['precompute']>>

  beforeAll(async () => {
    const witnessCalculator = new WitnessCalculator()
    await witnessCalculator.init() // throws "module is not defined" without the patch's assets/package.json
    prover = new Prover(stubBridge as never, witnessCalculator)
    const credential = buildCredential(issuer, holder, '20000514')
    precomputed = await prover.precompute({ ...credential, keys, predicates } as never)
  })

  const nonce = () => b64u(randomBytes(32))
  const present = (extra: Record<string, unknown>, verifierNonce: string) =>
    prover.present({ precomputed, verifierNonce, keys, predicates, ...extra } as never)

  it('presents with only a deviceSignature and no private key', async () => {
    const n = nonce()
    const proof = await present({ deviceSignature: b64u(signRaw(holder, n, 'low')) }, n)
    expect(proof.publicValues.expressionResult).toBe(true)
  })

  it('still presents with only a devicePrivateKey (unchanged behaviour)', async () => {
    const proof = await present({ devicePrivateKey: privateHex(holder) }, nonce())
    expect(proof.publicValues.expressionResult).toBe(true)
  })

  it('prefers deviceSignature over devicePrivateKey when both are given', async () => {
    const n = nonce()
    const proof = await present(
      { deviceSignature: b64u(signRaw(holder, n, 'low')), devicePrivateKey: privateHex(newKey().privateKey) },
      n,
    )
    expect(proof.publicValues.expressionResult).toBe(true)
  })

  it('rejects a deviceSignature made by a key other than cnf.jwk', async () => {
    const n = nonce()
    await expect(present({ deviceSignature: b64u(signRaw(newKey().privateKey, n, 'low')) }, n)).rejects.toThrow()
  })

  it('rejects a deviceSignature over a different nonce', async () => {
    await expect(present({ deviceSignature: b64u(signRaw(holder, nonce(), 'low')) }, nonce())).rejects.toThrow()
  })

  it('rejects a high-S deviceSignature (low-S normalisation is required)', async () => {
    const n = nonce()
    await expect(present({ deviceSignature: b64u(signRaw(holder, n, 'high')) }, n)).rejects.toThrow()
  })

  it('throws when neither deviceSignature nor devicePrivateKey is given', async () => {
    await expect(present({}, nonce())).rejects.toThrow('requires either deviceSignature or devicePrivateKey')
  })
})
