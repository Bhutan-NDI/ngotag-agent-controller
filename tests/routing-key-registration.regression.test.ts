/**
 * Regression test — tenant routing key registration race (PR #94 review by @devdgna).
 *
 * Root cause: RoutingService.getRouting() (used when creating an invitation/connection)
 * emitted RoutingCreatedEvent and returned immediately, without waiting for the tenants
 * module's listener to persist the recipient-key-to-tenant mapping in the root wallet.
 * A fast-responding counterparty (e.g. a mobile wallet scanning a QR code) could reply
 * before that write committed, so TenantAgentContextProvider.getContextForInboundMessage
 * found no matching TenantRoutingRecord and threw "Couldn't determine tenant id for
 * inbound message" — the most frequent error in production logs (92 occurrences in one
 * afternoon).
 *
 * Fix (patch @credo-ts+core+0.5.3+009, @credo-ts+tenants+0.5.3+003): EventEmitter gained
 * emitAsync/onAsync, which awaits registered async listeners before resolving (while still
 * firing plain on() listeners the same fire-and-forget way as before). Both publishers of
 * RoutingCreatedEvent — RoutingService.getRouting (own routing key) and
 * MediatorService.createMediatorRoutingRecord (mediator routing key, used when a tenant acts
 * as its own mediator) — now await emitAsync, and the tenants module registers its mapping
 * listener via onAsync instead of on().
 *
 * First review pass missed MediatorService's publisher entirely (it moved the tenant listener
 * off `on()` without updating every emitter of RoutingCreatedEvent), silently breaking mediator
 * routing key registration. These tests exercise the REAL vendored EventEmitter and guard: both
 * publishers wait for registration, a slow (delayed) registration write is still awaited rather
 * than raced past, and a registration that fails surfaces as a rejection instead of silently
 * handing back routing info with no mapping ever persisted.
 */
import 'reflect-metadata'
import * as fs from 'fs'
import * as path from 'path'
// eslint-disable-next-line @typescript-eslint/no-var-requires
import { EventEmitter } from '@credo-ts/core/build/agent/EventEmitter'

const readVendoredSource = (relativePath: string): string =>
  fs.readFileSync(path.join(__dirname, '..', 'node_modules', relativePath), 'utf8')

const agentDependencies = { EventEmitterClass: require('events').EventEmitter }
const fakeAgentContext: any = { contextCorrelationId: 'tenant-under-test' }

// Mirrors TenantAgentContextProvider.listenForRoutingKeyCreatedEvents: the one listener that
// persists the recipient-key-to-tenant mapping, registered via onAsync (not on).
const registerTenantRoutingListener = (emitter: EventEmitter, recordStore: Map<string, string>, options?: { delayMs?: number; failWith?: Error }) => {
  emitter.onAsync('RoutingCreatedEvent' as any, async (event: any) => {
    if (options?.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs))
    if (options?.failWith) throw options.failWith
    recordStore.set(event.payload.routing.recipientKey, event.metadata.contextCorrelationId)
  })
}

// Mirrors RoutingService.getRouting: creates a key, emits, then returns routing info.
const getRouting = async (emitter: EventEmitter, recipientKey: string) => {
  const routing = { recipientKey, endpoints: [], routingKeys: [] }
  await emitter.emitAsync(fakeAgentContext, { type: 'RoutingCreatedEvent' as any, payload: { routing } })
  return routing
}

// Mirrors MediatorService.createMediatorRoutingRecord: a second, independent publisher of the
// same event, used when a tenant acts as its own mediator.
const createMediatorRoutingRecord = async (emitter: EventEmitter, recipientKey: string) => {
  const routing = { recipientKey, endpoints: [], routingKeys: [] }
  await emitter.emitAsync(fakeAgentContext, { type: 'RoutingCreatedEvent' as any, payload: { routing } })
  return routing
}

