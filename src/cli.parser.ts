// The yargs definition lives apart from cli.ts so it can be imported without pulling in cliAgent
// and the whole agent dependency graph. cli.ts and its test then parse with the same definition,
// rather than the test recreating one that could drift from production.
import yargs from 'yargs'
import { hideBin } from 'yargs/helpers'

import { apiKeyOptionDefinition } from './utils/config.js'

export interface IndyLedger {
  genesisTransactions: string
  indyNamespace: string
}

export interface Parsed {
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
  apiKey?: string
  updateJwtSecret?: boolean
}

interface InboundTransport {
  transport: Transports
  port: number
}

type Transports = 'http' | 'ws'

// Returns the configured parser rather than a parsed result, so a test can invoke this exact
// definition while overriding only yargs' exit policy (it exits the process on failure, which is the
// right behaviour for the CLI but not observable from a test).
export function buildParser(argv: string[] = hideBin(process.argv)) {
  return yargs(argv)
    .command('start', 'Start Credo Rest agent')
    .option('label', { alias: 'l', string: true, demandOption: true })
    .option('wallet-id', { string: true, demandOption: true })
    .option('wallet-key', { string: true, demandOption: true })
    .option('wallet-type', { string: true, demandOption: true })
    .option('wallet-url', { string: true, demandOption: true })
    .option('wallet-scheme', { string: true, demandOption: true })
    .option('wallet-account', { string: true, demandOption: true })
    .option('wallet-password', { string: true, demandOption: true })
    .option('wallet-admin-account', { string: true, demandOption: true })
    .option('wallet-admin-password', { string: true, demandOption: true })
    .option('indy-ledger', {
      array: true,
      default: [],
      coerce: (input) =>
        input.map((item: { genesisTransactions: string; indyNamespace: string }) => ({
          genesisTransactions: item.genesisTransactions,
          indyNamespace: item.indyNamespace,
        })),
    })
    .option('endpoint', {
      array: true,
      coerce: (input) => input.map((item: string) => String(item)),
    })
    .option('log-level', { number: true, default: 3 })
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
            transports.push({ transport: item.transport as Transports, port: item.port })
          } else {
            throw new Error(
              'Inbound transport should be specified as an array of objects with transport and port properties.',
            )
          }
        }
        return transports
      },
    })
    .option('auto-accept-connections', { boolean: true, default: false })
    .option('auto-accept-credentials', {
      choices: ['always', 'never', 'contentApproved'],
      coerce: (input: string) => {
        if (['always', 'never', 'contentApproved'].includes(input)) {
          return input as 'always' | 'never' | 'contentApproved'
        } else {
          throw new Error(
            'Invalid value for auto-accept-credentials. Valid values are "always", "never", or "contentApproved".',
          )
        }
      },
    })
    .option('auto-accept-proofs', {
      choices: ['always', 'never', 'contentApproved'],
      coerce: (input: string) => {
        if (['always', 'never', 'contentApproved'].includes(input)) {
          return input as 'always' | 'never' | 'contentApproved'
        } else {
          throw new Error(
            'Invalid value for auto-accept-proofs. Valid values are "always", "never", or "contentApproved".',
          )
        }
      },
    })
    .option('webhook-url', { string: true })
    .option('admin-port', { number: true, demandOption: true })
    .option('tenancy', { boolean: true, default: false })
    .option('did-registry-contract-address', { string: true })
    .option('schema-manager-contract-address', { string: true })
    .option('wallet-connect-timeout', { number: true })
    .option('wallet-max-connections', { number: true })
    .option('wallet-idle-timeout', { number: true })
    .option('apiKey', apiKeyOptionDefinition())
    .option('updateJwtSecret', {
      boolean: true,
      default: process.env.UPDATE_JWT_SECRET === 'true',
    })
    .config()
    .env('AFJ_REST')
}

export async function parseArguments(argv?: string[]): Promise<Parsed> {
  return buildParser(argv).parseAsync() as Promise<Parsed>
}
