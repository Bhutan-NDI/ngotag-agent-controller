import { DidDocument, JsonTransformer } from '@credo-ts/core'

import {
  firstVerificationMethodWithKey,
  hasPublicKeyMaterial,
  selectAssertionMethod,
} from '../verificationMethodSelection'

const SECP256K1_SUITE = ['EcdsaSecp256k1VerificationKey2019']
const ED25519_SUITE = ['Ed25519VerificationKey2018', 'Ed25519VerificationKey2020']

// As EthereumLedgerService.resolveDID stores a public-key did:ethr: the keyless `#controller`
// first, the key itself in `#controllerKey`, both referenced (not embedded) from assertionMethod.
const ETHR = 'did:ethr:sepolia:0x025685d7548c6e21bfa56249594aba0ee7f9cfe810e3909d0c0e8a8bbb86244f9c'
const ethrDocument = () =>
  JsonTransformer.fromJSON(
    {
      '@context': ['https://www.w3.org/ns/did/v1'],
      id: ETHR,
      verificationMethod: [
        {
          id: `${ETHR}#controller`,
          type: 'EcdsaSecp256k1RecoveryMethod2020',
          controller: ETHR,
          blockchainAccountId: 'eip155:11155111:0x0000000000000000000000000000000000000001',
        },
        {
          id: `${ETHR}#controllerKey`,
          type: 'EcdsaSecp256k1VerificationKey2019',
          controller: ETHR,
          publicKeyBase58: 'mw3Lk4Ex7tUkAXT2YNdBfhPWbSJMBwHXV9uUe1hbr3Q6',
        },
      ],
      assertionMethod: [`${ETHR}#controller`, `${ETHR}#controllerKey`],
    },
    DidDocument,
  )

// A did:ethr whose owner changed: the resolver drops `#controllerKey`, leaving nothing to sign with.
const ethrOwnerChangedDocument = () =>
  JsonTransformer.fromJSON(
    {
      '@context': ['https://www.w3.org/ns/did/v1'],
      id: ETHR,
      verificationMethod: [
        {
          id: `${ETHR}#controller`,
          type: 'EcdsaSecp256k1RecoveryMethod2020',
          controller: ETHR,
          blockchainAccountId: 'eip155:11155111:0x0000000000000000000000000000000000000002',
        },
      ],
      assertionMethod: [`${ETHR}#controller`],
    },
    DidDocument,
  )

const POLYGON = 'did:polygon:testnet:0x4a09b8CB511cca4Ca1c5dB0475D0e07bFc96EF47'
const polygonDocument = () =>
  JsonTransformer.fromJSON(
    {
      '@context': ['https://www.w3.org/ns/did/v1'],
      id: POLYGON,
      verificationMethod: [
        {
          id: `${POLYGON}#key-1`,
          type: 'EcdsaSecp256k1VerificationKey2019',
          controller: POLYGON,
          publicKeyBase58: 'mw3Lk4Ex7tUkAXT2YNdBfhPWbSJMBwHXV9uUe1hbr3Q6',
        },
      ],
      assertionMethod: [`${POLYGON}#key-1`],
    },
    DidDocument,
  )

const KEY = 'did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK'
const keyDocument = () =>
  JsonTransformer.fromJSON(
    {
      '@context': ['https://www.w3.org/ns/did/v1'],
      id: KEY,
      verificationMethod: [
        {
          id: `${KEY}#z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK`,
          type: 'Ed25519VerificationKey2018',
          controller: KEY,
          publicKeyBase58: 'B12NYF8RrR3h41TDCTJojY59usg3mbtbjnFs7Eud1Y6u',
        },
      ],
      assertionMethod: [`${KEY}#z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK`],
    },
    DidDocument,
  )

