/** Per-verifier trusted issuer registration. Fake agents; real P-256 keys. */
import { generateKeyPairSync } from 'crypto'

import { OpenAcService } from '../OpenAcService'

const jwk = () => {
  const { kty, crv, x, y } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey.export({
    format: 'jwk',
  }) as Record<string, string>
  return { kty, crv, x, y }
}
const keys: Record<string, Record<string, string>> = {
  'did:key:a': jwk(),
  'did:key:b': jwk(),
  'did:key:ed': { kty: 'OKP', crv: 'Ed25519', x: 'x' },
}
const agent = (id: string) => ({
  context: { contextCorrelationId: id },
  dids: {
    resolveDidDocument: async (d: string) => ({ verificationMethod: keys[d] ? [{ publicKeyJwk: keys[d] }] : [] }),
  },
})
const req = (id: string) => ({ agent: agent(id) }) as never

describe('trusted issuer registration', () => {
  const saved = process.env.OPENAC_TRUSTED_ISSUER_DIDS
  beforeEach(() => delete process.env.OPENAC_TRUSTED_ISSUER_DIDS)
  afterAll(() => {
    if (saved !== undefined) process.env.OPENAC_TRUSTED_ISSUER_DIDS = saved
  })

  it('trusts nothing until an issuer is registered', async () => {
    expect(await new OpenAcService().trustedIssuerKeys(agent('v1') as never)).toEqual([])
  })

  it('registers the resolved key for that verifier only', async () => {
    const svc = new OpenAcService()
    await expect(svc.registerTrustedIssuer(req('v1'), { did: 'did:key:a' })).resolves.toEqual({
      did: 'did:key:a',
      trustedIssuers: 1,
    })
    expect(await svc.trustedIssuerKeys(agent('v1') as never)).toEqual([
      { kty: 'EC', crv: 'P-256', x: keys['did:key:a'].x, y: keys['did:key:a'].y },
    ])
    expect(await svc.trustedIssuerKeys(agent('v2') as never)).toEqual([])
  })

  it('is idempotent per did and accumulates different dids', async () => {
    const svc = new OpenAcService()
    await svc.registerTrustedIssuer(req('v1'), { did: 'did:key:a' })
    await svc.registerTrustedIssuer(req('v1'), { did: 'did:key:a' })
    await expect(svc.registerTrustedIssuer(req('v1'), { did: 'did:key:b' })).resolves.toMatchObject({
      trustedIssuers: 2,
    })
  })

  it('rejects a did that is not a P-256 key, or does not resolve', async () => {
    const svc = new OpenAcService()
    await expect(svc.registerTrustedIssuer(req('v1'), { did: 'did:key:ed' })).rejects.toThrow('P-256')
    await expect(svc.registerTrustedIssuer(req('v1'), { did: 'did:key:none' })).rejects.toThrow('P-256')
    await expect(svc.registerTrustedIssuer(req('v1'), { did: '' })).rejects.toThrow('did is required')
    expect(await svc.trustedIssuerKeys(agent('v1') as never)).toEqual([])
  })

  it('still honours the deployment wide seed', async () => {
    process.env.OPENAC_TRUSTED_ISSUER_DIDS = 'did:key:b'
    expect(await new OpenAcService().trustedIssuerKeys(agent('v9') as never)).toHaveLength(1)
  })
})
