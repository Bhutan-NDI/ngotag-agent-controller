/**
 * Endpoint schemes read from a real multi-tenant agent's created DIDs: a did:peer:2 stores no document, so the
 * services have to come from resolving the DID.
 */
import '@openwallet-foundation/askar-nodejs'
import { AskarModule, AskarMultiWalletDatabaseScheme } from '@credo-ts/askar'
import { Agent, createPeerDidDocumentFromServices, PeerDidNumAlgo } from '@credo-ts/core'
import { DidCommModule } from '@credo-ts/didcomm'
import { agentDependencies } from '@credo-ts/node'
import { TenantsModule } from '@credo-ts/tenants'
import { askar } from '@openwallet-foundation/askar-nodejs'
import { randomUUID } from 'crypto'

import { collectEndpointSchemes, schemeOf } from '../endpointSchemes'

type TenantsApi = {
  createTenant: (o: unknown) => Promise<{ id: string }>
  withTenantAgent: <T>(o: { tenantId: string }, cb: (a: any) => Promise<T>) => Promise<T>
}

describe('schemeOf', () => {
  it.each([
    ['https://agent.example.org/didcomm', 'https'],
    ['WSS://agent.example.org', 'wss'],
    ['ws://10.0.0.1:8080', 'ws'],
    ['didcomm:transport/queue', 'didcomm'],
    ['agent.example.org', 'unknown'],
    ['', 'unknown'],
  ])('%s -> %s', (endpoint, scheme) => {
    expect(schemeOf(endpoint)).toBe(scheme)
  })
})

describe('collectEndpointSchemes against a real tenant agent', () => {
  let agent: Agent
  let tenants: TenantsApi
  let tenantId: string
  let emptyTenantId: string

  const createPeerDid = async (tenantAgent: any, serviceEndpoints: string[]) => {
    const services = []
    for (const [index, serviceEndpoint] of serviceEndpoints.entries()) {
      const routing = await tenantAgent.modules.didcomm.mediationRecipient.getRouting({})
      services.push({ id: `didcomm-${index}`, recipientKeys: [routing.recipientKey], routingKeys: [], serviceEndpoint })
    }
    const { didDocument, keys } = createPeerDidDocumentFromServices(services, true)
    const result = await tenantAgent.dids.create({
      didDocument,
      method: 'peer',
      options: { numAlgo: PeerDidNumAlgo.MultipleInceptionKeyWithoutDoc, keys },
    })
    if (result.didState.state !== 'finished') throw new Error(`did creation failed: ${result.didState.reason}`)
  }

  beforeAll(async () => {
    agent = new Agent({
      config: {},
      dependencies: agentDependencies,
      modules: {
        askar: new AskarModule({
          askar,
          store: { id: `schemes-${randomUUID()}`, key: 'schemes-store-key-00000000000000000' },
          multiWalletDatabaseScheme: AskarMultiWalletDatabaseScheme.ProfilePerWallet,
        }),
        didcomm: new DidCommModule({ endpoints: ['https://shared.example.org'] }),
        tenants: new TenantsModule(),
      },
    })
    await agent.initialize()
    tenants = (agent.modules as unknown as { tenants: TenantsApi }).tenants
    tenantId = (await tenants.createTenant({ config: { label: 'org' } })).id
    emptyTenantId = (await tenants.createTenant({ config: { label: 'empty-org' } })).id

    await tenants.withTenantAgent({ tenantId }, async (tenantAgent) => {
      await createPeerDid(tenantAgent, ['https://one.example.org'])
      await createPeerDid(tenantAgent, ['https://two.example.org'])
      await createPeerDid(tenantAgent, ['https://four.example.org'])
      await createPeerDid(tenantAgent, ['wss://socket.example.org'])
      await createPeerDid(tenantAgent, ['https://three.example.org', 'ws://socket.example.org'])
    })
  }, 120000)

  afterAll(async () => {
    await agent.shutdown()
  })

  it('counts, per scheme, the DIDs that advertise it and names example DIDs', async () => {
    const summary = await tenants.withTenantAgent({ tenantId }, (tenantAgent) =>
      collectEndpointSchemes(tenantAgent, tenantId),
    )

    expect(summary).toMatchObject({ tenantId, didsScanned: 5, unresolvedDids: 0 })
    expect(summary.schemes.map(({ scheme, count }) => [scheme, count])).toEqual([
      ['https', 4],
      ['ws', 1],
      ['wss', 1],
    ])
    expect(summary.schemes.find(({ scheme }) => scheme === 'wss')?.exampleDids).toHaveLength(1)
    expect(summary.schemes.find(({ scheme }) => scheme === 'wss')?.exampleDids[0]).toMatch(/^did:peer:2/)
  }, 60000)

  it('caps the example DIDs per scheme', async () => {
    const summary = await tenants.withTenantAgent({ tenantId }, (tenantAgent) =>
      collectEndpointSchemes(tenantAgent, tenantId),
    )

    expect(summary.schemes.find(({ scheme }) => scheme === 'https')?.exampleDids).toHaveLength(3)
  }, 60000)

  it('reads every page of DIDs, not just the first', async () => {
    const summary = await tenants.withTenantAgent({ tenantId }, (tenantAgent) =>
      collectEndpointSchemes(tenantAgent, tenantId, 1),
    )

    expect(summary.didsScanned).toBe(5)
    expect(summary.schemes.map(({ scheme, count }) => [scheme, count])).toEqual([
      ['https', 4],
      ['ws', 1],
      ['wss', 1],
    ])
  }, 60000)

  it('reports an empty result for a tenant with no DIDs', async () => {
    const summary = await tenants.withTenantAgent({ tenantId: emptyTenantId }, (tenantAgent) =>
      collectEndpointSchemes(tenantAgent, emptyTenantId),
    )

    expect(summary).toEqual({ tenantId: emptyTenantId, didsScanned: 0, unresolvedDids: 0, schemes: [] })
  }, 60000)
})

describe('collectEndpointSchemes with documents that cannot be read', () => {
  it('counts a DID that does not resolve instead of failing the whole scan', async () => {
    const records = [
      { did: 'did:web:gone.example.org' },
      { did: 'did:peer:1zStored', didDocument: { service: [{ serviceEndpoint: 'https://a.example.org' }] } },
    ]
    const agent = {
      context: {},
      dependencyManager: { resolve: () => ({ findByQuery: async () => records }) },
      dids: { resolveDidDocument: async () => Promise.reject(new Error('not found')) },
    }

    const summary = await collectEndpointSchemes(agent as never, 't1')

    expect(summary).toEqual({
      tenantId: 't1',
      didsScanned: 2,
      unresolvedDids: 1,
      schemes: [{ scheme: 'https', count: 1, exampleDids: ['did:peer:1zStored'] }],
    })
  })

  it('reads endpoints given as a list or as objects with a uri', async () => {
    const records = [
      {
        did: 'did:peer:1zA',
        didDocument: { service: [{ serviceEndpoint: [{ uri: 'wss://a.example.org' }, 'https://b.example.org'] }] },
      },
    ]
    const agent = {
      context: {},
      dependencyManager: { resolve: () => ({ findByQuery: async () => records }) },
      dids: {},
    }

    const { schemes } = await collectEndpointSchemes(agent as never, 't1')

    expect(schemes.map(({ scheme }) => scheme)).toEqual(['https', 'wss'])
  })
})
