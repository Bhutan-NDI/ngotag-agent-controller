import type { RestMultiTenantAgentModules } from '../../cliAgent'
import type { Agent, AgentContextProvider } from '@credo-ts/core'

import { AskarModuleConfig, AskarMultiWalletDatabaseScheme, AskarStoreManager } from '@credo-ts/askar'
import { CacheModuleConfig, InjectionSymbols } from '@credo-ts/core'

import { BadRequestError } from '../../errors/errors'
import { MIGRATED_TENANT_TAG, isTenantMigrated } from '../../utils/migratedTenant'

import { assertRelayForwarding } from './relayGuard'

export interface PurgeTenantProfileResult {
  tenantId: string
  migrated: true
  profileRemoved: boolean
}

const tenantProfileExists = async (agent: Agent<RestMultiTenantAgentModules>, tenantId: string): Promise<boolean> => {
  const { store } = await agent.dependencyManager
    .resolve(AskarStoreManager)
    .getInitializedStoreWithProfile(agent.context)
  return (await store.listProfiles()).includes(`tenant-${tenantId}`)
}

/**
 * Removes a tenant's wallet from the shared agent but keeps its TenantRecord (tagged `migrated`) and routing
 * records. Refused until the tenant's relay forwards to the new agent. The tag is written first and the call is safe to
 * repeat after a partial failure.
 */
export const purgeTenantProfile = async (
  agent: Agent<RestMultiTenantAgentModules>,
  tenantId: string,
): Promise<PurgeTenantProfileResult> => {
  if (
    agent.dependencyManager.resolve(AskarModuleConfig).multiWalletDatabaseScheme !==
    AskarMultiWalletDatabaseScheme.ProfilePerWallet
  ) {
    throw new BadRequestError('purge-profile needs the ProfilePerWallet wallet scheme')
  }

  const tenant = await agent.modules.tenants.getTenantById(tenantId)
  await assertRelayForwarding(agent, tenantId)

  if (!isTenantMigrated(tenant)) {
    tenant.setTag(MIGRATED_TENANT_TAG, true)
    await agent.modules.tenants.updateTenant(tenant)
  }
  await agent.dependencyManager
    .resolve(CacheModuleConfig)
    .cache.remove(agent.context, `tenantRecord:${tenantId}`)
    .catch((error: unknown) => agent.config.logger.warn(`Failed to invalidate tenant cache for ${tenantId}: ${error}`))

  if (!(await tenantProfileExists(agent, tenantId))) {
    return { tenantId, migrated: true, profileRemoved: false }
  }

  const tenantAgent = await agent.modules.tenants.getTenantAgent({ tenantId })
  await agent.dependencyManager
    .resolve<AgentContextProvider>(InjectionSymbols.AgentContextProvider)
    .deleteAgentContext(tenantAgent.context)

  return { tenantId, migrated: true, profileRemoved: true }
}
