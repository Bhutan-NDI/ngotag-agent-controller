/**
 * Real (non-mocked) sign-then-verify for a did:ethr issuer, the case the org-migration verify step
 * hit on QA: "Unsupported key did from verification method type 'EcdsaSecp256k1RecoveryMethod2020'".
 *
 * A did:ethr document lists `#controller` (EcdsaSecp256k1RecoveryMethod2020: an address, no public
 * key) before `#controllerKey` (EcdsaSecp256k1VerificationKey2019, the wallet's key). The
 * self-attested endpoint signed with assertionMethod[0]; it now picks the key the proof type's
 * suite signs with (selectAssertionMethod).
 *
 * Like the realSignVerify spec, this does not import AgentController (a real Agent alongside the
 * controller's module graph breaks Askar's native key generation). It drives the same selection
 * helper and the same modules the controller registers (polygon, then ethereum, as in cliAgent,
 * so the same EcdsaSecp256k1Signature2019 suite wins) and the controller's static recovery context. The
 * document is the shape EthereumLedgerService.resolveDID stores; a stub resolver serves it, so
 * no RPC is needed.
 */
import type { AgentContext, DidResolver, DocumentLoader, W3cJsonLdVerifiableCredential } from '@credo-ts/core'

import { EthereumModule } from '@bhutan-ndi/ethr-credo-module'
import { AskarModule } from '@credo-ts/askar'
import {
  Agent,
  ClaimFormat,
  DidDocument,
  DidsModule,
  JsonTransformer,
  KeyDidRegistrar,
  KeyDidResolver,
  TypedArrayEncoder,
  W3cCredential,
  W3cCredentialsModule,
  W3cJsonLdCredentialService,
} from '@credo-ts/core'
import { defaultDocumentLoader } from '@credo-ts/core/build/modules/vc/data-integrity/libraries/documentLoader.mjs'
import { agentDependencies } from '@credo-ts/node'
import { askar } from '@openwallet-foundation/askar-nodejs'
import { randomUUID } from 'node:crypto'

import { SECP256K1_RECOVERY_2020_V2 } from '../../../utils/staticContexts/secp256k1recovery2020v2'
import { selectAssertionMethod } from '../../../utils/verificationMethodSelection'

// The package's "exports" map points ESM imports at a .d.mts, so load the module file directly, as
// PolygonDidRegistrar.idempotent.spec.ts does.
const { PolygonModule } = await import(
  '../../../../node_modules/@ayanworks/credo-polygon-w3c-module/build/PolygonModule.mjs' as string
)

const PROOF_TYPE = 'EcdsaSecp256k1Signature2019'

// What CachedDocumentLoader adds over Credo's loader for did:ethr: the secp256k1recovery-2020
// context, served from the same static copy (CachedDocumentLoader itself uses require(), which
// Jest's ESM mode cannot load).
const RECOVERY_CONTEXT = 'https://w3id.org/security/suites/secp256k1recovery-2020/v2'
const documentLoader = (agentContext: AgentContext): DocumentLoader => {
  const inner = defaultDocumentLoader(agentContext)
  return async (url: string) =>
    RECOVERY_CONTEXT === url ? { contextUrl: null, documentUrl: url, document: SECP256K1_RECOVERY_2020_V2 } : inner(url)
}

// Compressed secp256k1 public key (0x02/0x03 + x) from a JWK, as did:ethr's identifier carries it.
const compressedPublicKey = (jwk: { x?: string; y?: string }): Buffer => {
  const x = Buffer.from(jwk.x as string, 'base64url')
  const y = Buffer.from(jwk.y as string, 'base64url')
  return Buffer.concat([Buffer.from([y[y.length - 1] % 2 === 0 ? 0x02 : 0x03]), x])
}

