/**
 * purge-profile refuses until the tenant's relay forwards to the new agent, and a refused purge changes nothing.
 * Real multi-tenant agent on sqlite; the relay's entry is the base-wallet record the relay itself writes.
 */
import '@openwallet-foundation/askar-nodejs'
import { AskarModule, AskarMultiWalletDatabaseScheme, AskarStoreManager } from '@credo-ts/askar'
import { Agent } from '@credo-ts/core'
import { DidCommModule } from '@credo-ts/didcomm'
import { agentDependencies } from '@credo-ts/node'
import { TenantsModule } from '@credo-ts/tenants'
import { askar } from '@openwallet-foundation/askar-nodejs'
import { randomUUID } from 'crypto'

import ErrorHandlingService from '../../../errorHandlingService'
import { ConflictError } from '../../../errors/errors'
import { isTenantMigrated } from '../../../utils/migratedTenant'
import { purgeTenantProfile } from '../TenantProfilePurgeService'
import { assertRelayForwarding, RELAY_NOT_FORWARDING } from '../relayGuard'

type TenantsApi = {
  createTenant: (o: unknown) => Promise<{ id: string }>
  getTenantById: (id: string) => Promise<{ getTag: (n: string) => unknown }>
  withTenantAgent: <T>(o: { tenantId: string }, cb: (a: any) => Promise<T>) => Promise<T>
}

const TARGET = 'https://didcomm.org.example.org/'

describe('purge-profile needs a forwarding relay', () => {
  let agent: Agent
  let tenants: TenantsApi

  const newTenant = async (label: string): Promise<string> => {
    const { id } = await tenants.createTenant({ config: { label } })
    await tenants.withTenantAgent({ tenantId: id }, (tenantAgent) =>
      tenantAgent.genericRecords.save({ id: 'marker', content: { owner: id } }),
    )
    return id
  }

  const setRelay = async (tenantId: string, content: Record<string, unknown>) => {
    const existing = await agent.genericRecords.findById(`migration-relay-${tenantId}`)
    if (existing) {
      existing.content = { tenantId, ...content }
      await agent.genericRecords.update(existing)
      return
    }
    await agent.genericRecords.save({ id: `migration-relay-${tenantId}`, content: { tenantId, ...content } })
  }

  const profiles = async (): Promise<string[]> => {
    const { store } = await agent.dependencyManager
      .resolve(AskarStoreManager)
      .getInitializedStoreWithProfile(agent.context)
    return store.listProfiles()
  }

  const untouched = async (tenantId: string) => {
    expect(await profiles()).toContain(`tenant-${tenantId}`)
    expect(isTenantMigrated(await tenants.getTenantById(tenantId))).toBe(false)
    const marker = (await tenants.withTenantAgent({ tenantId }, (tenantAgent) =>
      tenantAgent.genericRecords.findById('marker'),
    )) as { content?: unknown } | null
    expect(marker?.content).toEqual({ owner: tenantId })
  }

  beforeAll(async () => {
    agent = new Agent({
      config: {},
      dependencies: agentDependencies,
      modules: {
        askar: new AskarModule({
          askar,
          store: { id: `guard-${randomUUID()}`, key: 'guard-store-key-0000000000000000000' },
          multiWalletDatabaseScheme: AskarMultiWalletDatabaseScheme.ProfilePerWallet,
        }),
        didcomm: new DidCommModule({ endpoints: ['https://shared.example.org'] }),
        tenants: new TenantsModule(),
      },
    })
    await agent.initialize()
    tenants = (agent.modules as unknown as { tenants: TenantsApi }).tenants
  }, 120000)

  afterAll(async () => {
    await agent.shutdown()
  })

  it.each([
    ['has no relay at all', undefined],
    ['has a relay that is only holding', { mode: 'HOLD' }],
    ['has a forwarding relay with no target', { mode: 'FORWARD' }],
    ['has a forwarding relay with an empty target', { mode: 'FORWARD', target: '' }],
  ])(
    'refuses a tenant that %s, and changes nothing',
    async (_name, relay) => {
      const tenantId = await newTenant(`org-${randomUUID()}`)
      if (relay) await setRelay(tenantId, relay)

      const error = await purgeTenantProfile(agent as never, tenantId).catch((e: unknown) => e)

      expect(error).toBeInstanceOf(ConflictError)
      expect((error as ConflictError).message).toBe(RELAY_NOT_FORWARDING)
      await untouched(tenantId)
    },
    60000,
  )

  it('answers 409 through the error handler the route uses', async () => {
    const tenantId = await newTenant(`org-${randomUUID()}`)
    const error = await purgeTenantProfile(agent as never, tenantId).catch((e: unknown) => e)

    let handled: unknown
    try {
      ErrorHandlingService.handle(error)
    } catch (converted) {
      handled = converted
    }

    expect(handled).toMatchObject({ statusCode: 409, message: RELAY_NOT_FORWARDING })
  }, 60000)

  it('purges a tenant whose relay forwards, and is safe to repeat', async () => {
    const tenantId = await newTenant(`org-${randomUUID()}`)
    await setRelay(tenantId, { mode: 'FORWARD', target: TARGET })

    await expect(purgeTenantProfile(agent as never, tenantId)).resolves.toEqual({
      tenantId,
      migrated: true,
      profileRemoved: true,
    })
    await expect(purgeTenantProfile(agent as never, tenantId)).resolves.toMatchObject({ profileRemoved: false })

    expect(await profiles()).not.toContain(`tenant-${tenantId}`)
  }, 60000)

  it('purges once a held relay has moved on to forwarding', async () => {
    const tenantId = await newTenant(`org-${randomUUID()}`)
    await setRelay(tenantId, { mode: 'HOLD' })
    await expect(purgeTenantProfile(agent as never, tenantId)).rejects.toBeInstanceOf(ConflictError)

    await setRelay(tenantId, { mode: 'FORWARD', target: TARGET })

    await expect(purgeTenantProfile(agent as never, tenantId)).resolves.toMatchObject({ profileRemoved: true })
  }, 60000)

  it("does not let another tenant's forwarding relay stand in", async () => {
    const forwarding = await newTenant(`org-${randomUUID()}`)
    const other = await newTenant(`org-${randomUUID()}`)
    await setRelay(forwarding, { mode: 'FORWARD', target: TARGET })

    await expect(purgeTenantProfile(agent as never, other)).rejects.toBeInstanceOf(ConflictError)

    await untouched(other)
  }, 60000)

  it('checks the guard against the tenant that is asked about, not a stale record', async () => {
    const tenantId = await newTenant(`org-${randomUUID()}`)
    await setRelay(tenantId, { mode: 'FORWARD', target: TARGET })

    await expect(assertRelayForwarding(agent as never, tenantId)).resolves.toBeUndefined()
    await expect(assertRelayForwarding(agent as never, randomUUID())).rejects.toBeInstanceOf(ConflictError)
  }, 60000)
})
