import type { InitConfig } from '@credo-ts/core'
import type { WalletConfig } from '@credo-ts/core/build/types'
import type { IndyVdrPoolConfig } from '@credo-ts/indy-vdr'

// eslint-disable-next-line import/no-extraneous-dependencies
import { PolygonDidRegistrar, PolygonDidResolver, PolygonModule } from '@ayanworks/credo-polygon-w3c-module'
// eslint-disable-next-line import/no-extraneous-dependencies
import { EthereumDidRegistrar, EthereumDidResolver, EthereumModule } from '@bhutan-ndi/ethr-credo-module'
import {
  AnonCredsCredentialFormatService,
  AnonCredsModule,
  AnonCredsProofFormatService,
  LegacyIndyCredentialFormatService,
  LegacyIndyProofFormatService,
  V1CredentialProtocol,
  V1ProofProtocol,
} from '@credo-ts/anoncreds'
import { AskarModule, AskarMultiWalletDatabaseScheme } from '@credo-ts/askar'
import {
  AutoAcceptCredential,
  AutoAcceptProof,
  DidsModule,
  ProofsModule,
  V2ProofProtocol,
  CredentialsModule,
  V2CredentialProtocol,
  ConnectionsModule,
  W3cCredentialsModule,
  KeyDidRegistrar,
  KeyDidResolver,
  CacheModule,
  WebDidResolver,
  HttpOutboundTransport,
  WsOutboundTransport,
  LogLevel,
  Agent,
  JsonLdCredentialFormatService,
  DifPresentationExchangeProofFormatService,
  InMemoryLruCache,
} from '@credo-ts/core'
import {
  IndyVdrAnonCredsRegistry,
  IndyVdrIndyDidResolver,
  IndyVdrModule,
  IndyVdrIndyDidRegistrar,
} from '@credo-ts/indy-vdr'
import { agentDependencies, HttpInboundTransport, WsInboundTransport } from '@credo-ts/node'
import { QuestionAnswerModule } from '@credo-ts/question-answer'
import { TenantsModule } from '@credo-ts/tenants'
import { anoncreds } from '@hyperledger/anoncreds-nodejs'
import { ariesAskar } from '@hyperledger/aries-askar-nodejs'
import { indyVdr } from '@hyperledger/indy-vdr-nodejs'
import axios from 'axios'
import { randomBytes } from 'crypto'
import { readFile } from 'fs/promises'
import jwt from 'jsonwebtoken'

import { IndicioAcceptanceMechanism, IndicioTransactionAuthorAgreement, Network, NetworkName } from './enums/enum'
import { setupServer } from './server'
import { buildCachedDocumentLoader } from './utils/CachedDocumentLoader'
import { RedisCache } from './utils/RedisCache'
import { TsLogger } from './utils/logger'
import { emitStructured, makeSpanId, monoNow, tryExtractFromJwe } from './utils/StructuredLogger'
import { startGauges } from './instrumentation/gauges'
import { requestContext } from './instrumentation/requestContext'

export type Transports = 'ws' | 'http'
export type InboundTransport = {
  transport: Transports
  port: number
}

const inboundTransportMapping = {
  http: HttpInboundTransport,
  ws: WsInboundTransport,
} as const

const outboundTransportMapping = {
  http: HttpOutboundTransport,
  ws: WsOutboundTransport,
} as const

interface indyLedger {
  genesisTransactions: string
  indyNamespace: string
}
export interface AriesRestConfig {
  label: string
  walletConfig: WalletConfig
  indyLedger: indyLedger[]
  adminPort: number
  publicDidSeed?: string
  endpoints?: string[]
  autoAcceptConnections?: boolean
  autoAcceptCredentials?: AutoAcceptCredential
  autoAcceptProofs?: AutoAcceptProof
  logLevel?: LogLevel
  inboundTransports?: InboundTransport[]
  outboundTransports?: Transports[]
  autoAcceptMediationRequests?: boolean
  connectionImageUrl?: string
  tenancy?: boolean
  webhookUrl?: string
  didRegistryContractAddress?: string
  schemaManagerContractAddress?: string
  rpcUrl?: string
  fileServerUrl?: string
  fileServerToken?: string
  ethereumNetworkName?: string
  ethereumChainId?: string | number
  ethereumRegistry?: string
  ethereumSchemaManagerContractAddress?: string
  ethereumRpcUrl?: string
  chainId?: string | number
  name?: string
  registry?: string
  walletScheme?: AskarMultiWalletDatabaseScheme
  schemaFileServerURL?: string
}

