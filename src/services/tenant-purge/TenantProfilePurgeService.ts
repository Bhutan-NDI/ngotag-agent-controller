import type { RestMultiTenantAgentModules } from '../../cliAgent'
import type { Agent, AgentContextProvider } from '@credo-ts/core'

import { AskarModuleConfig, AskarMultiWalletDatabaseScheme, AskarStoreManager } from '@credo-ts/askar'
import { CacheModuleConfig, InjectionSymbols } from '@credo-ts/core'

import { BadRequestError, ConflictError } from '../../errors/errors'
import { MIGRATED_TENANT_TAG, isTenantMigrated } from '../../utils/migratedTenant'

export interface PurgeTenantProfileResult {
  tenantId: string
  migrated: true
  profileRemoved: boolean
}

const SESSION_WAIT_MS = 10_000
const SESSION_POLL_MS = 200

// Credo does not export its session coordinator; the context provider holds it.
const openSessions = (agent: Agent<RestMultiTenantAgentModules>, tenantId: string): number => {
  const provider = agent.dependencyManager.resolve<{
    tenantSessionCoordinator?: { getSessionCountForTenant(tenantId: string): number }
  }>(InjectionSymbols.AgentContextProvider)
  return provider.tenantSessionCoordinator?.getSessionCountForTenant(tenantId) ?? 0
}

const tenantProfileExists = async (agent: Agent<RestMultiTenantAgentModules>, tenantId: string): Promise<boolean> => {
  const { store } = await agent.dependencyManager
    .resolve(AskarStoreManager)
    .getInitializedStoreWithProfile(agent.context)
  return (await store.listProfiles()).includes(`tenant-${tenantId}`)
}

/**
 * Removes a tenant's wallet from the shared agent but keeps its TenantRecord (tagged `migrated`) and routing
 * records. The tag is written first and the call is safe to repeat after a partial failure.
 */
export const purgeTenantProfile = async (
  agent: Agent<RestMultiTenantAgentModules>,
  tenantId: string,
  sessionWaitMs: number = SESSION_WAIT_MS,
): Promise<PurgeTenantProfileResult> => {
  if (
    agent.dependencyManager.resolve(AskarModuleConfig).multiWalletDatabaseScheme !==
    AskarMultiWalletDatabaseScheme.ProfilePerWallet
  ) {
    throw new BadRequestError('purge-profile needs the ProfilePerWallet wallet scheme')
  }

  const tenant = await agent.modules.tenants.getTenantById(tenantId)

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
  // Deleting the context under another session would make that session's end fail and leak its pool slot.
  const deadline = Date.now() + sessionWaitMs
  while (openSessions(agent, tenantId) > 1) {
    if (Date.now() >= deadline) {
      await tenantAgent.endSession()
      throw new ConflictError(`Tenant '${tenantId}' still has open sessions; try again shortly`)
    }
    await new Promise((resolve) => setTimeout(resolve, SESSION_POLL_MS))
  }
  await agent.dependencyManager
    .resolve<AgentContextProvider>(InjectionSymbols.AgentContextProvider)
    .deleteAgentContext(tenantAgent.context)

  return { tenantId, migrated: true, profileRemoved: true }
}
