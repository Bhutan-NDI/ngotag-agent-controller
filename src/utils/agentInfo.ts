import type { AgentRuntimeConfig } from '../controllers/types'
import type { Request } from 'express'

import { StorageUpdateService } from '@credo-ts/core'
import {
  DidCommConnectionsModuleConfig,
  DidCommCredentialsModuleConfig,
  DidCommProofsModuleConfig,
} from '@credo-ts/didcomm'
import { DidCommHttpInboundTransport, DidCommWsInboundTransport } from '@credo-ts/node'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const transportName = (transport: object): string => {
  if (transport instanceof DidCommHttpInboundTransport) return 'http'
  if (transport instanceof DidCommWsInboundTransport) return 'ws'
  return transport.constructor.name.toLowerCase().includes('ws') ? 'ws' : 'http'
}

export const getReleaseVersion = (): string | undefined => {
  if (process.env.RELEASE_VERSION) return process.env.RELEASE_VERSION
  try {
    return JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')).version
  } catch {
    return undefined
  }
}

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
  }
}

export const getStorageVersion = (agent: Request['agent']): Promise<string> =>
  agent.dependencyManager.resolve(StorageUpdateService).getCurrentStorageVersion(agent.context)
