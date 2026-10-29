/**
 * End to end over real HTTP with real encrypted DIDComm: a holder agent contacts a tenant of a shared agent whose
 * inbound transport has the relay mounted exactly as in cliAgent. While the relay holds, the tenant sees nothing;
 * re-injecting the held messages lets the tenant process them as if they had just arrived.
 */
import '@openwallet-foundation/askar-nodejs'
import { AskarModule } from '@credo-ts/askar'
import { Agent, LogLevel } from '@credo-ts/core'
import { DidCommHttpOutboundTransport, DidCommModule } from '@credo-ts/didcomm'
import { DidCommHttpInboundTransport, agentDependencies } from '@credo-ts/node'
import { TenantsModule } from '@credo-ts/tenants'
import { askar } from '@openwallet-foundation/askar-nodejs'
import { randomUUID } from 'crypto'

import { TsLogger } from '../../../utils/logger'
import { RelayDrainer } from '../RelayDrainer'
import { createRelayMiddleware } from '../RelayMiddleware'
import { RelayService } from '../RelayService'
import { RelayStore } from '../RelayStore'
import { createForwarder } from '../relayForwarder'

import { freePort, startTarget } from './targetServer'
import { FakeRedis, eventually } from './testSupport'

const logger = new TsLogger(LogLevel.error, 'test')

