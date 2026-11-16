import type { W3cJsonLdVerifiableCredential } from '@credo-ts/core'

import { AskarModule } from '@credo-ts/askar'
import {
  Agent,
  ClaimFormat,
  ConsoleLogger,
  DidsModule,
  JsonTransformer,
  KeyDidRegistrar,
  KeyDidResolver,
  LogLevel,
  W3cCredential,
  W3cCredentialRecord,
  W3cPresentation,
  vcLibraries,
} from '@credo-ts/core'
import {
  DidCommAttachment,
  DidCommAttachmentData,
  DidCommDifPresentationExchangeProofFormatService,
} from '@credo-ts/didcomm'
import { agentDependencies } from '@credo-ts/node'
import { jest } from '@jest/globals'
import { askar } from '@openwallet-foundation/askar-nodejs'
import { randomUUID } from 'node:crypto'

import { findHolderBindingMismatch, HolderBoundDifPresentationExchangeProofFormatService } from '../holderBinding'

describe('holder binding for JSON-LD presentations', () => {
  let agent: InstanceType<typeof Agent>
  let requestAttachment: DidCommAttachment
  let honest: Record<string, unknown>
  let forged: Record<string, unknown>
  const originalMode = process.env.HOLDER_BINDING_CHECK

  const verify = (service: DidCommDifPresentationExchangeProofFormatService, presentation: unknown) =>
    service.processPresentation(agent.context, {
      requestAttachment,
      attachment: new DidCommAttachment({
        id: 'presentation',
        mimeType: 'application/json',
        data: new DidCommAttachmentData({ json: presentation as never }),
      }),
      proofRecord: { id: 'proof-record' } as never,
    })

  const createDid = async () => {
    const { didState } = await agent.dids.create({
      method: 'key',
      options: { createKey: { type: { kty: 'OKP', crv: 'Ed25519' } } },
    })
    const did = didState.did as string
    const { didDocument } = await agent.dids.resolveCreatedDidDocumentWithKeys(did)
    const vm = didDocument?.authentication?.[0]
    return { did, vm: (typeof vm === 'string' ? vm : vm?.id) as string }
  }

  beforeAll(async () => {
    agent = new Agent({
      config: { logger: new ConsoleLogger(LogLevel.off) },
      dependencies: agentDependencies,
      modules: {
        askar: new AskarModule({
          askar,
          store: { id: `holder-binding-${randomUUID()}`, key: 'holder-binding-key-000000000000' },
        }),
        dids: new DidsModule({ registrars: [new KeyDidRegistrar()], resolvers: [new KeyDidResolver()] }),
      },
    })
    await agent.initialize()

    const issuer = await createDid()
    const holder = await createDid()
    const attacker = await createDid()

    const credential = (await agent.w3cCredentials.signCredential({
      format: ClaimFormat.LdpVc,
      credential: new W3cCredential({
        id: `urn:uuid:${randomUUID()}`,
        context: ['https://www.w3.org/2018/credentials/v1', { name: 'https://schema.org/name' }],
        type: ['VerifiableCredential'],
        issuer: issuer.did,
        issuanceDate: new Date().toISOString(),
        expirationDate: new Date(Date.now() + 86_400_000).toISOString(),
        credentialSubject: { id: holder.did, claims: { name: 'Holder' } } as never,
      }),
      proofType: 'Ed25519Signature2018',
      verificationMethod: issuer.vm,
    })) as W3cJsonLdVerifiableCredential
    await agent.w3cCredentials.store({ record: W3cCredentialRecord.fromCredential(credential) })

    const service = new DidCommDifPresentationExchangeProofFormatService()
    const request = await service.createRequest(agent.context, {
      proofRecord: { id: 'proof-record' } as never,
      proofFormats: {
        presentationExchange: {
          presentationDefinition: {
            id: 'pd',
            input_descriptors: [
              {
                id: 'name',
                schema: [{ uri: 'https://www.w3.org/2018/credentials/v1' }],
                constraints: { fields: [{ path: ['$.credentialSubject.name'] }] },
              },
            ],
          },
        },
      },
    })
    requestAttachment = request.attachment

    // The holder's wallet signs with the key of the credential's subject DID.
    const { attachment } = await service.acceptRequest(agent.context, {
      requestAttachment,
      proofRecord: { id: 'proof-record' } as never,
    })
    honest = attachment.getDataAsJson<Record<string, unknown>>()

    // Someone with a copy of the credential re-signs the same presentation with their own key.
    const { proof, ...unsigned } = honest
    const { challenge } = requestAttachment.getDataAsJson<{ options: { challenge: string } }>().options
    const signed = await agent.w3cCredentials.signPresentation({
      format: ClaimFormat.LdpVp,
      presentation: JsonTransformer.fromJSON({ ...unsigned, holder: attacker.did }, W3cPresentation),
      proofType: 'Ed25519Signature2018',
      verificationMethod: attacker.vm,
      proofPurpose: new vcLibraries.jsonldSignatures.purposes.AuthenticationProofPurpose({ challenge }),
      challenge,
    })
    forged = JsonTransformer.toJSON(signed)
  }, 60000)

  afterEach(() => {
    process.env.HOLDER_BINDING_CHECK = originalMode
    jest.restoreAllMocks()
  })

  afterAll(async () => {
    await agent.shutdown()
  })

  it('is not checked by Credo itself', async () => {
    // If this fails, Credo now checks holder binding and the wrapper can be removed.
    await expect(verify(new DidCommDifPresentationExchangeProofFormatService(), forged)).resolves.toBe(true)
  })

  it('rejects a presentation not signed by the subject in enforce mode', async () => {
    process.env.HOLDER_BINDING_CHECK = 'enforce'
    const service = new HolderBoundDifPresentationExchangeProofFormatService()
    await expect(verify(service, honest)).resolves.toBe(true)
    await expect(verify(service, forged)).resolves.toBe(false)
  })

  it('accepts and logs the mismatch in warn mode', async () => {
    process.env.HOLDER_BINDING_CHECK = 'warn'
    const warn = jest.spyOn(agent.context.config.logger, 'warn')
    await expect(verify(new HolderBoundDifPresentationExchangeProofFormatService(), forged)).resolves.toBe(true)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[holder-binding]'), expect.anything())
  })

  it('skips the check when off', async () => {
    process.env.HOLDER_BINDING_CHECK = 'off'
    const warn = jest.spyOn(agent.context.config.logger, 'warn')
    await expect(verify(new HolderBoundDifPresentationExchangeProofFormatService(), forged)).resolves.toBe(true)
    expect(warn).not.toHaveBeenCalled()
  })
})

describe('findHolderBindingMismatch', () => {
  const signedBy = (did: string, credentialSubject: unknown, proof: unknown = {}) => ({
    proof: { verificationMethod: `${did}#key-1` },
    verifiableCredential: [{ credentialSubject, proof }],
  })

  it('accepts credentials whose subject signed the presentation', () => {
    expect(findHolderBindingMismatch(signedBy('did:key:a', { id: 'did:key:a' }))).toBeUndefined()
  })

  it('rejects a credential without a subject DID', () => {
    expect(findHolderBindingMismatch(signedBy('did:key:a', { name: 'x' }))).toMatch(/no subject DID/)
  })

  it('skips AnonCreds data integrity credentials', () => {
    const presentation = signedBy('did:key:a', { name: 'x' }, { cryptosuite: 'anoncreds-2023' })
    expect(findHolderBindingMismatch(presentation)).toBeUndefined()
  })

  it('skips JWT presentations', () => {
    expect(findHolderBindingMismatch('eyJhbGciOi.payload.signature')).toBeUndefined()
  })
})
