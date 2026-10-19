import { StorageUpdateService } from '@credo-ts/core'
import {
  DidCommConnectionsModuleConfig,
  DidCommCredentialsModuleConfig,
  DidCommHttpOutboundTransport,
  DidCommProofsModuleConfig,
  DidCommWsOutboundTransport,
} from '@credo-ts/didcomm'
import { DidCommHttpInboundTransport } from '@credo-ts/node'
import { jest } from '@jest/globals'

import { getAgentRuntimeConfig, getReleaseVersion, getStorageVersion } from '../agentInfo'

const buildAgent = () => {
  const getCurrentStorageVersion = jest.fn<() => Promise<string>>().mockResolvedValue('0.5')
  const resolvers = new Map<unknown, unknown>([
    [DidCommConnectionsModuleConfig, { autoAcceptConnections: true }],
    [DidCommCredentialsModuleConfig, { autoAcceptCredentials: 'always' }],
    [DidCommProofsModuleConfig, { autoAcceptProofs: 'contentApproved' }],
    [StorageUpdateService, { getCurrentStorageVersion }],
  ])
  const agent = {
    context: { contextCorrelationId: 'default' },
    dependencyManager: { resolve: (token: unknown) => resolvers.get(token) },
    modules: {
      didcomm: {
        config: {
          inboundTransports: [new DidCommHttpInboundTransport({ port: 0 })],
          outboundTransports: [new DidCommHttpOutboundTransport(), new DidCommWsOutboundTransport()],
        },
      },
    },
  }
  return { agent: agent as never, getCurrentStorageVersion }
}

describe('agentInfo', () => {
  const originalEnv = { ...process.env }

  afterEach(() => {
    process.env = { ...originalEnv }
  })

  describe('getAgentRuntimeConfig', () => {
    it('reports the autoAccept flags and transport names', () => {
      delete process.env.PURGE_ENABLED
      delete process.env.PURGE_CRON_ENABLED

      expect(getAgentRuntimeConfig(buildAgent().agent)).toEqual({
        autoAcceptConnections: true,
        autoAcceptCredentials: 'always',
        autoAcceptProofs: 'contentApproved',
        inboundTransports: ['http'],
        outboundTransports: ['http', 'ws'],
        cronPurgeEnabled: false,
      })
    })

    it('reports cron purge only when both the master switch and the cron flag are on', () => {
      process.env.PURGE_ENABLED = 'true'
      process.env.PURGE_CRON_ENABLED = 'true'
      expect(getAgentRuntimeConfig(buildAgent().agent).cronPurgeEnabled).toBe(true)

      process.env.PURGE_ENABLED = 'false'
      expect(getAgentRuntimeConfig(buildAgent().agent).cronPurgeEnabled).toBe(false)
    })
  })

  describe('getStorageVersion', () => {
    it('reads the version from the storage update service for the agent context', async () => {
      const { agent, getCurrentStorageVersion } = buildAgent()

      await expect(getStorageVersion(agent)).resolves.toBe('0.5')
      expect(getCurrentStorageVersion).toHaveBeenCalledWith((agent as { context: unknown }).context)
    })
  })

  describe('getReleaseVersion', () => {
    it('prefers RELEASE_VERSION', () => {
      process.env.RELEASE_VERSION = 'agent-controller/v1.2.3'
      expect(getReleaseVersion()).toBe('agent-controller/v1.2.3')
    })

    it('falls back to the package.json version', () => {
      delete process.env.RELEASE_VERSION
      expect(getReleaseVersion()).toMatch(/^\d+\.\d+\.\d+/)
    })
  })
})