export async function readRestConfig(path: string) {
  const configString = await readFile(path, { encoding: 'utf-8' })
  const config = JSON.parse(configString)

  return config
}

export type RestMultiTenantAgentModules = Awaited<ReturnType<typeof getWithTenantModules>>

export type RestAgentModules = Awaited<ReturnType<typeof getModules>>

interface EthereumModuleEnvironmentConfig {
  ethereumNetworkName?: string
  ethereumChainId?: string | number
  ethereumRegistry?: string
  ethereumSchemaManagerContractAddress?: string
  ethereumRpcUrl?: string
}

const initializeCache = (logger: TsLogger) => {
  const redisUrl = process.env.REDIS_URL

  if (redisUrl) {
    logger.info('Redis URL found — initializing RedisCache')
    return new RedisCache(redisUrl, logger, Number(process.env.REDIS_CACHE_TTL_SECONDS) || 600)
  }

  logger.warn('Redis URL not found — falling back to InMemoryLruCache')
  return new InMemoryLruCache({
    limit: Number(process.env.INMEMORY_LRU_CACHE_LIMIT) || 1000,
  })
}

// TODO: add object
const getModules = (
  networkConfig: [IndyVdrPoolConfig, ...IndyVdrPoolConfig[]],
  didRegistryContractAddress: string,
  fileServerToken: string,
  fileServerUrl: string,
  rpcUrl: string,
  schemaManagerContractAddress: string,
  autoAcceptConnections: boolean,
  autoAcceptCredentials: AutoAcceptCredential,
  autoAcceptProofs: AutoAcceptProof,
  walletScheme: AskarMultiWalletDatabaseScheme,
  logger: TsLogger,
  ethereumModuleConfig: EthereumModuleEnvironmentConfig = {}
) => {
  const ethereumNetworkName = ethereumModuleConfig.ethereumNetworkName || process.env.ETHEREUM_NETWORK_NAME
  const ethereumChainId = Number(ethereumModuleConfig.ethereumChainId || process.env.ETHEREUM_CHAIN_ID)
  const ethereumRpcUrl = ethereumModuleConfig.ethereumRpcUrl || process.env.ETHEREUM_RPC_URL
  const ethereumRegistry =
    ethereumModuleConfig.ethereumRegistry ||
    process.env.ETHEREUM_DID_REGISTRY_CONTRACT_ADDRESS ||
    process.env.ETHEREUM_REGISTRY
  const ethereumSchemaManagerContractAddress =
    ethereumModuleConfig.ethereumSchemaManagerContractAddress ||
    process.env.ETHEREUM_SCHEMA_MANAGER_CONTRACT_ADDRESS

  const legacyIndyCredentialFormat = new LegacyIndyCredentialFormatService()
  const legacyIndyProofFormat = new LegacyIndyProofFormatService()
  const jsonLdCredentialFormatService = new JsonLdCredentialFormatService()
  const anonCredsCredentialFormatService = new AnonCredsCredentialFormatService()
  const anonCredsProofFormatService = new AnonCredsProofFormatService()
  const presentationExchangeProofFormatService = new DifPresentationExchangeProofFormatService()
  return {
    askar: new AskarModule({
      ariesAskar,
      multiWalletDatabaseScheme: walletScheme || AskarMultiWalletDatabaseScheme.ProfilePerWallet,
    }),

    indyVdr: new IndyVdrModule({
      indyVdr,
      networks: networkConfig,
    }),

    dids: new DidsModule({
      registrars: [
        new IndyVdrIndyDidRegistrar(),
        new KeyDidRegistrar(),
        new PolygonDidRegistrar(),
        new EthereumDidRegistrar(),
      ],
      resolvers: [
        new IndyVdrIndyDidResolver(),
        new KeyDidResolver(),
        new WebDidResolver(),
        new PolygonDidResolver(),
        new EthereumDidResolver(),
      ],
    }),

    anoncreds: new AnonCredsModule({
      registries: [new IndyVdrAnonCredsRegistry()],
      anoncreds,
    }),

    connections: new ConnectionsModule({
      autoAcceptConnections: autoAcceptConnections || true,
    }),
    proofs: new ProofsModule({
      autoAcceptProofs: autoAcceptProofs || AutoAcceptProof.ContentApproved,
      proofProtocols: [
        new V1ProofProtocol({
          indyProofFormat: legacyIndyProofFormat,
        }),
        new V2ProofProtocol({
          proofFormats: [legacyIndyProofFormat, anonCredsProofFormatService, presentationExchangeProofFormatService],
        }),
      ],
    }),
    credentials: new CredentialsModule({
      autoAcceptCredentials: autoAcceptCredentials || AutoAcceptCredential.Always,
      credentialProtocols: [
        new V1CredentialProtocol({
          indyCredentialFormat: legacyIndyCredentialFormat,
        }),
        new V2CredentialProtocol({
          credentialFormats: [
            legacyIndyCredentialFormat,
            jsonLdCredentialFormatService,
            anonCredsCredentialFormatService,
          ],
        }),
      ],
    }),
    w3cCredentials: new W3cCredentialsModule({
      documentLoader: buildCachedDocumentLoader(logger),
    }),
    cache: new CacheModule({
      cache: initializeCache(logger),
    }),

    questionAnswer: new QuestionAnswerModule(),
    polygon: new PolygonModule({
      didContractAddress: didRegistryContractAddress
        ? didRegistryContractAddress
        : (process.env.DID_CONTRACT_ADDRESS as string),
      schemaManagerContractAddress:
        schemaManagerContractAddress || (process.env.SCHEMA_MANAGER_CONTRACT_ADDRESS as string),
      fileServerToken: fileServerToken ? fileServerToken : (process.env.FILE_SERVER_TOKEN as string),
      rpcUrl: rpcUrl ? rpcUrl : (process.env.RPC_URL as string),
      serverUrl: fileServerUrl ? fileServerUrl : (process.env.SERVER_URL as string),
    }),
    ethereum: new EthereumModule({
      config: {
        networks: [
          {
            name: ethereumNetworkName as string,
            chainId: ethereumChainId,
            rpcUrl: ethereumRpcUrl as string,
            registry: ethereumRegistry as string,
          },
        ],
      },
      schemaManagerContractAddress: ethereumSchemaManagerContractAddress as string,
      serverUrl: fileServerUrl ? fileServerUrl : (process.env.SERVER_URL as string),
      fileServerToken: fileServerToken ? fileServerToken : (process.env.FILE_SERVER_TOKEN as string),
      rpcUrl: ethereumRpcUrl as string,
    }),
  }
}

