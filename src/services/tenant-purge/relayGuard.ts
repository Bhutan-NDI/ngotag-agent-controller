import type { RestMultiTenantAgentModules } from '../../cliAgent'
import type { Agent } from '@credo-ts/core'

import { ConflictError } from '../../errors/errors'

export const RELAY_NOT_FORWARDING = 'RELAY_NOT_FORWARDING'
export const RELAY_DISABLED = 'RELAY_DISABLED'

// The relay keeps its entry as this record in the base wallet (see RelayService), which survives a Redis flush.
const relayRecordId = (tenantId: string): string => `migration-relay-${tenantId}`

// The same condition the relay is built under (isRelayEnabled): with it off nothing forwards, whatever the record says.
const relayRunning = (): boolean => 'true' === process.env.MIGRATION_RELAY_ENABLED && Boolean(process.env.REDIS_URL)

/**
 * A tenant's wallet may only be purged once its messages are forwarded to the new agent: until then the wallet is the
 * only place those messages can be processed, and holders keep writing to the old address.
 * @throws ConflictError(RELAY_NOT_FORWARDING) when the tenant has no FORWARD relay with a target
 * @throws ConflictError(RELAY_DISABLED) when this agent is not running the relay, so nothing is being forwarded
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
  if (!relayRunning()) {
    throw new ConflictError(RELAY_DISABLED)
  }
}
