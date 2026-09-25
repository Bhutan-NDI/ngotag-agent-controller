/**
 * Regression test — tenant routing key registration race (ported from pipeline-implementation
 * PR #94, per @kinxa0's review comment that this repo's 0.5.3 patch set does not survive the
 * @credo-ts 0.6.2 bump already merged into this branch).
 *
 * Root cause: DidCommRoutingService.getRouting() (used when creating an invitation/connection)
 * emitted RoutingCreatedEvent and returned immediately, without waiting for the tenants module's
 * listener to persist the recipient-key-to-tenant mapping in the root wallet. A fast-responding
 * counterparty (e.g. a mobile wallet scanning a QR code) could reply before that write committed,
 * so TenantAgentContextProvider.getContextForInboundMessage found no matching TenantRoutingRecord
 * and threw "Couldn't determine tenant id for inbound message".
 *
 * Fix (patch @credo-ts+core+0.6.2+003, @credo-ts+didcomm+0.6.2 (appended), @credo-ts+tenants+0.6.2+003):
 * EventEmitter gained emitAsync/onAsync, which awaits registered async listeners before resolving
 * (while still firing plain on() listeners the same fire-and-forget way as before, and emit() also
 * fans out to onAsync listeners fire-and-forget so no publisher can bypass registration by using
 * plain emit()). Both publishers of RoutingCreatedEvent - DidCommRoutingService.getRouting (own
 * routing key) and DidCommMediatorService.createMediatorRoutingRecord (mediator routing key) - now
 * await emitAsync, and the tenants module registers its mapping listener via onAsync instead of on().
 * emitAsync isolates listeners via Promise.allSettled but still fails closed overall.
 *
 * Note: unlike pipeline-implementation, this branch's MultiTenancyController has no caller-supplied
 * `recipientKey` / "reuse connection" bypass of getRouting() yet, so there is no
 * ensureRoutingKeyRegistered equivalent to port here - only the emitAsync/onAsync race fix applies.
 * If that feature is ported to develop later, port that fix alongside it.
 */
import 'reflect-metadata'
import { jest } from '@jest/globals'
import * as crypto from 'crypto'
import { EventEmitter as NodeEventEmitter } from 'events'
import * as fs from 'fs'

// The package "exports" map does not expose build/* subpaths, so import the vendored file directly
// by relative path (same approach as tenant-session-pool.regression.spec.ts in this repo).
const CORE_BUILD = '../../node_modules/@credo-ts/core/build'
const DIDCOMM_BUILD = '../../node_modules/@credo-ts/didcomm/build'
const TENANTS_BUILD = '../../node_modules/@credo-ts/tenants/build'
const { EventEmitter } = await import(`${CORE_BUILD}/agent/EventEmitter.mjs`)
const { Kms, RecordDuplicateError } = await import(`${CORE_BUILD}/index.mjs`)
const { DidCommMediatorService } = await import(`${DIDCOMM_BUILD}/modules/routing/services/DidCommMediatorService.mjs`)
const { DidCommModuleConfig } = await import(`${DIDCOMM_BUILD}/DidCommModuleConfig.mjs`)
const { DidCommRoutingEventTypes } = await import(`${DIDCOMM_BUILD}/modules/routing/DidCommRoutingEvents.mjs`)

const readVendoredSource = (buildRoot: string, relativePath: string): string =>
  fs.readFileSync(new URL(`${buildRoot}/${relativePath}`, import.meta.url), 'utf8')

const agentDependencies = { EventEmitterClass: NodeEventEmitter }
const fakeAgentContext: any = { contextCorrelationId: 'tenant-under-test' }

const registerTenantRoutingListener = (
  emitter: any,
  recordStore: Map<string, string>,
  options?: { delayMs?: number; failWith?: Error },
) => {
  emitter.onAsync('RoutingCreatedEvent', async (event: any) => {
    if (options?.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs))
    if (options?.failWith) throw options.failWith
    recordStore.set(event.payload.routing.recipientKey, event.metadata.contextCorrelationId)
  })
}

const getRouting = async (emitter: any, recipientKey: string) => {
  const routing = { recipientKey, endpoints: [], routingKeys: [] }
  await emitter.emitAsync(fakeAgentContext, { type: 'RoutingCreatedEvent', payload: { routing } })
  return routing
}

