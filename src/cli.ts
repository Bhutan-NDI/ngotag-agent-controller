import type { AriesRestConfig } from './cliAgent.js'

import dotenv from 'dotenv'

dotenv.config()

import { parseArguments } from './cli.parser.js'
import { runRestAgent } from './cliAgent.js'

export async function runCliServer() {
  const parsed = await parseArguments()

  await runRestAgent({
    label: parsed.label,
    walletConfig: {
      id: parsed['wallet-id'],
      key: parsed['wallet-key'],
      database: {
        type: parsed['wallet-type'],
        config: {
          host: parsed['wallet-url'],
          connectTimeout: parsed['wallet-connect-timeout'] || Number(process.env.CONNECT_TIMEOUT),
          maxConnections: parsed['wallet-max-connections'] || Number(process.env.MAX_CONNECTIONS),
          idleTimeout: parsed['wallet-idle-timeout'] || Number(process.env.IDLE_TIMEOUT),
        },
        credentials: {
          account: parsed['wallet-account'],
          password: parsed['wallet-password'],
          adminAccount: parsed['wallet-admin-account'],
          adminPassword: parsed['wallet-admin-password'],
        },
      },
    },
    indyLedger: parsed['indy-ledger'],
    endpoints: parsed.endpoint,
    autoAcceptConnections: parsed['auto-accept-connections'],
    autoAcceptCredentials: parsed['auto-accept-credentials'],
    autoAcceptProofs: parsed['auto-accept-proofs'],
    logLevel: parsed['log-level'],
    inboundTransports: parsed['inbound-transport'],
    outboundTransports: parsed['outbound-transport'],
    webhookUrl: parsed['webhook-url'],
    adminPort: parsed['admin-port'],
    tenancy: parsed.tenancy,
    schemaFileServerURL: parsed.schemaFileServerURL,
    didRegistryContractAddress: parsed.didRegistryContractAddress,
    schemaManagerContractAddress: parsed.schemaManagerContractAddress,
    rpcUrl: parsed.rpcUrl,
    fileServerUrl: parsed.fileServerUrl,
    fileServerToken: parsed.fileServerToken,
    ethereumNetworkName: parsed.ethereumNetworkName || parsed.chainName,
    ethereumChainId: parsed.ethereumChainId || parsed.chainId,
    ethereumRegistry: parsed.ethereumRegistry || parsed.registry,
    ethereumSchemaManagerContractAddress: parsed.ethereumSchemaManagerContractAddress,
    ethereumRpcUrl: parsed.ethereumRpcUrl,
    apiKey: parsed['apiKey'],
    updateJwtSecret: parsed['updateJwtSecret'],
  } as unknown as AriesRestConfig)
}
