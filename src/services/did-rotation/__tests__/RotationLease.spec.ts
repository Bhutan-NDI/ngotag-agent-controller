import 'reflect-metadata'
import '@openwallet-foundation/askar-nodejs'
import { KdfMethod, Store, StoreKeyMethod } from '@openwallet-foundation/askar-shared'

import { RotationLease } from '../RotationLease'

const PROFILE = 'lease-test'

describe('RotationLease (real Askar store)', () => {
  let store: Store
  let lease: RotationLease

  beforeEach(async () => {
    store = await Store.provision({
      uri: 'sqlite://:memory:',
      keyMethod: new StoreKeyMethod(KdfMethod.Raw),
      passKey: Store.generateRawKey(),
      recreate: true,
      profile: PROFILE,
    })
    lease = new RotationLease(async () => ({ store, profile: PROFILE }))
  })

  afterEach(async () => {
    await store.close().catch(() => undefined)
  })

  it('grants a lease nobody holds, refuses another owner while it is valid, and renews it for its owner', async () => {
    await expect(lease.acquire('c1', 'task-a', 1000, 0)).resolves.toBe(true)

    await expect(lease.acquire('c1', 'task-b', 1000, 500)).resolves.toBe(false)
    await expect(lease.acquire('c1', 'task-a', 1000, 500)).resolves.toBe(true)
    await expect(lease.acquire('c1', 'task-b', 1000, 1400)).resolves.toBe(false)
  })

  it('lets another owner take over a lease that has expired, as when the task holding it died', async () => {
    await lease.acquire('c1', 'task-a', 1000, 0)

    await expect(lease.acquire('c1', 'task-b', 1000, 1001)).resolves.toBe(true)
    await expect(lease.acquire('c1', 'task-a', 1000, 1002)).resolves.toBe(false)
  })

  it('keeps leases apart by name', async () => {
    await lease.acquire('c1', 'task-a', 1000, 0)

    await expect(lease.acquire('c2', 'task-b', 1000, 0)).resolves.toBe(true)
  })

  it('frees a lease for its owner only', async () => {
    await lease.acquire('c1', 'task-a', 1000, 0)

    await lease.release('c1', 'task-b')
    await expect(lease.acquire('c1', 'task-b', 1000, 10)).resolves.toBe(false)

    await lease.release('c1', 'task-a')
    await expect(lease.acquire('c1', 'task-b', 1000, 10)).resolves.toBe(true)
  })

  it('gives a lease that does not exist yet to exactly one of several tasks asking at once', async () => {
    const owners = ['a', 'b', 'c', 'd', 'e']

    const granted = await Promise.all(owners.map((owner) => lease.acquire('c1', owner, 1000, 0).catch(() => false)))

    expect(granted.filter(Boolean)).toHaveLength(1)
  })

  it('does not release a lease that is not there', async () => {
    await expect(lease.release('missing', 'task-a')).resolves.toBeUndefined()
  })
})
