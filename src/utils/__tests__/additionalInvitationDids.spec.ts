/**
 * Two-DID invitations against a real agent: an invitation carrying a second DID must still be a valid invitation a
 * holder can connect through, and must be findable by the keys of either DID. Only the network is real HTTP on
 * loopback; nothing about the agent is mocked.
 */
import '@openwallet-foundation/askar-nodejs'
import { AskarModule } from '@credo-ts/askar'
import {
  Agent,
  LogLevel,
  PeerDidNumAlgo,
  createPeerDidDocumentFromServices,
  type PeerDidNumAlgo2CreateOptions,
} from '@credo-ts/core'
import {
  DidCommDocumentService,
  DidCommHttpOutboundTransport,
  DidCommModule,
  DidCommOutOfBandInvitation,
  DidCommOutOfBandRepository,
} from '@credo-ts/didcomm'
import { DidCommHttpInboundTransport, agentDependencies } from '@credo-ts/node'
import { askar } from '@openwallet-foundation/askar-nodejs'
import { randomUUID } from 'crypto'
import { createServer } from 'net'

import { OutOfBandController } from '../../controllers/didcomm/outofband/OutOfBandController'
import { BadRequestError } from '../../errors/errors'
import { TsLogger } from '../../utils/logger'
import { MAX_ADDITIONAL_INVITATION_DIDS } from '../additionalInvitationDids'

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number }
      server.close(() => resolve(port))
    })
  })

const eventually = async (check: () => boolean | Promise<boolean>, timeoutMs = 15000): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('condition not met in time')
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

// Credo errors carry their agent context, which Jest cannot serialise when a test fails: report only the text.
const plain = async <T>(run: () => Promise<T>): Promise<T> => {
  try {
    return await run()
  } catch (error) {
    throw new Error(`${(error as Error)?.name}: ${(error as Error)?.message}\n${(error as Error)?.stack}`)
  }
}

const buildAgent = async (name: string, withInbound: boolean): Promise<{ agent: Agent; port: number }> => {
  const port = await freePort()
  const agent = new Agent({
    config: { allowInsecureHttpUrls: true },
    dependencies: agentDependencies,
    modules: {
      askar: new AskarModule({
        askar,
        store: { id: `${name}-${randomUUID()}`, key: `${name}-store-key-00000000000000000000`.slice(0, 32) },
      }),
      didcomm: new DidCommModule({
        endpoints: [`http://127.0.0.1:${port}`],
        connections: { autoAcceptConnections: true },
      }),
    },
  })
  ;(agent.modules as any).didcomm.registerOutboundTransport(new DidCommHttpOutboundTransport())
  if (withInbound) {
    ;(agent.modules as any).didcomm.registerInboundTransport(new DidCommHttpInboundTransport({ port }))
  }
  await agent.initialize()
  return { agent, port }
}

// The invitation DID the controllers make: a did:peer:2 on this agent's own endpoint and a fresh key.
const createInvitationDid = async (agent: Agent): Promise<string> => {
  const routing = await (agent.modules as any).didcomm.mediationRecipient.getRouting({})
  const { didDocument, keys } = createPeerDidDocumentFromServices(
    [
      {
        id: 'didcomm',
        recipientKeys: [routing.recipientKey],
        routingKeys: routing.routingKeys,
        serviceEndpoint: routing.endpoints[0],
      },
    ],
    true,
  )
  const did = await agent.dids.create<PeerDidNumAlgo2CreateOptions>({
    didDocument,
    method: 'peer',
    options: { numAlgo: PeerDidNumAlgo.MultipleInceptionKeyWithoutDoc, keys },
  })
  return did.didState.did as string
}