describe('tenant routing key registration — race regression (0.6.2)', () => {
  it('DidCommRoutingService.getRouting publisher: mapping is persisted before routing info is returned', async () => {
    const emitter = new EventEmitter(agentDependencies, {})
    const recordStore = new Map<string, string>()
    registerTenantRoutingListener(emitter, recordStore)

    const routing = await getRouting(emitter, 'key-connection-invite')

    expect(recordStore.get(routing.recipientKey)).toBe(fakeAgentContext.contextCorrelationId)
  })

  it('delayed persistence: a slow registration write is awaited, not raced past', async () => {
    const emitter = new EventEmitter(agentDependencies, {})
    const recordStore = new Map<string, string>()
    registerTenantRoutingListener(emitter, recordStore, { delayMs: 50 })

    const start = Date.now()
    const routing = await getRouting(emitter, 'key-slow-write')
    const elapsedMs = Date.now() - start

    expect(elapsedMs).toBeGreaterThanOrEqual(45)
    expect(recordStore.get(routing.recipientKey)).toBe(fakeAgentContext.contextCorrelationId)
  })

  it('persistence failure: a rejected registration write surfaces to the caller instead of handing back an unmapped key', async () => {
    const emitter = new EventEmitter(agentDependencies, {})
    const recordStore = new Map<string, string>()
    registerTenantRoutingListener(emitter, recordStore, { failWith: new Error('root wallet write failed') })

    await expect(getRouting(emitter, 'key-write-fails')).rejects.toThrow('root wallet write failed')
    expect(recordStore.size).toBe(0)
  })

  it('emit() (not just emitAsync) also fires onAsync listeners, so no publisher can bypass registration', async () => {
    const emitter = new EventEmitter(agentDependencies, {})
    const recordStore = new Map<string, string>()
    registerTenantRoutingListener(emitter, recordStore)

    emitter.emit(fakeAgentContext, {
      type: 'RoutingCreatedEvent',
      payload: { routing: { recipientKey: 'key-via-plain-emit' } },
    })
    await new Promise((resolve) => setImmediate(resolve))

    expect(recordStore.get('key-via-plain-emit')).toBe(fakeAgentContext.contextCorrelationId)
  })

  it('isolates onAsync listeners from each other and fails closed with an AggregateError on multiple failures', async () => {
    const emitter = new EventEmitter(agentDependencies, {})
    emitter.onAsync('RoutingCreatedEvent', async () => {
      throw new Error('listener A failed')
    })
    emitter.onAsync('RoutingCreatedEvent', async () => {
      throw new Error('listener B failed')
    })

    let caught: any
    try {
      await getRouting(emitter, 'key-two-listeners-fail')
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(AggregateError)

    const emitter2 = new EventEmitter(agentDependencies, {})
    let secondListenerRan = false
    emitter2.onAsync('RoutingCreatedEvent', async () => {
      throw new Error('first listener failed')
    })
    emitter2.onAsync('RoutingCreatedEvent', async () => {
      secondListenerRan = true
    })
    await expect(getRouting(emitter2, 'key-one-of-two-fails')).rejects.toThrow('first listener failed')
    expect(secondListenerRan).toBe(true)
  })
})

describe('DidCommMediatorService.createMediatorRoutingRecord — real service, stubbed repository/KMS (0.6.2)', () => {
  const buildFakeKms = () => {
    const publicKeyBytes = crypto.randomBytes(32)
    const rawPublicJwk = Kms.PublicJwk.fromPublicKey({ crv: 'Ed25519', kty: 'OKP', publicKey: publicKeyBytes }).toJson()
    return {
      createKey: jest.fn(async () => ({
        keyId: 'kms-key-id-under-test',
        publicJwk: { ...rawPublicJwk, kid: 'kms-key-id-under-test' },
      })),
    }
  }

  const buildFakeRepository = () => {
    const saved: unknown[] = []
    return {
      MEDIATOR_ROUTING_RECORD_ID: 'MEDIATOR_ROUTING_RECORD_ID_TEST',
      save: jest.fn(async (_ctx: unknown, record: unknown) => {
        saved.push(record)
      }),
      getById: jest.fn(async () => saved[0]),
    }
  }

  const buildService = (eventEmitter: unknown, mediatorRoutingRepository: unknown) => {
    const fakeKms = buildFakeKms()
    const didcommConfig = new DidCommModuleConfig({ endpoints: ['https://mediator.example'] })
    const agentContext: any = {
      contextCorrelationId: 'tenant-under-test',
      resolve: (token: unknown) => {
        if (token === Kms.KeyManagementApi) return fakeKms
        if (token === DidCommModuleConfig) return didcommConfig
        throw new Error(`Unexpected agentContext.resolve() call in test for token ${String(token)}`)
      },
    }
    const service = new DidCommMediatorService(
      /* mediationRepository */ {},
      mediatorRoutingRepository,
      eventEmitter,
      /* logger */ { debug: () => {}, warn: () => {}, error: () => {} },
      /* connectionService */ {},
    )
    return { service, agentContext }
  }

  // Regression for @kinxa0's review: the buggy patch passed the raw kms.createKey() result
  // ({ keyId, publicJwk }) as recipientKey instead of the wrapped Kms.PublicJwk, so
  // recipientKey.fingerprint was undefined and the tenant mapping could never be looked up.
  it('emits a RoutingCreatedEvent whose recipientKey carries a real fingerprint', async () => {
    const eventEmitter = new EventEmitter(agentDependencies, {})
    let capturedRecipientKey: any
    eventEmitter.onAsync(DidCommRoutingEventTypes.RoutingCreatedEvent, async (event: any) => {
      capturedRecipientKey = event.payload.routing.recipientKey
    })
    const mediatorRoutingRepository = buildFakeRepository()
    const { service, agentContext } = buildService(eventEmitter, mediatorRoutingRepository)

    const record = await service.createMediatorRoutingRecord(agentContext)

    expect(capturedRecipientKey?.fingerprint).toBeDefined()
    expect(capturedRecipientKey.fingerprint).toBe(record.routingKeys[0].routingKeyFingerprint)
  })

  // Regression for @kinxa0's review: emitAsync used to run inside the try/catch that handles
  // save()'s RecordDuplicateError, so a failure from the tenant mapping listener was swallowed
  // as if the mediator routing record already existed instead of surfacing to the caller.
  it('does not mistake a RecordDuplicateError from the mapping listener for "the mediator routing record already existed"', async () => {
    const eventEmitter = new EventEmitter(agentDependencies, {})
    eventEmitter.onAsync(DidCommRoutingEventTypes.RoutingCreatedEvent, async () => {
      throw new RecordDuplicateError('duplicate tenant routing record', { recordType: 'TenantRoutingRecord' })
    })
    const mediatorRoutingRepository = buildFakeRepository()
    const { service, agentContext } = buildService(eventEmitter, mediatorRoutingRepository)

    await expect(service.createMediatorRoutingRecord(agentContext)).rejects.toThrow('duplicate tenant routing record')
    expect(mediatorRoutingRepository.save).toHaveBeenCalledTimes(1)
    expect(mediatorRoutingRepository.getById).not.toHaveBeenCalled()
  })

  it('still returns the existing record when the repository save itself throws RecordDuplicateError', async () => {
    const eventEmitter = new EventEmitter(agentDependencies, {})
    const emitted: unknown[] = []
    eventEmitter.onAsync(DidCommRoutingEventTypes.RoutingCreatedEvent, async (event: unknown) => {
      emitted.push(event)
    })
    const mediatorRoutingRepository = buildFakeRepository()
    mediatorRoutingRepository.save.mockRejectedValueOnce(
      new RecordDuplicateError('already exists', { recordType: 'DidCommMediatorRoutingRecord' }),
    )
    mediatorRoutingRepository.getById.mockResolvedValueOnce({ id: 'existing-record' })
    const { service, agentContext } = buildService(eventEmitter, mediatorRoutingRepository)

    const record = await service.createMediatorRoutingRecord(agentContext)

    expect(record).toEqual({ id: 'existing-record' })
    expect(emitted).toHaveLength(0)
  })
})

describe('tenant routing key registration — patched publishers stay wired up (source guard, 0.6.2)', () => {
  it('DidCommRoutingService.getRouting emits RoutingCreatedEvent via emitAsync', () => {
    const source = readVendoredSource(DIDCOMM_BUILD, 'modules/routing/services/DidCommRoutingService.mjs')
    expect(source).toMatch(
      /await this\.eventEmitter\.emitAsync\(agentContext,\s*\{\s*type:\s*DidCommRoutingEventTypes\.RoutingCreatedEvent/,
    )
  })

  it('DidCommMediatorService.createMediatorRoutingRecord emits RoutingCreatedEvent via emitAsync', () => {
    const source = readVendoredSource(DIDCOMM_BUILD, 'modules/routing/services/DidCommMediatorService.mjs')
    expect(source).toMatch(
      /await this\.eventEmitter\.emitAsync\(agentContext,\s*\{\s*type:\s*DidCommRoutingEventTypes\.RoutingCreatedEvent/,
    )
  })

  it('tenants module registers its recipient-key mapping listener via onAsync, not on', () => {
    const source = readVendoredSource(TENANTS_BUILD, 'context/TenantAgentContextProvider.mjs')
    expect(source).toMatch(/this\.eventEmitter\.onAsync\(DidCommRoutingEventTypes\.RoutingCreatedEvent/)
    expect(source).not.toMatch(/this\.eventEmitter\.on\(DidCommRoutingEventTypes\.RoutingCreatedEvent/)
  })

  // Regression for @kinxa0's follow-up review: under onAsync, a non-tenant/non-root context used
  // to fall through to assertTenantContextCorrelationId, which throws and (now that the listener is
  // awaited) would abort the caller instead of being ignored.
  it('tenants module ignores non-tenant contexts instead of asserting on them', () => {
    const source = readVendoredSource(TENANTS_BUILD, 'context/TenantAgentContextProvider.mjs')
    expect(source).toMatch(/this\.tenantSessionCoordinator\.isTenantContextCorrelationId\(contextCorrelationId\)/)
  })
})
