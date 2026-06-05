/**
 * Regression tests for the idempotent-retry behaviour patched into
 * @ayanworks/credo-polygon-w3c-module's PolygonDidRegistrar.create()
 * (see patches/@ayanworks+credo-polygon-w3c-module+2.0.2.patch and
 * fix/polygon-did-creation-idempotent-retry).
 *
 * Covers the retry cases called out in review:
 *   1. DID exists on-chain, local DidRecord missing  -> recover, save local record, "finished".
 *   2. DID exists on-chain, local DidRecord present   -> recover, no duplicate save.
 *   3. DID exists on-chain, wallet balance is zero     -> still recovers (balance gate skipped).
 *   4. resolve() misses but create() throws "already registered" -> re-resolve and recover.
 *   5. Recovered wallet record uses the actual on-chain DID document, not the request-built one.
 *   (+ baseline: a genuinely new DID is written on-chain and reported with its txn hash.)
 *
 * Runs under Jest ESM mode (jest.config.base.ts). ethers is mocked so the wallet-balance lookup
 * never hits the network; the agent context and ledger/repository/KMS dependencies are stubbed.
 */
import 'reflect-metadata'
// Register the Askar native backend so transformPrivateKeyToPrivateJwk / KMS key handling work,
// exactly as the agent entrypoint (cliAgent.ts) does.
import '@openwallet-foundation/askar-nodejs'

import { jest } from '@jest/globals'

// Wallet balance returned by the mocked provider; mutate per test before calling create().
let mockBalanceWei = 1n

jest.unstable_mockModule('ethers', () => {
  const actual = jest.requireActual('ethers') as Record<string, unknown>
  class FakeJsonRpcProvider {
    public constructor(_url?: string) {}
    public async getBalance() {
      return mockBalanceWei
    }
  }
  return { ...actual, JsonRpcProvider: FakeJsonRpcProvider }
})

// Import the patched module by relative file path: the package's "exports" map does not expose the
// build/* subpaths, so a bare specifier cannot resolve them at runtime (DidController only ever
// imports the type, which is erased). A file path bypasses the exports restriction.
const PKG = '../../../../node_modules/@ayanworks/credo-polygon-w3c-module/build'
const { PolygonDidRegistrar } = await import(`${PKG}/dids/PolygonDidRegistrar.mjs`)
const { PolygonLedgerService } = await import(`${PKG}/ledger/PolygonLedgerService.mjs`)
const { DidRepository, TypedArrayEncoder } = await import('@credo-ts/core')
const { KeyManagementApi } = await import('@credo-ts/core/kms')
const { transformPrivateKeyToPrivateJwk } = await import('@credo-ts/askar')

// Deterministic test key (32-byte hex). Used to derive the same secp256k1 public JWK the registrar
// would obtain from KMS, so the real DID-building pipeline runs end to end.
const PRIVATE_KEY_HEX = '4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318'
const privateKey = TypedArrayEncoder.fromHex(PRIVATE_KEY_HEX)
const { privateJwk } = transformPrivateKeyToPrivateJwk({
  type: { kty: 'EC', crv: 'secp256k1' },
  privateKey,
})
const publicJwk = { kty: 'EC', crv: 'secp256k1', x: (privateJwk as any).x, y: (privateJwk as any).y }

// A minimal but valid on-chain DID document, deliberately lacking the verificationMethod that the
// request-built secpDidDoc carries — so we can prove recovery uses the resolved document.
const onChainDidDocument = (id: string) => ({ '@context': ['https://www.w3.org/ns/did/v1'], id })

type Mocks = {
  ledgerService: { rpcUrl: string; createDidRegistryInstance: jest.Mock }
  didRegistry: { create: jest.Mock }
  didRepository: { findCreatedDid: jest.Mock; save: jest.Mock }
  kmsApi: { getPublicKey: jest.Mock; importKey: jest.Mock }
  resolver: { resolve: jest.Mock }
}

const buildRegistrar = (mocks: Mocks) => {
  const resolveMap = new Map<unknown, unknown>([
    [PolygonLedgerService, mocks.ledgerService],
    [DidRepository, mocks.didRepository],
    [KeyManagementApi, mocks.kmsApi],
  ])
  const agentContext = {
    dependencyManager: { resolve: (token: unknown) => resolveMap.get(token) },
    config: { logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } },
  }

  const registrar: any = new PolygonDidRegistrar()
  // Bypass Askar key fetch and resolver construction.
  registrar.getSigningKey = jest.fn(async () => ({}))
  registrar.resolver = mocks.resolver

  return { registrar, agentContext }
}

const makeMocks = (over: Partial<Mocks> = {}): Mocks => {
  const didRegistry = { create: jest.fn(async (_did: string, doc: unknown) => ({ didDoc: doc, txnHash: '0xtxn' })) }
  return {
    ledgerService: { rpcUrl: 'http://localhost:8545', createDidRegistryInstance: jest.fn(() => didRegistry) },
    didRegistry,
    didRepository: { findCreatedDid: jest.fn(async () => null), save: jest.fn(async () => {}) },
    kmsApi: { getPublicKey: jest.fn(async () => publicJwk), importKey: jest.fn() },
    resolver: { resolve: jest.fn() },
    ...over,
  }
}

