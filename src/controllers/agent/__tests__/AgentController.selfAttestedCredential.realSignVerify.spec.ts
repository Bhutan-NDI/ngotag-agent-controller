/**
 * Real (non-mocked) sign-then-verify regression test for the id/expirationDate fix, requested in
 * review: AgentController.selfAttestedCredential.spec.ts mocks signCredential, which proves the
 * controller *calls* signing correctly but not that Credo's actual W3cCredential construction /
 * signing path accepts the result -- exactly where the original bug lived (W3cCredential's
 * constructor always assigns id/expirationDate, even to undefined, which
 * @digitalcredentials/vc's issuer rejects unless both are real values).
 *
 * Deliberately does NOT import AgentController (or anything from '../AgentController' / the
 * cliAgent module graph) -- doing so alongside constructing a real Agent in the same test file
 * reproducibly breaks Askar's native key generation (see AgentController
 * .selfAttestedCredential.spec.ts's own comments; root cause not fully bisected). Instead this
 * builds the exact same W3cCredentialOptions shape AgentController.createW3cSelfAttestedCredential
 * constructs (a real generated id, a computed expirationDate) and drives it through a real,
 * in-memory Askar-backed Agent -- proving the fix holds against the real Credo signing pipeline,
 * not just that the controller passes the right arguments to a mock.
 */
import type { W3cJsonLdVerifiableCredential } from '@credo-ts/core'

import { AskarModule } from '@credo-ts/askar'
import { Agent, ClaimFormat, DidsModule, KeyDidRegistrar, KeyDidResolver, W3cCredential } from '@credo-ts/core'
import { agentDependencies } from '@credo-ts/node'
import { askar } from '@openwallet-foundation/askar-nodejs'
import { randomUUID } from 'node:crypto'

describe('self-attested credential — real sign-then-verify against @credo-ts/core (not mocked)', () => {
  let agent: InstanceType<typeof Agent>
  let did: string
  let verificationMethodId: string

  beforeAll(async () => {
    agent = new Agent({
      // Credo 0.6.2 dropped label/walletConfig from InitConfig -- wallet init now goes entirely
      // through the askar module's own `store` option below.
      config: {},
      dependencies: agentDependencies,
      modules: {
        askar: new AskarModule({
          askar,
          store: { id: `real-sign-verify-${randomUUID()}`, key: 'real-sign-verify-key-0000000000' },
        }),
        dids: new DidsModule({ registrars: [new KeyDidRegistrar()], resolvers: [new KeyDidResolver()] }),
      },
    })
    await agent.initialize()

    // Credo 0.6.2's KMS-based create-key shape -- a bare `keyType: 'ed25519'` string (the older
    // shape) fails with "expected string, received undefined at keyId".
    const didResult = await agent.dids.create({
      method: 'key',
      options: { createKey: { type: { kty: 'OKP', crv: 'Ed25519' } } },
    })
    did = didResult.didState.did as string

    const { didDocument } = await agent.dids.resolveCreatedDidDocumentWithKeys(did)
    const vm = didDocument?.assertionMethod?.[0]
    verificationMethodId = (typeof vm === 'string' ? vm : vm?.id) as string
  }, 30000)

  afterAll(async () => {
    await agent.shutdown()
  })

  it('fails without id/expirationDate — reproduces the original bug against the real signer', async () => {
    await expect(
      agent.w3cCredentials.signCredential({
        format: ClaimFormat.LdpVc,
        credential: new W3cCredential({
          context: ['https://www.w3.org/2018/credentials/v1'],
          type: ['VerifiableCredential'],
          issuer: did,
          issuanceDate: new Date().toISOString(),
          credentialSubject: { id: did, claims: { foo: 'bar' } } as never,
          // id and expirationDate deliberately omitted, matching this endpoint's behavior before
          // the fix.
        }),
        proofType: 'Ed25519Signature2018',
        verificationMethod: verificationMethodId,
      }),
    ).rejects.toThrow(/expirationDate/)
  })

  it('signs and verifies for real when id/expirationDate are supplied the way the fix always supplies them', async () => {
    const signed = await agent.w3cCredentials.signCredential({
      format: ClaimFormat.LdpVc,
      credential: new W3cCredential({
        // Same shape AgentController.createW3cSelfAttestedCredential always builds: a real
        // urn:uuid id, and a computed (here: 1-year-out) expirationDate -- never both omitted.
        id: `urn:uuid:${randomUUID()}`,
        context: ['https://www.w3.org/2018/credentials/v1'],
        type: ['VerifiableCredential'],
        issuer: did,
        issuanceDate: new Date().toISOString(),
        expirationDate: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
        credentialSubject: { id: did, claims: { foo: 'bar' } } as never,
      }),
      proofType: 'Ed25519Signature2018',
      verificationMethod: verificationMethodId,
    })

    // Known to be LdpVc from the format passed to signCredential above -- signCredential's return
    // type is a broader union since it can't narrow purely from an object literal's format field.
    const verifyResult = await agent.w3cCredentials.verifyCredential({
      credential: signed as InstanceType<typeof W3cJsonLdVerifiableCredential>,
    })

    expect(verifyResult.isValid).toBe(true)
  }, 30000)
})