// TODO: add object
const getWithTenantModules = (
  networkConfig: [IndyVdrPoolConfig, ...IndyVdrPoolConfig[]],
  didRegistryContractAddress: string,
  fileServerToken: string,
  fileServerUrl: string,
  rpcUrl: string,
  schemaManagerContractAddress: string,
  autoAcceptConnections: boolean,
  autoAcceptCredentials: AutoAcceptCredential,
  autoAcceptProofs: AutoAcceptProof,
  walletScheme: AskarMultiWalletDatabaseScheme,
  logger: TsLogger,
  ethereumModuleConfig: EthereumModuleEnvironmentConfig = {}
) => {
  const modules = getModules(
    networkConfig,
    didRegistryContractAddress,
    fileServerToken,
    fileServerUrl,
    rpcUrl,
    schemaManagerContractAddress,
    autoAcceptConnections,
    autoAcceptCredentials,
    autoAcceptProofs,
    walletScheme,
    logger,
    ethereumModuleConfig
  )
  return {
    tenants: new TenantsModule<typeof modules>({
      sessionAcquireTimeout: Number(process.env.SESSION_ACQUIRE_TIMEOUT) || 10000,
      sessionLimit: Number(process.env.SESSION_LIMIT) || 10,
    }),
    ...modules,
  }
}

async function generateSecretKey(length: number = 32): Promise<string> {
  // Asynchronously generate a buffer containing random values
  const buffer: Buffer = await new Promise((resolve, reject) => {
    randomBytes(length, (error, buf) => {
      if (error) {
        reject(error)
      } else {
        resolve(buf)
      }
    })
  })

  // Convert the buffer to a hexadecimal string
  const secretKey: string = buffer.toString('hex')

  return secretKey
}

