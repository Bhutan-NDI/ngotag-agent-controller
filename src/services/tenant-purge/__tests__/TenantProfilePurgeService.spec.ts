/**
 * Purge-profile against a real multi-tenant Credo agent on sqlite: the wallet goes, the TenantRecord and routing
 * records stay, and nothing re-creates the profile afterwards.
 */
import '@openwallet-foundation/askar-nodejs'
import { AskarModule, AskarMultiWalletDatabaseScheme, AskarStoreManager } from '@credo-ts/askar'
import { Agent, RecordNotFoundError } from '@credo-ts/core'
import { DidCommModule } from '@credo-ts/didcomm'
import { agentDependencies } from '@credo-ts/node'
import { TenantsModule } from '@credo-ts/tenants'
import { askar } from '@openwallet-foundation/askar-nodejs'
import { randomUUID } from 'crypto'

import { BadRequestError } from '../../../errors/errors'
import { isTenantMigrated } from '../../../utils/migratedTenant'
import { purgeTenantProfile } from '../TenantProfilePurgeService'

type TenantsApi = {
  createTenant: (o: unknown) => Promise<{ id: string }>
  getTenantById: (id: string) => Promise<{ getTag: (n: string) => unknown }>
  getAllTenants: () => Promise<Array<{ id: string; getTag: (n: string) => unknown }>>
  withTenantAgent: (o: { tenantId: string }, cb: (a: any) => Promise<unknown>) => Promise<unknown>
  findTenantsByQuery: (q: unknown) => Promise<unknown[]>
}