describe('relay end to end (real agents, real HTTP)', () => {
  let shared: Agent
  let holder: Agent
  let tenantId: string
  let store: RelayStore
  let service: RelayService
  let invitation: unknown
  let stopWatching: () => void

  const tenantConnections = async (): Promise<number> => {
    let count = 0
    await (shared.modules as any).tenants.withTenantAgent({ tenantId }, async (tenant: any) => {
      count = (await tenant.modules.didcomm.connections.getAll()).length
    })
    return count
  }

  beforeAll(async () => {
    const port = await freePort()
    store = new RelayStore(new FakeRedis())
    const drainer = new RelayDrainer(store, createForwarder(2000), logger)
    service = new RelayService(store, drainer, logger)

    shared = new Agent({
      config: { allowInsecureHttpUrls: true },
      dependencies: agentDependencies,
      modules: {
        askar: new AskarModule({
          askar,
          store: { id: `shared-${randomUUID()}`, key: 'shared-store-key-00000000000000' },
        }),
        didcomm: new DidCommModule({
          endpoints: [`http://127.0.0.1:${port}`],
          connections: { autoAcceptConnections: true },
        }),
        tenants: new TenantsModule(),
      },
    })
    const transport = new DidCommHttpInboundTransport({ port })
    transport.app.use(createRelayMiddleware({ store, forward: createForwarder(2000), drainer, logger }))
    ;(shared.modules as any).didcomm.registerInboundTransport(transport)
    ;(shared.modules as any).didcomm.registerOutboundTransport(new DidCommHttpOutboundTransport())

    holder = new Agent({
      config: { allowInsecureHttpUrls: true },
      dependencies: agentDependencies,
      modules: {
        askar: new AskarModule({
          askar,
          store: { id: `holder-${randomUUID()}`, key: 'holder-store-key-0000000000000' },
        }),
        didcomm: new DidCommModule({ connections: { autoAcceptConnections: true } }),
      },
    })
    ;(holder.modules as any).didcomm.registerOutboundTransport(new DidCommHttpOutboundTransport())

    await shared.initialize()
    stopWatching = service.watchRoutingKeys(shared as never)
    await holder.initialize()

    tenantId = (
      (await (shared.modules as any).tenants.createTenant({ config: { label: 'migrating-org' } })) as { id: string }
    ).id
    await (shared.modules as any).tenants.withTenantAgent({ tenantId }, async (tenant: any) => {
      const created = await tenant.modules.didcomm.oob.createInvitation()
      invitation = created.outOfBandInvitation
    })
  }, 120000)

  afterAll(async () => {
    stopWatching?.()
    await holder.shutdown().catch(() => undefined)
    await shared.shutdown().catch(() => undefined)
  })

  // Credo errors carry their agent context, which Jest cannot serialise when a test fails: report only the message.
  const plain = async <T>(run: () => Promise<T>): Promise<T> => {
    try {
      return await run()
    } catch (error) {
      throw new Error(
        `${(error as Error)?.name}: ${(error as Error)?.message}\ncause: ${String((error as { cause?: unknown })?.cause)}\n${(error as Error)?.stack}`,
      )
    }
  }

  it('holds a real inbound message away from the tenant, then lets the tenant process it on re-inject', async () => {
    await plain(async () => {
      await service.put(shared as never, tenantId, { mode: 'HOLD' })

      await (holder.modules as any).didcomm.oob.receiveInvitation(invitation, { label: 'holder' })

      await eventually(async () => 1 <= (await store.holdLength(tenantId)), 15000)
      expect(await tenantConnections()).toBe(0)

      const held = await store.holdLength(tenantId)
      await expect(service.reinject(shared as never, tenantId)).resolves.toEqual({ injected: held, failed: 0 })

      await eventually(async () => 1 === (await tenantConnections()), 15000)
      expect(await store.holdLength(tenantId)).toBe(0)
    })
  }, 90000)

  it("forwards a real inbound message to the organisation's agent untouched, and the tenant never sees it", async () => {
    const target = await startTarget((_request, res) => res.writeHead(200).end())
    try {
      await service.put(shared as never, tenantId, { mode: 'HOLD' })
      // service.put insists on a public https target; the recording server is plain http on loopback.
      await store.setEntry({ tenantId, mode: 'FORWARD', target: target.url, updatedAt: new Date().toISOString() })
      const connectionsBefore = await tenantConnections()

      let secondInvitation: unknown
      await (shared.modules as any).tenants.withTenantAgent({ tenantId }, async (tenant: any) => {
        secondInvitation = (await tenant.modules.didcomm.oob.createInvitation()).outOfBandInvitation
      })
      const secondHolder = holder
      await plain(() =>
        (secondHolder.modules as any).didcomm.oob.receiveInvitation(secondInvitation, { label: 'holder' }),
      )

      await eventually(() => 1 <= target.received.length, 15000)
      const [request] = target.received
      expect(request.contentType).toContain('application/didcomm-envelope-enc')
      expect(JSON.parse(request.body)).toEqual(
        expect.objectContaining({ protected: expect.any(String), ciphertext: expect.any(String) }),
      )
      expect(await tenantConnections()).toBe(connectionsBefore)
    } finally {
      await target.close()
    }
  }, 90000)

  it('takes a forwarding relay off after the new agent is lost: queued messages reach the tenant, later ones go straight to it', async () => {
    // The relay left by the previous test forwards to a server that has since been closed.
    expect((await store.getEntry(tenantId))?.mode).toBe('FORWARD')
    const connectionsBefore = await tenantConnections()
    const invite = async (): Promise<unknown> => {
      let created: unknown
      await (shared.modules as any).tenants.withTenantAgent({ tenantId }, async (tenant: any) => {
        created = (await tenant.modules.didcomm.oob.createInvitation()).outOfBandInvitation
      })
      return created
    }

    await plain(async () => {
      await (holder.modules as any).didcomm.oob.receiveInvitation(await invite(), { label: 'holder' })
      await eventually(async () => 1 <= (await store.holdLength(tenantId)), 15000)
      expect(await tenantConnections()).toBe(connectionsBefore)

      const queued = await store.holdLength(tenantId)
      await expect(service.restore(shared as never, tenantId)).resolves.toEqual({ injected: queued, failed: 0 })

      await eventually(async () => connectionsBefore + 1 === (await tenantConnections()), 15000)
      expect(await store.getEntry(tenantId)).toBeUndefined()
      expect(await store.holdLength(tenantId)).toBe(0)

      await (holder.modules as any).didcomm.oob.receiveInvitation(await invite(), { label: 'holder' })
      await eventually(async () => connectionsBefore + 2 === (await tenantConnections()), 15000)
      expect(await store.holdLength(tenantId)).toBe(0)
    })
  }, 120000)
})