const createOptions = {
  method: 'polygon',
  options: { network: 'testnet', endpoint: 'https://agent.example/request-endpoint' },
  secret: { privateKey },
}

beforeEach(() => {
  mockBalanceWei = 1n
})

describe('PolygonDidRegistrar.create() idempotent retry', () => {
  it('case 1: DID exists on-chain and local record is missing -> recovers and saves local record', async () => {
    const mocks = makeMocks()
    mocks.resolver.resolve.mockImplementation(async (did: string) => ({ didDocument: onChainDidDocument(did) }))
    const { registrar, agentContext } = buildRegistrar(mocks)

    const result: any = await registrar.create(agentContext, createOptions)

    expect(result.didState.state).toBe('finished')
    expect(result.didRegistrationMetadata).toEqual({ recovered: true })
    expect(mocks.didRegistry.create).not.toHaveBeenCalled()
    expect(mocks.didRepository.save).toHaveBeenCalledTimes(1)
  })

  it('case 2: DID exists on-chain and local record already exists -> recovers without duplicate save', async () => {
    const mocks = makeMocks({
      didRepository: { findCreatedDid: jest.fn(async () => ({ id: 'existing' })), save: jest.fn(async () => {}) },
    })
    mocks.resolver.resolve.mockImplementation(async (did: string) => ({ didDocument: onChainDidDocument(did) }))
    const { registrar, agentContext } = buildRegistrar(mocks)

    const result: any = await registrar.create(agentContext, createOptions)

    expect(result.didState.state).toBe('finished')
    expect(result.didRegistrationMetadata).toEqual({ recovered: true })
    expect(mocks.didRepository.save).not.toHaveBeenCalled()
  })

  it('case 3: DID exists on-chain but wallet balance is zero -> still recovers (balance gate skipped)', async () => {
    mockBalanceWei = 0n
    const mocks = makeMocks()
    mocks.resolver.resolve.mockImplementation(async (did: string) => ({ didDocument: onChainDidDocument(did) }))
    const { registrar, agentContext } = buildRegistrar(mocks)

    const result: any = await registrar.create(agentContext, createOptions)

    expect(result.didState.state).toBe('finished')
    expect(result.didRegistrationMetadata).toEqual({ recovered: true })
    expect(mocks.didRegistry.create).not.toHaveBeenCalled()
  })

  it('case 4: resolve() misses but create() throws "already registered" -> re-resolves and recovers', async () => {
    const mocks = makeMocks()
    mocks.resolver.resolve
      .mockImplementationOnce(async () => ({ didDocument: null }))
      .mockImplementationOnce(async (did: string) => ({ didDocument: onChainDidDocument(did) }))
    mocks.didRegistry.create.mockImplementation(async () => {
      throw new Error('The DID document already registered!')
    })
    const { registrar, agentContext } = buildRegistrar(mocks)

    const result: any = await registrar.create(agentContext, createOptions)

    expect(result.didState.state).toBe('finished')
    expect(result.didRegistrationMetadata).toEqual({ recovered: true })
    expect(mocks.didRegistry.create).toHaveBeenCalledTimes(1)
    expect(mocks.resolver.resolve).toHaveBeenCalledTimes(2)
  })

  it('case 5: recovered wallet record uses the on-chain document, not the request-built one', async () => {
    const mocks = makeMocks()
    mocks.resolver.resolve.mockImplementation(async (did: string) => ({ didDocument: onChainDidDocument(did) }))
    const { registrar, agentContext } = buildRegistrar(mocks)

    await registrar.create(agentContext, createOptions)

    expect(mocks.didRepository.save).toHaveBeenCalledTimes(1)
    const savedRecord: any = mocks.didRepository.save.mock.calls[0][1]
    // The on-chain document we returned has no verificationMethod; the request-built secpDidDoc would.
    // So an empty verificationMethod proves the saved record came from the ledger document.
    expect(savedRecord.didDocument.verificationMethod ?? []).toHaveLength(0)
  })

  it('baseline: a new DID is written on-chain and reported with its txn hash', async () => {
    const mocks = makeMocks()
    mocks.resolver.resolve.mockImplementation(async () => ({ didDocument: null }))
    const { registrar, agentContext } = buildRegistrar(mocks)

    const result: any = await registrar.create(agentContext, createOptions)

    expect(result.didState.state).toBe('finished')
    expect(mocks.didRegistry.create).toHaveBeenCalledTimes(1)
    expect(result.didRegistrationMetadata).toEqual({ txn: '0xtxn' })
    expect(mocks.didRepository.save).toHaveBeenCalledTimes(1)
  })

  it('reports failed when balance is zero and the DID is not yet on-chain', async () => {
    mockBalanceWei = 0n
    const mocks = makeMocks()
    mocks.resolver.resolve.mockImplementation(async () => ({ didDocument: null }))
    const { registrar, agentContext } = buildRegistrar(mocks)

    const result: any = await registrar.create(agentContext, createOptions)

    expect(result.didState.state).toBe('failed')
    expect(result.didState.reason).toBe('Insufficient balance in wallet')
    expect(mocks.didRegistry.create).not.toHaveBeenCalled()
  })
})