describe('self-attested credential — did:ethr sign-then-verify against @credo-ts/core (not mocked)', () => {
  let agent: InstanceType<typeof Agent>
  let did: string
  let didDocument: InstanceType<typeof DidDocument>

  beforeAll(async () => {
    const documents = new Map<string, InstanceType<typeof DidDocument>>()
    const ethrResolver: DidResolver = {
      supportedMethods: ['ethr'],
      allowsCaching: false,
      allowsLocalDidRecord: true,
      resolve: async (_agentContext, requested) => ({
        didDocument: documents.get(requested) ?? null,
        didResolutionMetadata: documents.has(requested) ? {} : { error: 'notFound' },
        didDocumentMetadata: {},
      }),
    }

    agent = new Agent({
      config: {},
      dependencies: agentDependencies,
      modules: {
        askar: new AskarModule({
          askar,
          store: { id: `ethr-sign-verify-${randomUUID()}`, key: 'ethr-sign-verify-key-00000000000' },
        }),
        dids: new DidsModule({ registrars: [new KeyDidRegistrar()], resolvers: [new KeyDidResolver(), ethrResolver] }),
        w3cCredentials: new W3cCredentialsModule({ documentLoader }),
        polygon: new PolygonModule({
          didContractAddress: '',
          schemaManagerContractAddress: '',
          fileServerToken: '',
          rpcUrl: '',
          serverUrl: '',
        }),
        // Never dialled: the stub resolver answers before the ledger is used.
        ethereum: new EthereumModule({
          config: {
            networks: [
              {
                name: 'sepolia',
                chainId: 11155111,
                rpcUrl: 'http://127.0.0.1:1',
                registry: '0x03d5003bf0e79C5F5223588F347ebA39AfbC3818',
              },
            ],
          },
          schemaManagerContractAddress: '',
          rpcUrl: '',
        }),
      },
    })
    await agent.initialize()

    const { keyId, publicJwk } = await agent.kms.createKey({ type: { kty: 'EC', crv: 'secp256k1' } })
    const publicKey = compressedPublicKey(publicJwk as { x?: string; y?: string })
    did = `did:ethr:sepolia:0x${publicKey.toString('hex')}`
    didDocument = JsonTransformer.fromJSON(
      {
        '@context': [
          'https://www.w3.org/ns/did/v1',
          'https://w3id.org/security/suites/secp256k1recovery-2020/v2',
          'https://w3id.org/security/suites/secp256k1-2019/v1',
        ],
        id: did,
        verificationMethod: [
          {
            id: `${did}#controller`,
            type: 'EcdsaSecp256k1RecoveryMethod2020',
            controller: did,
            blockchainAccountId: 'eip155:11155111:0x0000000000000000000000000000000000000001',
          },
          {
            id: `${did}#controllerKey`,
            type: 'EcdsaSecp256k1VerificationKey2019',
            controller: did,
            publicKeyBase58: TypedArrayEncoder.toBase58(publicKey),
          },
        ],
        authentication: [`${did}#controller`, `${did}#controllerKey`],
        assertionMethod: [`${did}#controller`, `${did}#controllerKey`],
      },
      DidDocument,
    )
    documents.set(did, didDocument)
    // As EthrDidRegistrar stores it: the key is linked to `#controllerKey`, not `#controller`.
    await agent.dids.import({
      did,
      didDocument,
      keys: [{ didDocumentRelativeKeyId: '#controllerKey', kmsKeyId: keyId }],
    })
  }, 30000)

  afterAll(async () => {
    await agent.shutdown()
  })

  const credential = () =>
    new W3cCredential({
      id: `urn:uuid:${randomUUID()}`,
      context: ['https://www.w3.org/2018/credentials/v1'],
      type: ['VerifiableCredential'],
      issuer: did,
      issuanceDate: new Date().toISOString(),
      expirationDate: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
      credentialSubject: { id: did, claims: {} } as never,
    })

  it('fails with the first assertionMethod entry, as the endpoint did before — the QA error', async () => {
    await expect(
      agent.w3cCredentials.signCredential({
        format: ClaimFormat.LdpVc,
        credential: credential(),
        proofType: PROOF_TYPE,
        verificationMethod: `${did}#controller`,
      }),
    ).rejects.toThrow(/EcdsaSecp256k1RecoveryMethod2020/)
  })

  it('selects #controllerKey for EcdsaSecp256k1Signature2019, and the credential signs and verifies', async () => {
    const { didDocument: created } = await agent.dids.resolveCreatedDidDocumentWithKeys(did)
    const acceptedTypes = agent.dependencyManager
      .resolve(W3cJsonLdCredentialService)
      .getVerificationMethodTypesByProofType(PROOF_TYPE)
    const verificationMethod = selectAssertionMethod(created, acceptedTypes)?.id

    expect(verificationMethod).toBe(`${did}#controllerKey`)

    const signed = await agent.w3cCredentials.signCredential({
      format: ClaimFormat.LdpVc,
      credential: credential(),
      proofType: PROOF_TYPE,
      verificationMethod: verificationMethod as string,
    })
    const result = await agent.w3cCredentials.verifyCredential({
      credential: signed as InstanceType<typeof W3cJsonLdVerifiableCredential>,
    })

    expect(result.isValid).toBe(true)
  }, 30000)

  it('still cannot sign a did:ethr credential with Ed25519Signature2018 — the caller must ask for the secp256k1 suite', async () => {
    // Why the platform's migration check has to send EcdsaSecp256k1Signature2019 for did:ethr: no
    // assertionMethod key matches the Ed25519 suite, and the secp256k1 key it falls back to is
    // refused by the signer.
    const { didDocument: created } = await agent.dids.resolveCreatedDidDocumentWithKeys(did)
    const acceptedTypes = agent.dependencyManager
      .resolve(W3cJsonLdCredentialService)
      .getVerificationMethodTypesByProofType('Ed25519Signature2018')
    const verificationMethod = selectAssertionMethod(created, acceptedTypes)?.id

    expect(verificationMethod).toBe(`${did}#controllerKey`)
    await expect(
      agent.w3cCredentials.signCredential({
        format: ClaimFormat.LdpVc,
        credential: credential(),
        proofType: 'Ed25519Signature2018',
        verificationMethod: verificationMethod as string,
      }),
    ).rejects.toThrow(/does not match the suite/)
  })
})