describe('selectAssertionMethod', () => {
  it('picks did:ethr #controllerKey for EcdsaSecp256k1Signature2019, skipping the keyless #controller listed first', () => {
    expect(selectAssertionMethod(ethrDocument(), SECP256K1_SUITE)?.id).toBe(`${ETHR}#controllerKey`)
  })

  it('never picks the keyless #controller, even when no entry matches the suite', () => {
    // The signer then reports the real mismatch (secp256k1 key, Ed25519 suite) instead of
    // "Unsupported key did from verification method type 'EcdsaSecp256k1RecoveryMethod2020'".
    expect(selectAssertionMethod(ethrDocument(), ED25519_SUITE)?.id).toBe(`${ETHR}#controllerKey`)
  })

  it('returns undefined when every assertionMethod entry is keyless (a did:ethr whose owner changed)', () => {
    expect(selectAssertionMethod(ethrOwnerChangedDocument(), SECP256K1_SUITE)).toBeUndefined()
  })

  it('keeps polygon and did:key on their only key, as before', () => {
    expect(selectAssertionMethod(polygonDocument(), SECP256K1_SUITE)?.id).toBe(`${POLYGON}#key-1`)
    expect(selectAssertionMethod(keyDocument(), ED25519_SUITE)?.id).toBe(
      `${KEY}#z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK`,
    )
  })

  it('prefers a suite match over an earlier key of another type', () => {
    const document = {
      assertionMethod: [
        {
          id: 'did:example:1#ed',
          type: 'Ed25519VerificationKey2018',
          controller: 'did:example:1',
          publicKeyBase58: 'a',
        },
        {
          id: 'did:example:1#k1',
          type: 'EcdsaSecp256k1VerificationKey2019',
          controller: 'did:example:1',
          publicKeyBase58: 'b',
        },
      ],
    } as never
    expect(selectAssertionMethod(document, SECP256K1_SUITE)?.id).toBe('did:example:1#k1')
  })

  it('keeps an entry whose type cannot be read, leaving the signer to judge it', () => {
    // An unresolvable reference, or an embedded entry without a type: the old behaviour.
    expect(selectAssertionMethod({ assertionMethod: ['did:example:1#missing'] } as never, ED25519_SUITE)?.id).toBe(
      'did:example:1#missing',
    )
    expect(selectAssertionMethod({ assertionMethod: [{ id: 'did:example:1#x' }] } as never, ED25519_SUITE)?.id).toBe(
      'did:example:1#x',
    )
  })

  it('returns undefined for a document with no assertionMethod', () => {
    expect(selectAssertionMethod({ verificationMethod: [] } as never, ED25519_SUITE)).toBeUndefined()
  })
})

describe('firstVerificationMethodWithKey', () => {
  it('skips did:ethr #controller in both assertionMethod and verificationMethod', () => {
    expect(firstVerificationMethodWithKey(ethrDocument(), 'assertionMethod')?.id).toBe(`${ETHR}#controllerKey`)
    expect(firstVerificationMethodWithKey(ethrDocument(), 'verificationMethod')?.id).toBe(`${ETHR}#controllerKey`)
  })

  it('keeps the first key of polygon and did:key documents', () => {
    expect(firstVerificationMethodWithKey(polygonDocument(), 'verificationMethod')?.id).toBe(`${POLYGON}#key-1`)
    expect(firstVerificationMethodWithKey(keyDocument(), 'assertionMethod')?.id).toBe(
      `${KEY}#z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK`,
    )
  })

  it('returns undefined when no entry carries a public key', () => {
    expect(firstVerificationMethodWithKey(ethrOwnerChangedDocument(), 'verificationMethod')).toBeUndefined()
  })
})

describe('hasPublicKeyMaterial', () => {
  it('is false for a blockchainAccountId-only method and true for any public key encoding', () => {
    const [controller, controllerKey] = ethrDocument().verificationMethod ?? []
    expect(hasPublicKeyMaterial(controller)).toBe(false)
    expect(hasPublicKeyMaterial(controllerKey)).toBe(true)
  })
})
