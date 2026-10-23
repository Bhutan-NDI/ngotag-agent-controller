/**
 * The relay's lookups depend on two things only a real multi-tenant Credo agent can confirm: that the fingerprint
 * computed from an envelope's `kid` equals what Credo stores in the tenant's routing record, and that those records
 * can be listed through the storage service. Nothing here is mocked except Redis and S3-free stores.
 */
import '@openwallet-foundation/askar-nodejs'
import { AskarModule } from '@credo-ts/askar'
import { Agent, LogLevel, didKeyToVerkey } from '@credo-ts/core'
import { DidCommModule } from '@credo-ts/didcomm'
import { agentDependencies } from '@credo-ts/node'
import { TenantsModule } from '@credo-ts/tenants'
import { askar } from '@openwallet-foundation/askar-nodejs'
import { randomUUID } from 'crypto'

import { TsLogger } from '../../../utils/logger'
import { RelayService } from '../RelayService'
import { RelayStore } from '../RelayStore'
import { extractRecipientFingerprints } from '../relayEnvelope'

import { FakeRedis, buildEnvelope, eventually } from './testSupport'

describe('relay against a real multi-tenant Credo agent', () => {
  let agent: Agent
  let tenantId: string
  let otherTenantId: string
  let invitationKid: string
  let service: RelayService
  let store: RelayStore

  const createInvitationKid = async (id: string): Promise<string> => {
    let kid = ''
    await (agent.modules as any).tenants.withTenantAgent({ tenantId: id }, async (tenantAgent: any) => {
      const { outOfBandInvitation } = await tenantAgent.modules.didcomm.oob.createInvitation()
      const [service] = outOfBandInvitation.getInlineServices()
      kid = didKeyToVerkey(service.recipientKeys[0])
    })
    return kid
  }

  beforeAll(async () => {
    agent = new Agent({
      config: {},
      dependencies: agentDependencies,
      modules: {
        askar: new AskarModule({
          askar,
          store: { id: `relay-${randomUUID()}`, key: 'relay-store-key-0000000000000000' },
        }),
        didcomm: new DidCommModule({ endpoints: ['https://shared.example.org'] }),
        tenants: new TenantsModule(),
      },
    })
    await agent.initialize()

    const tenants = (agent.modules as any).tenants
    tenantId = (await tenants.createTenant({ config: { label: 'migrating-org' } })).id
    otherTenantId = (await tenants.createTenant({ config: { label: 'other-org' } })).id
    invitationKid = await createInvitationKid(tenantId)
    await createInvitationKid(otherTenantId)
  }, 120000)

  afterAll(async () => {
    await agent.shutdown()
  })

  beforeEach(() => {
    store = new RelayStore(new FakeRedis())
    service = new RelayService(
      store,
      { ensureDraining: () => undefined } as never,
      new TsLogger(LogLevel.error, 'test'),
    )
  })

  it('computes, from an envelope addressed to a tenant, the fingerprint Credo stored for that tenant', async () => {
    const [fingerprint] = extractRecipientFingerprints(buildEnvelope([invitationKid]))

    await eventually(async () => {
      const status = await service.put(agent as never, tenantId, { mode: 'HOLD' })
      return 1 <= status.recipientKeys
    }, 15000)

    await expect(store.findTenantIdByFingerprints([fingerprint])).resolves.toBe(tenantId)
  }, 60000)

  it("indexes only the migrating tenant's keys, never another tenant's", async () => {
    await service.put(agent as never, tenantId, { mode: 'HOLD' })
    const [otherFingerprint] = extractRecipientFingerprints(buildEnvelope([await createInvitationKid(otherTenantId)]))

    await expect(store.findTenantIdByFingerprints([otherFingerprint])).resolves.toBeUndefined()
  }, 60000)

  it('keeps the relay as a record in the base wallet that a restart can rebuild from', async () => {
    await service.put(agent as never, tenantId, { mode: 'FORWARD', target: 'https://agent.example.org/' })
    const [fingerprint] = extractRecipientFingerprints(buildEnvelope([invitationKid]))

    const restarted = new RelayStore(new FakeRedis())
    const afterRestart = new RelayService(
      restarted,
      { ensureDraining: () => undefined } as never,
      new TsLogger(LogLevel.error, 'test'),
    )

    await expect(afterRestart.rehydrate(agent as never)).resolves.toBe(1)
    await expect(restarted.getEntry(tenantId)).resolves.toMatchObject({
      mode: 'FORWARD',
      target: 'https://agent.example.org/',
    })
    await expect(restarted.findTenantIdByFingerprints([fingerprint])).resolves.toBe(tenantId)
  }, 60000)
})
