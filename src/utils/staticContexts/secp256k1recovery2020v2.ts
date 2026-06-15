/**
 * Embedded JSON-LD context for EcdsaSecp256k1RecoverySignature2020 v2.
 *
 * Canonical URL : https://w3id.org/security/suites/secp256k1recovery-2020/v2
 * Resolves to   : https://identity.foundation/EcdsaSecp256k1RecoverySignature2020/
 *                   lds-ecdsa-secp256k1-recovery2020-2.0.jsonld
 *
 * This context defines EcdsaSecp256k1RecoveryMethod2020, EcdsaSecp256k1RecoverySignature2020,
 * blockchainAccountId, and related terms used by did:ethr DID documents and credentials
 * signed with the Ethereum secp256k1 recovery suite.
 *
 * IMPORTANT: this object MUST be byte-identical (modulo key ordering) to the canonical
 * document. JSON-LD signature verification canonicalises (URDNA2015) against it — any
 * added/removed/changed term silently breaks proof verification. Do NOT edit by hand;
 * re-fetch and diff instead:
 *   curl -sL https://w3id.org/security/suites/secp256k1recovery-2020/v2 | jq -S .
 *
 * Verified against the canonical document on 2026-06-12.
 *
 * Embedded here to eliminate the network dependency from the JSON-LD verification
 * hot path (see CachedDocumentLoader.ts, Layer 1).
 */
export const SECP256K1_RECOVERY_2020_V2 = {
  '@context': {
    id: '@id',
    type: '@type',
    '@protected': true,

    proof: {
      '@id': 'https://w3id.org/security#proof',
      '@type': '@id',
      '@container': '@graph',
    },

    EcdsaSecp256k1RecoveryMethod2020: {
      '@id': 'https://identity.foundation/EcdsaSecp256k1RecoverySignature2020#EcdsaSecp256k1RecoveryMethod2020',
      '@context': {
        '@protected': true,
        id: '@id',
        type: '@type',
        controller: {
          '@id': 'https://w3id.org/security#controller',
          '@type': '@id',
        },
        blockchainAccountId: 'https://w3id.org/security#blockchainAccountId',
        publicKeyJwk: {
          '@id': 'https://w3id.org/security#publicKeyJwk',
          '@type': '@json',
        },
      },
    },

    EcdsaSecp256k1RecoverySignature2020: {
      '@id': 'https://identity.foundation/EcdsaSecp256k1RecoverySignature2020#EcdsaSecp256k1RecoverySignature2020',
      '@context': {
        '@protected': true,
        id: '@id',
        type: '@type',
        challenge: 'https://w3id.org/security#challenge',
        created: {
          '@id': 'http://purl.org/dc/terms/created',
          '@type': 'http://www.w3.org/2001/XMLSchema#dateTime',
        },
        domain: 'https://w3id.org/security#domain',
        expires: {
          '@id': 'https://w3id.org/security#expiration',
          '@type': 'http://www.w3.org/2001/XMLSchema#dateTime',
        },
        jws: 'https://w3id.org/security#jws',
        nonce: 'https://w3id.org/security#nonce',
        proofPurpose: {
          '@id': 'https://w3id.org/security#proofPurpose',
          '@type': '@vocab',
          '@context': {
            '@protected': true,
            id: '@id',
            type: '@type',
            assertionMethod: {
              '@id': 'https://w3id.org/security#assertionMethod',
              '@type': '@id',
              '@container': '@set',
            },
            authentication: {
              '@id': 'https://w3id.org/security#authenticationMethod',
              '@type': '@id',
              '@container': '@set',
            },
            capabilityInvocation: {
              '@id': 'https://w3id.org/security#capabilityInvocationMethod',
              '@type': '@id',
              '@container': '@set',
            },
            capabilityDelegation: {
              '@id': 'https://w3id.org/security#capabilityDelegationMethod',
              '@type': '@id',
              '@container': '@set',
            },
            keyAgreement: {
              '@id': 'https://w3id.org/security#keyAgreementMethod',
              '@type': '@id',
              '@container': '@set',
            },
          },
        },
        verificationMethod: {
          '@id': 'https://w3id.org/security#verificationMethod',
          '@type': '@id',
        },
      },
    },
  },
} as const
