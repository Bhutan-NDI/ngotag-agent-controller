/**
 * The holder key registry links a credential's `cnf.jwk` to the Askar key that signs OpenAC nonces, and the
 * credentialBindingResolver change that fills it. The agent context is a small fake; the keys and JWK thumbprints are real.
 */
import { GenericRecordsApi, Kms } from '@credo-ts/core'
import { OpenId4VciCredentialFormatProfile } from '@credo-ts/openid4vc'
import { jest } from '@jest/globals'
import { createHash, generateKeyPairSync } from 'crypto'

import { NotFoundError } from '../../../errors/errors'
import { getCredentialBindingResolver } from '../../openid4vc/holder/credentialBindingResolver'
import { findHolderKeyId, holderKeyThumbprint, recordHolderKey } from '../holderKeyRegistry'

type StoredRecord = { id: string; content: Record<string, unknown>; tags: Record<string, unknown> }

class FakeGenericRecords {
  public readonly store = new Map<string, StoredRecord>()
  public failSave = false
  public saveCalls = 0

  public async findById(id: string) {
    return this.store.get(id) ?? null
  }

  public async save(record: StoredRecord) {
    this.saveCalls += 1
    if (this.failSave) throw new Error('storage unavailable')
    this.store.set(record.id, record)
    return record
  }
}

const newAgentContext = (records: FakeGenericRecords, kms?: unknown) => ({
  config: { logger: { warn: jest.fn() } },
  resolve: (token: unknown) => {
    if (token === GenericRecordsApi) return records
    if (token === Kms.KeyManagementApi) return kms
    throw new Error('unexpected resolve')
  },
})

const newP256Jwk = () => {
  const { kty, crv, x, y } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey.export({
    format: 'jwk',
  }) as Record<string, string>
  return { kty, crv, x, y }
}

/** RFC 7638: SHA-256 over the required members in lexicographic order, base64url. */
const rfc7638 = (jwk: { kty: string; crv: string; x: string; y: string }) =>
  createHash('sha256')
    .update(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y }))
    .digest('base64url')

describe('holderKeyThumbprint', () => {
  it('matches the RFC 7638 thumbprint', () => {
    const jwk = newP256Jwk()
    expect(holderKeyThumbprint(jwk)).toBe(rfc7638(jwk))
  })

  it('ignores kid and other non-required members', () => {
    const jwk = newP256Jwk()
    expect(holderKeyThumbprint({ ...jwk, kid: 'askar-key-1', use: 'sig', alg: 'ES256' })).toBe(rfc7638(jwk))
  })

  it('differs between keys', () => {
    expect(holderKeyThumbprint(newP256Jwk())).not.toBe(holderKeyThumbprint(newP256Jwk()))
  })
})

describe('recordHolderKey / findHolderKeyId', () => {
  it('finds the keyId from the credential cnf.jwk, which carries no kid', async () => {
    const records = new FakeGenericRecords()
    const ctx = newAgentContext(records)
    const jwk = newP256Jwk()

    await recordHolderKey(ctx as never, Kms.PublicJwk.fromUnknown({ ...jwk, kid: 'askar-key-1' }))

    await expect(findHolderKeyId(ctx as never, jwk)).resolves.toBe('askar-key-1')
  })

  it('records a key once, however often it is recorded', async () => {
    const records = new FakeGenericRecords()
    const ctx = newAgentContext(records)
    const publicJwk = Kms.PublicJwk.fromUnknown({ ...newP256Jwk(), kid: 'askar-key-1' })

    await recordHolderKey(ctx as never, publicJwk)
    await recordHolderKey(ctx as never, publicJwk)

    expect(records.saveCalls).toBe(1)
    expect(records.store.size).toBe(1)
  })

  it('tags the record so it can be queried or purged', async () => {
    const records = new FakeGenericRecords()
    await recordHolderKey(
      newAgentContext(records) as never,
      Kms.PublicJwk.fromUnknown({ ...newP256Jwk(), kid: 'askar-key-1' }),
    )
    expect([...records.store.values()][0].tags).toEqual({ openacHolderKey: 'true' })
  })

  it('throws NotFoundError for a key this agent did not record', async () => {
    const ctx = newAgentContext(new FakeGenericRecords())
    await expect(findHolderKeyId(ctx as never, newP256Jwk())).rejects.toBeInstanceOf(NotFoundError)
  })

  it('does not throw when storage fails, and logs a warning instead', async () => {
    const records = new FakeGenericRecords()
    records.failSave = true
    const ctx = newAgentContext(records)

    await expect(
      recordHolderKey(ctx as never, Kms.PublicJwk.fromUnknown({ ...newP256Jwk(), kid: 'askar-key-1' })),
    ).resolves.toBeUndefined()
    expect(ctx.config.logger.warn).toHaveBeenCalledTimes(1)
  })
})

describe('credentialBindingResolver: jwk binding records the holder key', () => {
  const jwkOnlyRequest = (agentContext: unknown) =>
    ({
      agentContext,
      credentialFormat: OpenId4VciCredentialFormatProfile.SdJwtDc,
      // cryptographic_binding_methods_supported: ["jwk"] reaches the resolver like this (OpenId4VciHolderService)
      supportedDidMethods: [],
      supportsAllDidMethods: false,
      supportsJwk: true,
      issuerMaxBatchSize: 1,
      proofTypes: { jwt: { supportedSignatureAlgorithms: ['ES256'] } },
    }) as never

  const newKms = () => {
    const jwk = newP256Jwk()
    return {
      jwk,
      kms: {
        createKeyForSignatureAlgorithm: jest.fn(async () => ({
          keyId: 'askar-key-7',
          publicJwk: { ...jwk, kid: 'askar-key-7' },
        })),
      },
    }
  }

  it('binds by jwk and records the keyId under the key thumbprint', async () => {
    const records = new FakeGenericRecords()
    const { jwk, kms } = newKms()
    const ctx = newAgentContext(records, kms)

    const binding = await getCredentialBindingResolver({})(jwkOnlyRequest(ctx))

    expect(binding.method).toBe('jwk')
    expect((binding as { keys: Kms.PublicJwk[] }).keys).toHaveLength(1)
    await expect(findHolderKeyId(ctx as never, jwk)).resolves.toBe('askar-key-7')
  })

  it('still issues when recording fails', async () => {
    const records = new FakeGenericRecords()
    records.failSave = true
    const { kms } = newKms()

    const binding = await getCredentialBindingResolver({})(jwkOnlyRequest(newAgentContext(records, kms)))

    expect(binding.method).toBe('jwk')
  })
})