export async function runRestAgent(restConfig: AriesRestConfig) {
  const {
    schemaFileServerURL,
    logLevel,
    inboundTransports = [],
    outboundTransports = [],
    webhookUrl,
    adminPort,
    didRegistryContractAddress,
    fileServerToken,
    fileServerUrl,
    rpcUrl,
    schemaManagerContractAddress,
    ethereumNetworkName,
    ethereumChainId,
    ethereumRegistry,
    ethereumSchemaManagerContractAddress,
    ethereumRpcUrl,
    chainId,
    name,
    registry,
    walletConfig,
    autoAcceptConnections,
    autoAcceptCredentials,
    autoAcceptProofs,
    walletScheme,
    ...afjConfig
  } = restConfig

  const logger = new TsLogger(logLevel ?? LogLevel.error)

  const agentConfig: InitConfig = {
    walletConfig: {
      id: walletConfig.id,
      key: walletConfig.key,
      storage: walletConfig.storage,
    },
    ...afjConfig,
    logger,
    autoUpdateStorageOnStartup: true,
    // As backup is only supported for sqlite storage
    // we need to manually take backup of the storage before updating the storage
    backupBeforeStorageUpdate: false,
  }

  async function fetchLedgerData(ledgerConfig: {
    genesisTransactions: string
    indyNamespace: string
  }): Promise<IndyVdrPoolConfig> {
    const urlPattern = /^(https?:\/\/)?([\w-]+\.)+[\w-]+(\/[\w-./?%&=]*)?$/

    if (!urlPattern.test(ledgerConfig.genesisTransactions)) {
      throw new Error('Not a valid URL')
    }

    const genesisTransactions = await axios.get(ledgerConfig.genesisTransactions)

    const networkConfig: IndyVdrPoolConfig = {
      genesisTransactions: genesisTransactions.data,
      indyNamespace: ledgerConfig.indyNamespace,
      isProduction: false,
      connectOnStartup: true,
    }

    if (ledgerConfig.indyNamespace.includes(NetworkName.Indicio)) {
      if (ledgerConfig.indyNamespace === (Network.Indicio_Mainnet as string)) {
        networkConfig.transactionAuthorAgreement = {
          version: IndicioTransactionAuthorAgreement.Indicio_Testnet_Mainnet_Version,
          acceptanceMechanism: IndicioAcceptanceMechanism.Wallet_Agreement,
        }
      } else {
        networkConfig.transactionAuthorAgreement = {
          version: IndicioTransactionAuthorAgreement.Indicio_Demonet_Version,
          acceptanceMechanism: IndicioAcceptanceMechanism.Wallet_Agreement,
        }
      }
    }

    return networkConfig
  }

  let networkConfig: [IndyVdrPoolConfig, ...IndyVdrPoolConfig[]]

  const parseIndyLedger = afjConfig?.indyLedger
  if (parseIndyLedger.length !== 0) {
    networkConfig = [
      await fetchLedgerData(parseIndyLedger[0]),
      ...(await Promise.all(parseIndyLedger.slice(1).map(fetchLedgerData))),
    ]
  } else {
    networkConfig = [
      {
        genesisTransactions: process.env.BCOVRIN_TEST_GENESIS as string,
        indyNamespace: Network.Bcovrin_Testnet,
        isProduction: false,
        connectOnStartup: true,
      },
    ]
  }

  const ethereumModuleConfig = {
    ethereumNetworkName: ethereumNetworkName || name,
    ethereumChainId: ethereumChainId || chainId,
    ethereumRegistry: ethereumRegistry || registry,
    ethereumSchemaManagerContractAddress,
    ethereumRpcUrl,
  }

  const tenantModule = await getWithTenantModules(
    networkConfig,
    didRegistryContractAddress || '',
    fileServerToken || '',
    fileServerUrl || '',
    rpcUrl || '',
    schemaManagerContractAddress || '',
    autoAcceptConnections || true,
    autoAcceptCredentials || AutoAcceptCredential.Always,
    autoAcceptProofs || AutoAcceptProof.ContentApproved,
    walletScheme || AskarMultiWalletDatabaseScheme.ProfilePerWallet,
    logger,
    ethereumModuleConfig
  )
  const modules = getModules(
    networkConfig,
    didRegistryContractAddress || '',
    fileServerToken || '',
    fileServerUrl || '',
    rpcUrl || '',
    schemaManagerContractAddress || '',
    autoAcceptConnections || true,
    autoAcceptCredentials || AutoAcceptCredential.Always,
    autoAcceptProofs || AutoAcceptProof.ContentApproved,
    walletScheme || AskarMultiWalletDatabaseScheme.ProfilePerWallet,
    logger,
    ethereumModuleConfig
  )
  const agent = new Agent({
    config: agentConfig,
    modules: afjConfig.tenancy ? tenantModule : modules,
    dependencies: agentDependencies,
  })

  // Register outbound transports
  for (const outboundTransport of outboundTransports) {
    const OutboundTransport = outboundTransportMapping[outboundTransport]
    agent.registerOutboundTransport(new OutboundTransport())
  }

  // Register inbound transports
  for (const inboundTransport of inboundTransports) {
    const InboundTransport = inboundTransportMapping[inboundTransport.transport]
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const transport: any = new (InboundTransport as any)({ port: inboundTransport.port })
    // Add instrumentation middleware to the HTTP inbound transport's express app.
    // express.text() body parser is added in the transport constructor so req.body is
    // available as a string when our middleware fires.
    if (inboundTransport.transport === 'http' && transport.app) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      transport.app.use((req: any, res: any, next: any) => {
        if (req.method === 'POST') {
          const raw: string = typeof req.body === 'string' ? req.body : ''
          const { recipientKeyShort, jweFp } = raw
            ? tryExtractFromJwe(raw)
            : { recipientKeyShort: '', jweFp: '' }
          const spanId = makeSpanId()
          emitStructured(LogLevel.trace, {
            hop: 'controller.http.inbound.received',
            span_id: spanId,
            jwe_fp: jweFp,
            recipient_key_short: recipientKeyShort,
            content_length: req.headers['content-length'] ? Number(req.headers['content-length']) : undefined,
          })
          res.locals.__dbg_span = spanId
          res.locals.__dbg_start = monoNow()
          // Thread JWE fingerprint through Credo's async chain so event handlers can read it.
          return requestContext.run({ jweFp }, () => next())
        }
        next()
      })
    }
    agent.registerInboundTransport(transport)
  }

  await agent.initialize()

  emitStructured(LogLevel.trace, {
    hop: 'controller.config.dump',
    flow: 'lifecycle',
    notes: 'effective config at startup',
    session_limit: Number(process.env.SESSION_LIMIT) || 10,
    session_acquire_timeout_ms: Number(process.env.SESSION_ACQUIRE_TIMEOUT) || 10000,
    wallet_scheme: walletScheme || AskarMultiWalletDatabaseScheme.ProfilePerWallet,
    tenancy: afjConfig.tenancy ?? false,
    admin_port: adminPort,
  })

  startGauges()

  let token: string = ''
  const genericRecord = await agent.genericRecords.getAll()

  const recordsWithToken = genericRecord.some((record) => record?.content?.token)
  if (!genericRecord.length || !recordsWithToken) {
    // Call the async function
    const secretKeyInfo: string = await generateSecretKey()
    // Check if the secretKey already exist in the genericRecords

    // if already exist - then don't generate the secret key again
    // Check if the JWT token already available in genericRecords - if yes, and also don't generate the JWT token
    // instead use the existin JWT token
    // if JWT token is not found, create/generate a new token and save in genericRecords
    // next time, the same token should be used - instead of creating a new token on every restart event of the agent

    // if already exist - then don't generate the secret key again
    // Check if the JWT token already available in genericRecords - if yes, and also don't generate the JWT token
    // instead use the existin JWT token
    // if JWT token is not found, create/generate a new token and save in genericRecords
    // next time, the same token should be used - instead of creating a new token on every restart event of the agent
    token = jwt.sign({ agentInfo: 'agentInfo' }, secretKeyInfo)
    await agent.genericRecords.save({
      content: {
        secretKey: secretKeyInfo,
        token,
      },
    })
  } else {
    const recordWithToken = genericRecord.find((record) => record?.content?.token !== undefined)

    token = recordWithToken?.content.token as string
  }
  const app = await setupServer(
    agent,
    {
      webhookUrl,
      port: adminPort,
      schemaFileServerURL,
    },
    token
  )

  logger.info(`*** API Token: ${token}`)

  app.listen(adminPort, () => {
    logger.info(`Successfully started server on port ${adminPort}`)
  })
}
