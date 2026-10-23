/**
 * GET /agent is open to tenant tokens: reading the storage version of a tenant profile that has no record must not
 * write one. Real multi-tenant agent on sqlite.
 */
import '@openwallet-foundation/askar-nodejs'
import { AskarModule, AskarMultiWalletDatabaseScheme } from '@credo-ts/askar'
import { Agent, StorageUpdateService } from '@credo-ts/core'
import { DidCommModule } from '@credo-ts/didcomm'
import { agentDependencies } from '@credo-ts/node'
import { TenantsModule } from '@credo-ts/tenants'
import { askar } from '@openwallet-foundation/askar-nodejs'
import { randomUUID } from 'crypto'

import { getStorageVersion } from '../agentInfo'

describe('getStorageVersion on a tenant profile', () => {
  let agent: Agent
  let tenantId: string

  beforeAll(async () => {
    agent = new Agent({
      config: {},
      dependencies: agentDependencies,
      modules: {
        askar: new AskarModule({
          askar,
          store: { id: `info-${randomUUID()}`, key: 'info-store-key-0000000000000000000000' },
          multiWalletDatabaseScheme: AskarMultiWalletDatabaseScheme.ProfilePerWallet,
        }),
        didcomm: new DidCommModule({ endpoints: ['https://shared.example.org'] }),
        tenants: new TenantsModule(),
      },
    })
    await agent.initialize()
    tenantId = ((await (agent.modules as any).tenants.createTenant({ config: { label: 'tenant' } })) as { id: string })
      .id
  }, 120000)

  afterAll(async () => {
    await agent.shutdown()
  })

  it('leaves a tenant without a storage version record without one', async () => {
    await (agent.modules as any).tenants.withTenantAgent({ tenantId }, async (tenant: Agent) => {
      const service = tenant.dependencyManager.resolve(StorageUpdateService)
      expect(await service.hasStorageVersionRecord(tenant.context)).toBe(false)

      await expect(getStorageVersion(tenant as never)).resolves.toBe(StorageUpdateService.frameworkStorageVersion)

      expect(await service.hasStorageVersionRecord(tenant.context)).toBe(false)
    })
  }, 60000)

  it('reports the stored version of the root profile, which has a record', async () => {
    await expect(getStorageVersion(agent as never)).resolves.toMatch(/^\d+\.\d+/)
  }, 60000)
})