describe('purgeTenantProfile against a real multi-tenant agent', () => {
  let agent: Agent
  let tenants: TenantsApi
  let migrating: string
  let staying: string

  const profiles = async (): Promise<string[]> => {
    const { store } = await agent.dependencyManager
      .resolve(AskarStoreManager)
      .getInitializedStoreWithProfile(agent.context)
    return store.listProfiles()
  }

  // The relay's entry in the base wallet; purge-profile refuses until it forwards.
  const forwardRelay = (tenantId: string) =>
    agent.genericRecords.save({
      id: `migration-relay-${tenantId}`,
      content: { tenantId, mode: 'FORWARD', target: 'https://didcomm.org.example.org/' },
    })

  const seed = (tenantId: string) =>
    tenants.withTenantAgent({ tenantId }, async (tenantAgent) => {
      await tenantAgent.genericRecords.save({ id: 'marker', content: { owner: tenantId } })
      await tenantAgent.modules.didcomm.oob.createInvitation()
    })

  const routingRecordCount = (tenantId: string) =>
    agent.dependencyManager
      .resolve(AskarStoreManager)
      .getInitializedStoreWithProfile(agent.context)
      .then(async ({ store }) => {
        const session = await store.openSession()
        try {
          const rows = await session.fetchAll({ category: 'TenantRoutingRecord', tagFilter: { tenantId } })
          return rows.length
        } finally {
          await session.close()
        }
      })

  const relayEnv = { enabled: process.env.MIGRATION_RELAY_ENABLED, redis: process.env.REDIS_URL }

  beforeAll(async () => {
    process.env.MIGRATION_RELAY_ENABLED = 'true'
    process.env.REDIS_URL = 'redis://relay.example.org:6379'
    agent = new Agent({
      config: {},
      dependencies: agentDependencies,
      modules: {
        askar: new AskarModule({
          askar,
          store: { id: `purge-${randomUUID()}`, key: 'purge-store-key-000000000000000000' },
          multiWalletDatabaseScheme: AskarMultiWalletDatabaseScheme.ProfilePerWallet,
        }),
        didcomm: new DidCommModule({ endpoints: ['https://shared.example.org'] }),
        tenants: new TenantsModule(),
      },
    })
    await agent.initialize()
    tenants = (agent.modules as unknown as { tenants: TenantsApi }).tenants

    migrating = (await tenants.createTenant({ config: { label: 'migrating-org' } })).id
    staying = (await tenants.createTenant({ config: { label: 'staying-org' } })).id
    await seed(migrating)
    await seed(staying)
    await forwardRelay(migrating)
  }, 120000)

  afterAll(async () => {
    const restore = (name: string, value: string | undefined) =>
      undefined === value ? delete process.env[name] : (process.env[name] = value)
    restore('MIGRATION_RELAY_ENABLED', relayEnv.enabled)
    restore('REDIS_URL', relayEnv.redis)
    await agent.shutdown()
  })

  it('removes the tenant wallet, tags the TenantRecord migrated and keeps its routing records', async () => {
    const routingBefore = await routingRecordCount(migrating)
    expect(routingBefore).toBeGreaterThan(0)
    expect(await profiles()).toContain(`tenant-${migrating}`)

    const result = await purgeTenantProfile(agent as never, migrating)

    expect(result).toEqual({ tenantId: migrating, migrated: true, profileRemoved: true })
    expect(await profiles()).not.toContain(`tenant-${migrating}`)
    expect(isTenantMigrated(await tenants.getTenantById(migrating))).toBe(true)
    expect(await routingRecordCount(migrating)).toBe(routingBefore)
  }, 60000)

  it('leaves other tenants untouched', async () => {
    expect(await profiles()).toContain(`tenant-${staying}`)
    expect(isTenantMigrated(await tenants.getTenantById(staying))).toBe(false)

    await tenants.withTenantAgent({ tenantId: staying }, async (tenantAgent) => {
      const record = await tenantAgent.genericRecords.findById('marker')
      expect(record?.content).toEqual({ owner: staying })
    })
  }, 60000)

  it('is safe to repeat and does not re-create the profile', async () => {
    const result = await purgeTenantProfile(agent as never, migrating)

    expect(result).toEqual({ tenantId: migrating, migrated: true, profileRemoved: false })
    expect(await profiles()).not.toContain(`tenant-${migrating}`)
  }, 60000)

  it('finishes the removal when a previous attempt tagged the record but stopped before removing the wallet', async () => {
    const interrupted = (await tenants.createTenant({ config: { label: 'interrupted-org' } })).id
    await seed(interrupted)
    await forwardRelay(interrupted)
    const record = await tenants.getTenantById(interrupted)
    ;(record as unknown as { setTag: (n: string, v: boolean) => void }).setTag('migrated', true)
    await (
      agent.modules as unknown as { tenants: { updateTenant: (r: unknown) => Promise<void> } }
    ).tenants.updateTenant(record)

    const result = await purgeTenantProfile(agent as never, interrupted)

    expect(result.profileRemoved).toBe(true)
    expect(await profiles()).not.toContain(`tenant-${interrupted}`)
  }, 60000)

  it('fails reads and writes on the purged tenant instead of re-creating its wallet', async () => {
    await expect(
      tenants.withTenantAgent({ tenantId: migrating }, (tenantAgent) => tenantAgent.genericRecords.findById('marker')),
    ).rejects.toThrow()
    await expect(
      tenants.withTenantAgent({ tenantId: migrating }, (tenantAgent) =>
        tenantAgent.genericRecords.save({ id: 'late', content: {} }),
      ),
    ).rejects.toThrow()

    expect(await profiles()).not.toContain(`tenant-${migrating}`)
  }, 60000)

  it('lets a scan tell migrated tenants from live ones', async () => {
    const all = await tenants.getAllTenants()

    expect(all.filter(isTenantMigrated).map((tenant) => tenant.id)).toContain(migrating)
    expect(all.filter((tenant) => !isTenantMigrated(tenant)).map((tenant) => tenant.id)).toContain(staying)
  })

  it('refuses a database-per-wallet agent, where a repeat would provision a new empty store', async () => {
    const perWalletAgent = {
      dependencyManager: {
        resolve: () => ({ multiWalletDatabaseScheme: AskarMultiWalletDatabaseScheme.DatabasePerWallet }),
      },
    }

    await expect(purgeTenantProfile(perWalletAgent as never, staying)).rejects.toBeInstanceOf(BadRequestError)
    expect(await profiles()).toContain(`tenant-${staying}`)
  })

  it('throws RecordNotFoundError for an unknown tenant', async () => {
    await expect(purgeTenantProfile(agent as never, randomUUID())).rejects.toBeInstanceOf(RecordNotFoundError)
  })
})
