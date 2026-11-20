import type { AgentRuntimeConfig } from '../controllers/types'
import type { Request } from 'express'

import { StorageUpdateService } from '@credo-ts/core'
import {
  DidCommConnectionsModuleConfig,
  DidCommCredentialsModuleConfig,
  DidCommHttpOutboundTransport,
  DidCommProofsModuleConfig,
  DidCommWsOutboundTransport,
} from '@credo-ts/didcomm'
import { DidCommHttpInboundTransport, DidCommWsInboundTransport } from '@credo-ts/node'

const transportName = (transport: object): string => {
  if (transport instanceof DidCommHttpInboundTransport) return 'http'
  if (transport instanceof DidCommWsInboundTransport) return 'ws'
  if (transport instanceof DidCommHttpOutboundTransport) return 'http'
  if (transport instanceof DidCommWsOutboundTransport) return 'ws'
  return transport.constructor.name
}

export const getReleaseVersion = (): string | undefined => process.env.RELEASE_VERSION || undefined

export const getAgentRuntimeConfig = (agent: Request['agent']): AgentRuntimeConfig => {
  const { dependencyManager } = agent
  const didcommConfig = agent.modules.didcomm.config

  return {
    autoAcceptConnections: dependencyManager.resolve(DidCommConnectionsModuleConfig).autoAcceptConnections,
    autoAcceptCredentials: dependencyManager.resolve(DidCommCredentialsModuleConfig).autoAcceptCredentials,
    autoAcceptProofs: dependencyManager.resolve(DidCommProofsModuleConfig).autoAcceptProofs,
    inboundTransports: didcommConfig.inboundTransports.map(transportName),
    outboundTransports: didcommConfig.outboundTransports.map(transportName),
    cronPurgeEnabled: process.env.PURGE_ENABLED === 'true' && process.env.PURGE_CRON_ENABLED === 'true',
    tenancy: undefined !== (agent.modules as { tenants?: unknown }).tenants,
  }
}

// A profile with no record is reported at the framework version it is upgraded to when opened; reading it must not
// create the record, because Credo would write the initial "0.1" and later replay migrations on current data.
export const getStorageVersion = async (agent: Request['agent']): Promise<string> => {
  const storageUpdateService = agent.dependencyManager.resolve(StorageUpdateService)
  return (await storageUpdateService.hasStorageVersionRecord(agent.context))
    ? storageUpdateService.getCurrentStorageVersion(agent.context)
    : StorageUpdateService.frameworkStorageVersion
}
