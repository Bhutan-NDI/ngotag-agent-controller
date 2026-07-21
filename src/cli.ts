import type { AriesRestConfig } from './cliAgent'

import yargs from 'yargs'

import { runRestAgent } from './cliAgent'

interface IndyLedger {
  genesisTransactions: string
  indyNamespace: string
}

interface Parsed {
  label: string
  'wallet-id': string
  'wallet-key': string
  'wallet-type': string
  'wallet-url': string
  'wallet-scheme': string
  'wallet-account': string
  'wallet-password': string
  'wallet-admin-account': string
  'wallet-admin-password': string
  'indy-ledger': IndyLedger[]
  endpoint?: string[]
  'log-level': number
  'outbound-transport': ('http' | 'ws')[]
  'inbound-transport'?: InboundTransport[]
  'auto-accept-connections'?: boolean
  'auto-accept-credentials'?: 'always' | 'never' | 'contentApproved'
  'auto-accept-proofs'?: 'always' | 'never' | 'contentApproved'
  'webhook-url'?: string
  'admin-port': number
  tenancy: boolean
  'did-registry-contract-address'?: string
  'schema-manager-contract-address'?: string
  'wallet-connect-timeout'?: number
  'wallet-max-connections'?: number
  'wallet-idle-timeout'?: number
  schemaFileServerURL?: string
  didRegistryContractAddress?: string
  schemaManagerContractAddress?: string
  rpcUrl?: string
  fileServerUrl?: string
  fileServerToken?: string
  ethereumNetworkName?: string
  ethereumChainId?: string
  ethereumRegistry?: string
  ethereumSchemaManagerContractAddress?: string
  ethereumRpcUrl?: string
  chainId?: string
  chainName?: string
  registry?: string
}

interface InboundTransport {
  transport: Transports
  port: number
}

type Transports = 'http' | 'ws'

async function parseArguments(): Promise<Parsed> {
  return yargs
    .command('start', 'Start Credo Rest agent')
    .option('label', {
      alias: 'l',
      string: true,
      demandOption: true,
    })
    .option('wallet-id', {
      string: true,
      demandOption: true,
    })
    .option('wallet-key', {
      string: true,
      demandOption: true,
    })
    .option('wallet-type', {
      string: true,
      demandOption: true,
    })
    .option('wallet-url', {
      string: true,
      demandOption: true,
    })
    .option('wallet-scheme', {
      string: true,
      demandOption: true,
    })
    .option('wallet-account', {
      string: true,
      demandOption: true,
    })
    .option('wallet-password', {
      string: true,
      demandOption: true,
    })
    .option('wallet-admin-account', {
      string: true,
      demandOption: true,
    })
    .option('wallet-admin-password', {
      string: true,
      demandOption: true,
    })
    .option('chainId', {
      string: true,
      demandOption: false,
    })
    .option('chainName', {
      string: true,
      demandOption: false,
    })
    .option('registry', {
      string: true,
      demandOption: false,
    })
    .option('ethereum-network-name', {
      string: true,
      demandOption: false,
    })
    .option('ethereum-chain-id', {
      string: true,
      demandOption: false,
    })
    .option('ethereum-registry', {
      string: true,
      demandOption: false,
    })
    .option('ethereum-schema-manager-contract-address', {
      string: true,
      demandOption: false,
    })
    .option('ethereum-rpc-url', {
      string: true,
      demandOption: false,
    })
    .option('indy-ledger', {
      array: true,
      default: [],
      coerce: (input) => {
        return input.map((item: { genesisTransactions: string; indyNamespace: string }) => ({
          genesisTransactions: item.genesisTransactions,
          indyNamespace: item.indyNamespace,
        }))
      },
    })
    .option('endpoint', {
      array: true,
      coerce: (input) => {
        return input.map((item: string) => String(item))
      },
    })
    .option('log-level', {
      number: true,
      default: 3,
    })
    .option('outbound-transport', {
      array: true,
      coerce: (input) => {
        const validValues = ['http', 'ws']
        return input.map((item: string) => {
          if (validValues.includes(item)) {
            return item as 'http' | 'ws'
          } else {
            throw new Error(`Invalid value for outbound-transport: ${item}. Valid values are 'http' or 'ws'.`)
          }
        })
      },
    })
    .option('inbound-transport', {
      array: true,
      coerce: (input) => {
        const transports: InboundTransport[] = []
        for (const item of input) {
          if (
            typeof item === 'object' &&
            'transport' in item &&
            typeof item.transport === 'string' &&
            'port' in item &&
            typeof item.port === 'number'
          ) {
            const transport: Transports = item.transport as Transports
            const port: number = item.port
            transports.push({ transport, port })
          } else {
            throw new Error(
              'Inbound transport should be specified as an array of objects with transport and port properties.'
            )
          }
        }
        return transports
      },
    })
    .option('auto-accept-connections', {
      boolean: true,
      default: false,
    })
    .option('auto-accept-credentials', {
      choices: ['always', 'never', 'contentApproved'],
      coerce: (input: string) => {
        if (input === 'always' || input === 'never' || input === 'contentApproved') {
          return input as 'always' | 'never' | 'contentApproved'
        } else {
          throw new Error(
            'Invalid value for auto-accept-credentials. Valid values are "always", "never", or "contentApproved".'
          )
        }
      },
    })
    .option('auto-accept-proofs', {
      choices: ['always', 'never', 'contentApproved'],
      coerce: (input: string) => {
        if (input === 'always' || input === 'never' || input === 'contentApproved') {
          return input as 'always' | 'never' | 'contentApproved'
        } else {
          throw new Error(
            'Invalid value for auto-accept-proofs. Valid values are "always", "never", or "contentApproved".'
          )
        }
      },
    })
    .option('webhook-url', {
      string: true,
    })
    .option('admin-port', {
      number: true,
      demandOption: true,
    })
    .option('tenancy', {
      boolean: true,
      default: false,
    })
    .option('did-registry-contract-address', {
      string: true,
    })
    .option('schema-manager-contract-address', {
      string: true,
    })
    .option('wallet-connect-timeout', {
      number: true,
    })
    .option('wallet-max-connections', {
      number: true,
    })
    .option('wallet-idle-timeout', {
      number: true,
    })
    .config()
    .env('AFJ_REST')
    .parseAsync() as Promise<Parsed>
}

export async function runCliServer() {
  const parsed = await parseArguments()

  await runRestAgent({
    label: parsed.label,
    walletConfig: {
      id: parsed['wallet-id'],
      key: parsed['wallet-key'],
      storage: {
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
    tenancy: parsed['tenancy'],
    schemaFileServerURL: parsed['schemaFileServerURL'],
    didRegistryContractAddress: parsed['didRegistryContractAddress'],
    schemaManagerContractAddress: parsed['schemaManagerContractAddress'],
    rpcUrl: parsed['rpcUrl'],
    fileServerUrl: parsed['fileServerUrl'],
    fileServerToken: parsed['fileServerToken'],
    ethereumNetworkName: parsed['ethereumNetworkName'] || parsed['chainName'],
    ethereumChainId: parsed['ethereumChainId'] || parsed['chainId'],
    ethereumRegistry: parsed['ethereumRegistry'] || parsed['registry'],
    ethereumSchemaManagerContractAddress: parsed['ethereumSchemaManagerContractAddress'],
    ethereumRpcUrl: parsed['ethereumRpcUrl'],
  } as unknown as AriesRestConfig)
}