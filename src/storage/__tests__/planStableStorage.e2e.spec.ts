/**
 * End to end over real HTTP with real encrypted DIDComm: a holder connects to a tenant of a shared agent whose
 * storage is wired as in cliAgent (AskarModule without storage + PlanStableAskarStorageModule), and the two
 * exchange messages both ways. The tenant's inbound path resolves its connection by DIDs, an OR query that the
 * planned storage runs as a union of indexed lookups.
 */
import '@openwallet-foundation/askar-nodejs'
import { AskarModule } from '@credo-ts/askar'
import { Agent, InjectionSymbols } from '@credo-ts/core'
import {
  DidCommConnectionRepository,
  DidCommDidExchangeState,
  DidCommHttpOutboundTransport,
  DidCommModule,
} from '@credo-ts/didcomm'
import { DidCommHttpInboundTransport, agentDependencies } from '@credo-ts/node'
import { TenantsModule } from '@credo-ts/tenants'
import { jest } from '@jest/globals'
import { askar } from '@openwallet-foundation/askar-nodejs'
import { randomUUID } from 'crypto'

import { freePort } from '../../services/migration-relay/__tests__/targetServer'
import { eventually } from '../../services/migration-relay/__tests__/testSupport'
import { PlanStableAskarStorageModule } from '../PlanStableAskarStorageModule'
import { PlanStableAskarStorageService } from '../PlanStableAskarStorageService'

/* eslint-disable @typescript-eslint/no-explicit-any */

describe('plan-stable storage end to end (real agents, real HTTP)', () => {
  let shared: Agent
  let holder: Agent
  let tenantId: string
  const orQueries: unknown[] = []

  const withTenant = async <T>(run: (tenant: any) => Promise<T>): Promise<T> => {
    let result: T | undefined
    await (shared.modules as any).tenants.withTenantAgent({ tenantId }, async (tenant: any) => {
      result = await run(tenant)
    })
    return result as T
  }

  beforeAll(async () => {
    const findByQuery = PlanStableAskarStorageService.prototype.findByQuery
    jest.spyOn(PlanStableAskarStorageService.prototype, 'findByQuery').mockImplementation(function (
      this: any,
      ...args: Parameters<typeof findByQuery>
    ) {
      if (JSON.stringify(args[2]).includes('"$or"')) orQueries.push(args[2])
      return findByQuery.apply(this, args)
    })

    const [sharedPort, holderPort] = [await freePort(), await freePort()]
    shared = new Agent({
      config: { allowInsecureHttpUrls: true },
      dependencies: agentDependencies,
      modules: {
        askar: new AskarModule({
          askar,
          store: { id: `shared-${randomUUID()}`, key: 'shared-store-key-00000000000000' },
          enableStorage: false,
        }),
        askarStorage: new PlanStableAskarStorageModule(true),
        didcomm: new DidCommModule({
          endpoints: [`http://127.0.0.1:${sharedPort}`],
          connections: { autoAcceptConnections: true },
        }),
        tenants: new TenantsModule(),
      },
    })
    ;(shared.modules as any).didcomm.registerInboundTransport(new DidCommHttpInboundTransport({ port: sharedPort }))
    ;(shared.modules as any).didcomm.registerOutboundTransport(new DidCommHttpOutboundTransport())

    holder = new Agent({
      config: { allowInsecureHttpUrls: true },
      dependencies: agentDependencies,
      modules: {
        askar: new AskarModule({
          askar,
          store: { id: `holder-${randomUUID()}`, key: 'holder-store-key-0000000000000' },
        }),
        didcomm: new DidCommModule({
          endpoints: [`http://127.0.0.1:${holderPort}`],
          connections: { autoAcceptConnections: true },
        }),
      },
    })
    ;(holder.modules as any).didcomm.registerInboundTransport(new DidCommHttpInboundTransport({ port: holderPort }))
    ;(holder.modules as any).didcomm.registerOutboundTransport(new DidCommHttpOutboundTransport())

    await shared.initialize()
    await holder.initialize()
    tenantId = ((await (shared.modules as any).tenants.createTenant({ config: { label: 'org' } })) as { id: string }).id
  }, 120000)

  afterAll(async () => {
    jest.restoreAllMocks()
    await holder?.shutdown().catch(() => undefined)
    await shared?.shutdown().catch(() => undefined)
  })

  // Credo errors carry their agent context, which Jest cannot serialise when a test fails: report only the message.
  const plain = async <T>(run: () => Promise<T>): Promise<T> => {
    try {
      return await run()
    } catch (error) {
      throw new Error(`${(error as Error)?.name}: ${(error as Error)?.message}\n${(error as Error)?.stack}`)
    }
  }

  it('uses the planned storage in the root and in tenant contexts', async () => {
    expect(shared.dependencyManager.resolve(InjectionSymbols.StorageService)).toBeInstanceOf(
      PlanStableAskarStorageService,
    )
    await withTenant(async (tenant) => {
      expect(tenant.dependencyManager.resolve(InjectionSymbols.StorageService)).toBeInstanceOf(
        PlanStableAskarStorageService,
      )
    })
  })

  it('connects a holder to the tenant and exchanges messages both ways', async () => {
    await plain(async () => {
      const invitation = await withTenant(
        async (tenant) => (await tenant.modules.didcomm.oob.createInvitation()).outOfBandInvitation,
      )
      const { connectionRecord } = await (holder.modules as any).didcomm.oob.receiveInvitation(invitation, {
        label: 'holder',
      })
      await (holder.modules as any).didcomm.connections.returnWhenIsConnected(connectionRecord.id, { timeoutMs: 20000 })

      const tenantConnection = await (async () => {
        let found: any
        await eventually(async () => {
          found = await withTenant(async (tenant) =>
            (await tenant.modules.didcomm.connections.getAll()).find(
              (connection: any) => connection.state === DidCommDidExchangeState.Completed,
            ),
          )
          return Boolean(found)
        }, 20000)
        return found
      })()

      await (holder.modules as any).didcomm.basicMessages.sendMessage(connectionRecord.id, 'hello tenant')
      await eventually(
        async () =>
          (await withTenant(async (tenant) => tenant.modules.didcomm.basicMessages.findAllByQuery({}))).some(
            (message: any) => message.content === 'hello tenant',
          ),
        20000,
      )
      await withTenant(async (tenant) =>
        tenant.modules.didcomm.basicMessages.sendMessage(tenantConnection.id, 'hello holder'),
      )
      await eventually(
        async () =>
          (await (holder.modules as any).didcomm.basicMessages.findAllByQuery({})).some(
            (message: any) => message.content === 'hello holder',
          ),
        20000,
      )

      // The tenant resolved its connection from the inbound message's DIDs (DidCommConnectionRepository.findByDids).
      expect(orQueries.length).toBeGreaterThan(0)
      expect(
        await withTenant(
          async (tenant) =>
            (
              await tenant.dependencyManager.resolve(DidCommConnectionRepository).findByDids(tenant.context, {
                ourDid: tenantConnection.did,
                theirDid: tenantConnection.theirDid,
              })
            )?.id,
        ),
      ).toBe(tenantConnection.id)
    })
  }, 90000)
})