describe('create-invitation with additionalInvitationDids (real agents)', () => {
  let dedicated: Agent
  let holder: Agent
  let primary: string
  let legacy: string
  const controller = new OutOfBandController()
  const request = () => ({ agent: dedicated }) as never
  const create = (config: object) => controller.createInvitation(request(), { label: 'Org', ...config } as never)

  // The recipient keys of a DID's DIDComm services, as Credo resolves them.
  const fingerprintsOf = async (did: string): Promise<string[]> => {
    const services = await dedicated.dependencyManager
      .resolve(DidCommDocumentService)
      .resolveServicesFromDid(dedicated.context, did)
    return services.flatMap(({ recipientKeys }) => recipientKeys.map((key) => key.fingerprint))
  }
  const oobCount = async () => (await (dedicated.modules as any).didcomm.oob.getAll()).length

  beforeAll(async () => {
    ;({ agent: dedicated } = await buildAgent('dedicated', true))
    ;({ agent: holder } = await buildAgent('holder', true))
    primary = await createInvitationDid(dedicated)
    legacy = await createInvitationDid(dedicated)
  }, 120000)

  afterAll(async () => {
    await holder.shutdown().catch(() => undefined)
    await dedicated.shutdown().catch(() => undefined)
  })

  it('lists the extra DID second, in the invitation JSON and in its URL', async () => {
    await plain(async () => {
      const result = await create({ invitationDid: primary, additionalInvitationDids: [legacy] })

      expect((result.invitation as any).services).toEqual([primary, legacy])
      const fromUrl = DidCommOutOfBandInvitation.fromUrl(result.invitationUrl)
      expect(fromUrl.getServices()).toEqual([primary, legacy])
    })
  })

  it('keeps the stored record in line: both services persisted, findable by the keys of either DID', async () => {
    await plain(async () => {
      const result = await create({ invitationDid: primary, additionalInvitationDids: [legacy] })
      const stored = await (dedicated.modules as any).didcomm.oob.getById(result.outOfBandRecord.id)

      expect(stored.outOfBandInvitation.getServices()).toEqual([primary, legacy])
      const expected = [...(await fingerprintsOf(primary)), ...(await fingerprintsOf(legacy))].sort()
      expect(expected.length).toBeGreaterThanOrEqual(2)
      expect(expected).not.toContain(undefined)
      expect([...stored.getTag('recipientKeyFingerprints')].sort()).toEqual(expected)

      const repository = dedicated.dependencyManager.resolve(DidCommOutOfBandRepository)
      for (const fingerprint of await fingerprintsOf(legacy)) {
        const found = await repository.findByQuery(dedicated.context, { recipientKeyFingerprints: [fingerprint] })
        expect(found.map((record) => record.id)).toContain(result.outOfBandRecord.id)
      }
    })
  })

  it('computes the keys exactly as Credo does for an invitation without extra DIDs', async () => {
    await plain(async () => {
      const result = await create({ invitationDid: primary })
      const stored = await (dedicated.modules as any).didcomm.oob.getById(result.outOfBandRecord.id)
      const credoOwn = await (dedicated.modules as any).didcomm.oob.resolveInvitationRecipientKeyFingerprints(
        stored.outOfBandInvitation,
      )

      expect(stored.getTag('recipientKeyFingerprints')).toEqual(credoOwn)
      expect(stored.outOfBandInvitation.getServices()).toEqual([primary])
    })
  })

  it('still lets a holder connect through an invitation that carries two DIDs', async () => {
    await plain(async () => {
      const result = await create({ invitationDid: primary, additionalInvitationDids: [legacy] })
      const invitation = DidCommOutOfBandInvitation.fromUrl(result.invitationUrl)

      const { connectionRecord } = await (holder.modules as any).didcomm.oob.receiveInvitation(invitation, {
        label: 'holder',
      })

      await eventually(
        async () =>
          'completed' === (await (holder.modules as any).didcomm.connections.getById(connectionRecord.id)).state,
      )
      const onDedicated = (await (dedicated.modules as any).didcomm.connections.getAll()).filter(
        (connection: any) => connection.outOfBandId === result.outOfBandRecord.id,
      )
      expect(onDedicated).toHaveLength(1)
    })
  })

  it('generates the first DID itself when only extra DIDs are given', async () => {
    await plain(async () => {
      const result = await create({ additionalInvitationDids: [legacy] })

      const services = (result.invitation as any).services as string[]
      expect(services).toHaveLength(2)
      expect(services[1]).toBe(legacy)
      expect(services[0]).not.toBe(legacy)
    })
  })

  describe('rejects a bad request before creating anything', () => {
    it.each([
      ['a value that is not a DID', () => ['not-a-did']],
      ['a DID this agent did not create', () => ['did:peer:2.Ez6LSbysY2xFMRpGMhb7tFTLMpeuPRaqaWM1yECx2AtzE3KCc']],
      ['a repeated DID', () => [legacy, legacy]],
      ['the primary DID again', () => [primary]],
      ['too many DIDs', () => Array.from({ length: MAX_ADDITIONAL_INVITATION_DIDS + 1 }, () => legacy)],
      ['something that is not an array', () => 'did:peer:abc' as unknown as string[]],
      ['an array holding a non-string', () => [5] as unknown as string[]],
    ])('%s', async (_name, dids) => {
      await plain(async () => {
        const before = await oobCount()

        const error = await create({ invitationDid: primary, additionalInvitationDids: dids() }).catch(
          (e: unknown) => e,
        )

        expect(error).toBeInstanceOf(BadRequestError)
        expect(await oobCount()).toBe(before)
      })
    })

    it('a DID this agent created that has no DIDComm service', async () => {
      await plain(async () => {
        const created = await dedicated.dids.create({
          method: 'key',
          options: { createKey: { type: { kty: 'OKP', crv: 'Ed25519' } } },
        })
        const before = await oobCount()

        const error = await create({
          invitationDid: primary,
          additionalInvitationDids: [created.didState.did as string],
        }).catch((e: unknown) => e)

        expect(error).toBeInstanceOf(BadRequestError)
        expect((error as Error).message).toContain('no DIDComm service')
        expect(await oobCount()).toBe(before)
      })
    })

    it('treats an empty list as no extra DIDs', async () => {
      await plain(async () => {
        const result = await create({ invitationDid: primary, additionalInvitationDids: [] })

        expect((result.invitation as any).services).toEqual([primary])
      })
    })
  })
})