describe('tenant routing key registration — race regression', () => {
  it('RoutingService.getRouting publisher: mapping is persisted before routing info is returned', async () => {
    const emitter = new EventEmitter(agentDependencies as any, {} as any)
    const recordStore = new Map<string, string>()
    registerTenantRoutingListener(emitter, recordStore)

    const routing = await getRouting(emitter, 'key-connection-invite')

    expect(recordStore.get(routing.recipientKey)).toBe(fakeAgentContext.contextCorrelationId)
  })

  it('MediatorService.createMediatorRoutingRecord publisher: mapping is persisted before routing info is returned', async () => {
    const emitter = new EventEmitter(agentDependencies as any, {} as any)
    const recordStore = new Map<string, string>()
    registerTenantRoutingListener(emitter, recordStore)

    const routing = await createMediatorRoutingRecord(emitter, 'key-mediator-routing')

    expect(recordStore.get(routing.recipientKey)).toBe(fakeAgentContext.contextCorrelationId)
  })

  it('delayed persistence: a slow registration write is awaited, not raced past', async () => {
    const emitter = new EventEmitter(agentDependencies as any, {} as any)
    const recordStore = new Map<string, string>()
    registerTenantRoutingListener(emitter, recordStore, { delayMs: 50 })

    const start = Date.now()
    const routing = await getRouting(emitter, 'key-slow-write')
    const elapsedMs = Date.now() - start

    // The caller only gets routing info back after the (slow) write has actually landed.
    expect(elapsedMs).toBeGreaterThanOrEqual(45)
    expect(recordStore.get(routing.recipientKey)).toBe(fakeAgentContext.contextCorrelationId)
  })

  it('persistence failure: a rejected registration write surfaces to the caller instead of handing back an unmapped key', async () => {
    const emitter = new EventEmitter(agentDependencies as any, {} as any)
    const recordStore = new Map<string, string>()
    registerTenantRoutingListener(emitter, recordStore, { failWith: new Error('root wallet write failed') })

    await expect(getRouting(emitter, 'key-write-fails')).rejects.toThrow('root wallet write failed')
    expect(recordStore.size).toBe(0)
  })

  it('plain on() subscribers still fire via emitAsync (backward compatible with non-tenant listeners)', async () => {
    const emitter = new EventEmitter(agentDependencies as any, {} as any)
    const recordStore = new Map<string, string>()
    registerTenantRoutingListener(emitter, recordStore)

    let plainListenerFired = false
    emitter.on('RoutingCreatedEvent' as any, () => {
      plainListenerFired = true
    })

    await getRouting(emitter, 'key-plain-listener')

    expect(plainListenerFired).toBe(true)
  })
})

describe('tenant routing key registration — patched publishers stay wired up (source guard)', () => {
  // These guard against exactly the regression @devdgna caught in review: the tenants module's
  // listener moved to onAsync-only, but one of the two RoutingCreatedEvent publishers
  // (MediatorService) was left calling plain emit(), so it silently stopped reaching the
  // listener at all. A future edit reverting either publisher back to emit(), or moving the
  // tenants listener back to on(), would fail these before it reaches production.

  it('RoutingService.getRouting emits RoutingCreatedEvent via emitAsync', () => {
    const source = readVendoredSource('@credo-ts/core/build/modules/routing/services/RoutingService.js')
    expect(source).toMatch(/await this\.eventEmitter\.emitAsync\(agentContext,\s*\{\s*type:\s*RoutingEvents_1\.RoutingEventTypes\.RoutingCreatedEvent/)
  })

  it('MediatorService.createMediatorRoutingRecord emits RoutingCreatedEvent via emitAsync', () => {
    const source = readVendoredSource('@credo-ts/core/build/modules/routing/services/MediatorService.js')
    expect(source).toMatch(/await this\.eventEmitter\.emitAsync\(agentContext,\s*\{\s*type:\s*RoutingEvents_1\.RoutingEventTypes\.RoutingCreatedEvent/)
  })

  it('tenants module registers its recipient-key mapping listener via onAsync, not on', () => {
    const source = readVendoredSource('@credo-ts/tenants/build/context/TenantAgentContextProvider.js')
    expect(source).toMatch(/this\.eventEmitter\.onAsync\(core_1\.RoutingEventTypes\.RoutingCreatedEvent/)
    expect(source).not.toMatch(/this\.eventEmitter\.on\(core_1\.RoutingEventTypes\.RoutingCreatedEvent/)
  })
})
