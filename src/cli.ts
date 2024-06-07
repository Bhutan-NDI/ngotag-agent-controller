import type { InboundTransport, Transports, AriesRestConfig } from './cliAgent'

import yargs from 'yargs'

import { runRestAgent } from './cliAgent'

const parsed = yargs
  .command('start', 'Start AFJ Rest agent')
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
  .option('indy-ledger', {
    array: true,
    default: [],
  })
  .option('public-did-seed', {
    string: true,
  })
  .option('endpoint', {
    array: true,
  })
  .option('log-level', {
    number: true,
    default: 3,
  })
  .option('use-legacy-did-sov-prefix', {
    boolean: true,
    default: false,
  })
  .option('outbound-transport', {
    default: [],
    choices: ['http', 'ws'],
    array: true,
  })
  .option('inbound-transport', {
    array: true,
    default: [],
    coerce: (input: string[]) => {
      // Configured using config object
      if (typeof input[0] === 'object') return input
      if (input.length % 2 !== 0) {
        throw new Error(
          'Inbound transport should be specified as transport port pairs (e.g. --inbound-transport http 5000 ws 5001)'
        )
      }

      return input.reduce<Array<InboundTransport>>((transports, item, index) => {
        const isEven = index % 2 === 0
        // isEven means it is the transport
        // transport port transport port
        const isTransport = isEven

        if (isTransport) {
          transports.push({
            transport: item as Transports,
            port: Number(input[index + 1]),
          })
        }

        return transports
      }, [])
    },
  })
  .option('auto-accept-connections', {
    boolean: true,
    default: false,
  })
  .option('auto-accept-credentials', {
    choices: ['always', 'never', 'contentApproved'],
    default: 'never',
  })
  .option('auto-accept-mediation-requests', {
    boolean: true,
    default: false,
  })
  .option('auto-accept-proofs', {
    choices: ['always', 'never', 'contentApproved'],
    default: 'never',
  })
  .option('connection-image-url', {
    string: true,
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
  // .option('storage-config', {
  //   array: true,
  //   default: [],
  //   coerce: (input) => JSON.parse(input),
  // })
  // .option('storageConfig', {
  //   type: 'string',
  //   describe: 'Storage configuration JSON',
  //   coerce: (value) => {
  //     try {
  //       return JSON.parse(value);
  //     } catch (error) {
  //       throw new Error('Invalid JSON format for storageConfig');
  //     }
  //   },
  // })

  .config()
  .env('AFJ_REST')
  .parse()

const argv = yargs.argv
const storageConfig = argv['wallet-type']

// eslint-disable-next-line no-console
console.log('Storage Config after YARGS::', storageConfig)

export async function runCliServer() {
  await runRestAgent({
    label: parsed.label,
    walletConfig: {
      id: parsed['wallet-id'],
      key: parsed['wallet-key'],
      storage: {
        type: parsed['wallet-type'],
        config: {
          host: parsed['wallet-url'],
          connectTimeout: 10,
          maxConnections: 1000,
          idleTimeout: 30000,
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
    // publicDidSeed: parsed['public-did-seed'],
    endpoints: parsed.endpoint,
    autoAcceptConnections: parsed['auto-accept-connections'],
    autoAcceptCredentials: parsed['auto-accept-credentials'],
    autoAcceptProofs: parsed['auto-accept-proofs'],
    autoAcceptMediationRequests: parsed['auto-accept-mediation-requests'],
    useLegacyDidSovPrefix: parsed['use-legacy-did-sov-prefix'],
    logLevel: 2,
    inboundTransports: parsed['inbound-transport'],
    outboundTransports: parsed['outbound-transport'],
    connectionImageUrl: parsed['connection-image-url'],
    webhookUrl: parsed['webhook-url'],
    adminPort: parsed['admin-port'],
    tenancy: parsed['tenancy'],
    schemaFileServerURL: parsed['schemaFileServerURL'],
    didRegistryContractAddress: parsed['didRegistryContractAddress'],
    schemaManagerContractAddress: parsed['schemaManagerContractAddress'],
    rpcUrl: parsed['rpcUrl'],
    fileServerUrl: parsed['fileServerUrl'],
    fileServerToken: parsed['fileServerToken'],
  } as unknown as AriesRestConfig)
}
