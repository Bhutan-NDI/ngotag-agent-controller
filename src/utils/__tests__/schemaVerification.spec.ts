import { computeSchemaChecksum, SCHEMA_CHECKSUM_ALGORITHM } from '@bhutan-ndi/ethr-credo-module'

import { addressFromEthrDid, checkSchemaRecord, isAllowedSchemaUrl } from '../schemaVerification'

const address = '0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf'
const did = `did:ethr:sepolia:${address}`
const schemaId = 'schema-1'
const schema = { $id: 'https://schemas.example/schemas/schema-1', title: 'Test' }

const record = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    resourceURI: `${did}/resources/${schemaId}`,
    resourceCollectionId: address.toLowerCase(),
    checksumAlgorithm: SCHEMA_CHECKSUM_ALGORITHM,
    checksum: computeSchemaChecksum(schema),
    ...overrides,
  })

describe('addressFromEthrDid', () => {
  it('reads an address or a compressed public key', () => {
    expect(addressFromEthrDid(`did:ethr:${address.toLowerCase()}`)).toBe(address)
    expect(
      addressFromEthrDid('did:ethr:sepolia:0x0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'),
    ).toBe(address)
  })

  it('rejects other DIDs', () => {
    expect(() => addressFromEthrDid('did:key:z6Mk')).toThrow('Not a did:ethr DID')
    expect(() => addressFromEthrDid('did:ethr:sepolia:0x1234')).toThrow('Unsupported did:ethr identifier')
  })
})

describe('checkSchemaRecord', () => {
  it('verifies a schema matching its record', () => {
    expect(checkSchemaRecord(did, schemaId, record(), schema)).toMatchObject({ status: 'verified' })
  })

  it('fails a schema changed after anchoring', () => {
    expect(checkSchemaRecord(did, schemaId, record(), { ...schema, title: 'Changed' })).toMatchObject({
      status: 'failed',
      reason: 'Schema content does not match the on-chain checksum',
    })
  })

  it('reports a record without checksumAlgorithm as legacy', () => {
    const { checksumAlgorithm, ...legacy } = JSON.parse(record())
    expect(checksumAlgorithm).toBeDefined()
    expect(checkSchemaRecord(did, schemaId, JSON.stringify(legacy), schema)).toMatchObject({ status: 'legacy' })
  })

  it.each([
    ['invalid JSON', '{', 'not valid JSON'],
    ['null', 'null', 'not a JSON object'],
    ['an array', '[]', 'not a JSON object'],
    ['another DID', record({ resourceURI: `did:ethr:sepolia:0xabc/resources/${schemaId}` }), 'resourceURI'],
    ['another address', record({ resourceCollectionId: '0x0000000000000000000000000000000000000001' }), 'address'],
    ['an unknown algorithm', record({ checksumAlgorithm: 'md5' }), 'Unsupported checksumAlgorithm'],
    ['a malformed checksum', record({ checksum: 'abc' }), 'malformed'],
  ])('fails a record with %s', (_, recordJson, reason) => {
    expect(checkSchemaRecord(did, schemaId, recordJson, schema)).toMatchObject({
      status: 'failed',
      reason: expect.stringContaining(reason),
    })
  })
})

describe('isAllowedSchemaUrl', () => {
  const allowed = ['https://schemas.example/schemas/', 'https://old.example', undefined]

  it('accepts URLs on an allowed host', () => {
    expect(isAllowedSchemaUrl('https://schemas.example/schemas/schema-1', allowed)).toBe(true)
    expect(isAllowedSchemaUrl('https://old.example/schemas/schema-1', allowed)).toBe(true)
  })

  it('rejects other hosts', () => {
    expect(isAllowedSchemaUrl('https://old.example.attacker.test/schemas/schema-1', allowed)).toBe(false)
    expect(isAllowedSchemaUrl('http://169.254.169.254/latest/meta-data', allowed)).toBe(false)
    expect(isAllowedSchemaUrl('not a url', allowed)).toBe(false)
  })
})
