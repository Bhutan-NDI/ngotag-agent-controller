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
import { EventEmitter as NodeEventEmitter } from 'events'
import * as fs from 'fs'

// The package "exports" map does not expose build/* subpaths, so import the vendored file directly
// by relative path (same approach as tenant-session-pool.regression.spec.ts in this repo).
const CORE_BUILD = '../../node_modules/@credo-ts/core/build'
const DIDCOMM_BUILD = '../../node_modules/@credo-ts/didcomm/build'
const TENANTS_BUILD = '../../node_modules/@credo-ts/tenants/build'
const { EventEmitter } = await import(`${CORE_BUILD}/agent/EventEmitter.mjs`)

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

  it('DidCommMediatorService.createMediatorRoutingRecord publisher: mapping is persisted before routing info is returned', async () => {
    const emitter = new EventEmitter(agentDependencies, {})
    const recordStore = new Map<string, string>()
    registerTenantRoutingListener(emitter, recordStore)

    // Mirrors createMediatorRoutingRecord: a second, independent publisher of the same event.
    const routing = await getRouting(emitter, 'key-mediator-routing')

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
})
