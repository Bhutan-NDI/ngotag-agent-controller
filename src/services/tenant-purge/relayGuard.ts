import type { RestMultiTenantAgentModules } from '../../cliAgent'
import type { Agent } from '@credo-ts/core'

import { ConflictError } from '../../errors/errors'

export const RELAY_NOT_FORWARDING = 'RELAY_NOT_FORWARDING'
export const TENANT_HAS_RELAY = 'TENANT_HAS_RELAY'

// The relay keeps its entry as this record in the base wallet (see RelayService), which survives a Redis flush.
const relayRecordId = (tenantId: string): string => `migration-relay-${tenantId}`

/**
 * A tenant's wallet may only be purged once its messages are forwarded to the new agent: until then the wallet is the
 * only place those messages can be processed, and holders keep writing to the old address.
 * @throws ConflictError(RELAY_NOT_FORWARDING) when the tenant has no FORWARD relay with a target
 */
export const assertRelayForwarding = async (
  agent: Agent<RestMultiTenantAgentModules>,
  tenantId: string,
): Promise<void> => {
  const record = await agent.genericRecords.findById(relayRecordId(tenantId))
  const { mode, target } = (record?.content ?? {}) as { mode?: string; target?: string }

  if ('FORWARD' !== mode || !target) {
    throw new ConflictError(RELAY_NOT_FORWARDING)
  }
}

/**
 * Deleting a tenant removes the routing records its relay forwards by, so it waits until the relay is gone.
 * @throws ConflictError(TENANT_HAS_RELAY) when the tenant has a relay entry in any mode
 */
export const assertNoRelay = async (agent: Agent<RestMultiTenantAgentModules>, tenantId: string): Promise<void> => {
  if (await agent.genericRecords.findById(relayRecordId(tenantId))) {
    throw new ConflictError(TENANT_HAS_RELAY)
  }
}
