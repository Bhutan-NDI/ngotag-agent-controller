import { RelayDrainer } from '../RelayDrainer'
import { RelayStore } from '../RelayStore'
import { createForwarder } from '../relayForwarder'

import { startTarget } from './targetServer'
import { DIDCOMM_MIME, FakeRedis, eventually, silentLogger } from './testSupport'

const TENANT = 'tenant-1'
const held = (n: number) => ({ receivedAt: 'now', contentType: DIDCOMM_MIME, body: `{"n":${n}}` })

describe('RelayDrainer', () => {
  let redis: FakeRedis
  let store: RelayStore
  let drainer: RelayDrainer
  const cleanups: (() => Promise<void>)[] = []

  const build = (timeoutMs = 300) => {
    drainer = new RelayDrainer(store, createForwarder(timeoutMs), silentLogger(), {
      backoffBaseMs: 10,
      backoffMaxMs: 40,
    })
  }

  beforeEach(() => {
    redis = new FakeRedis()
    store = new RelayStore(redis)
    build()
  })

  afterEach(async () => {
    drainer.stop()
    for (const cleanup of cleanups.splice(0)) await cleanup()
  })

  it('delivers a held buffer to the target in the order it arrived, each message once', async () => {
    const target = await startTarget()
    cleanups.push(() => target.close())
    await store.setEntry({ tenantId: TENANT, mode: 'HOLD', updatedAt: 'now' })
    for (const n of [1, 2, 3, 4]) await store.holdPush(TENANT, held(n))
    await store.setEntry({ tenantId: TENANT, mode: 'FORWARD', target: target.url, updatedAt: 'now' })

    drainer.ensureDraining(TENANT)

    await eventually(async () => 0 === (await store.holdLength(TENANT)) && 4 === target.received.length)
    expect(target.received.map((request) => request.body)).toEqual(['{"n":1}', '{"n":2}', '{"n":3}', '{"n":4}'])
  })

  it('does nothing while the relay is still holding', async () => {
    const target = await startTarget()
    cleanups.push(() => target.close())
    await store.setEntry({ tenantId: TENANT, mode: 'HOLD', updatedAt: 'now' })
    await store.holdPush(TENANT, held(1))

    drainer.ensureDraining(TENANT)
    await new Promise((resolve) => setTimeout(resolve, 100))

    expect(target.received).toEqual([])
    expect(await store.holdLength(TENANT)).toBe(1)
  })

  it('backs off and retries while the target is unreachable, then delivers', async () => {
    const probe = await startTarget()
    const { port } = probe
    await probe.close()
    await store.setEntry({ tenantId: TENANT, mode: 'FORWARD', target: `http://127.0.0.1:${port}/`, updatedAt: 'now' })
    await store.holdPush(TENANT, held(1))

    drainer.ensureDraining(TENANT)
    await new Promise((resolve) => setTimeout(resolve, 120))
    expect(await store.holdLength(TENANT)).toBe(1)

    const target = await startTarget((_request, res) => res.writeHead(200).end(), port)
    cleanups.push(() => target.close())
    await eventually(async () => 0 === (await store.holdLength(TENANT)))
    expect(target.received).toHaveLength(1)
  })

  it('drops, and does not resend, a message whose delivery is unknown, then carries on', async () => {
    let calls = 0
    const target = await startTarget((_request, res) => {
      calls += 1
      if (1 === calls) return
      res.writeHead(200).end()
    })
    cleanups.push(() => target.close())
    build(150)
    await store.setEntry({ tenantId: TENANT, mode: 'FORWARD', target: target.url, updatedAt: 'now' })
    await store.holdPush(TENANT, held(1))
    await store.holdPush(TENANT, held(2))

    drainer.ensureDraining(TENANT)

    await eventually(async () => 0 === (await store.holdLength(TENANT)))
    expect(target.received.map((request) => request.body)).toEqual(['{"n":1}', '{"n":2}'])
  })

  it('treats any answer from the target as delivered, including an error', async () => {
    const target = await startTarget((_request, res) => res.writeHead(500).end())
    cleanups.push(() => target.close())
    await store.setEntry({ tenantId: TENANT, mode: 'FORWARD', target: target.url, updatedAt: 'now' })
    await store.holdPush(TENANT, held(1))

    drainer.ensureDraining(TENANT)

    await eventually(async () => 0 === (await store.holdLength(TENANT)))
    expect(target.received).toHaveLength(1)
  })

  it('leaves the buffer to another task that holds the drain lock, and picks up if it stops', async () => {
    const target = await startTarget()
    cleanups.push(() => target.close())
    await store.setEntry({ tenantId: TENANT, mode: 'FORWARD', target: target.url, updatedAt: 'now' })
    await store.holdPush(TENANT, held(1))
    await store.acquireDrainLock(TENANT, 'another-task')

    drainer.ensureDraining(TENANT)
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(target.received).toEqual([])

    await store.releaseDrainLock(TENANT, 'another-task')
    await eventually(async () => 0 === (await store.holdLength(TENANT)))
    expect(target.received).toHaveLength(1)
  })

  it('stops once the relay entry is gone', async () => {
    const target = await startTarget()
    cleanups.push(() => target.close())
    await store.holdPush(TENANT, held(1))

    drainer.ensureDraining(TENANT)
    await new Promise((resolve) => setTimeout(resolve, 80))

    expect(target.received).toEqual([])
    expect(await store.holdLength(TENANT)).toBe(1)
  })

  it('does not start a second drain for a tenant it is already draining', async () => {
    const target = await startTarget()
    cleanups.push(() => target.close())
    await store.setEntry({ tenantId: TENANT, mode: 'FORWARD', target: target.url, updatedAt: 'now' })
    for (const n of [1, 2, 3]) await store.holdPush(TENANT, held(n))

    drainer.ensureDraining(TENANT)
    drainer.ensureDraining(TENANT)
    drainer.ensureDraining(TENANT)

    await eventually(async () => 0 === (await store.holdLength(TENANT)))
    expect(target.received).toHaveLength(3)
  })
})
