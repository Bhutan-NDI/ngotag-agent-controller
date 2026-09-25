/** Tenant sessions release their slots after completed or failed work. */
import 'reflect-metadata'

// The package "exports" map does not expose build/* subpaths, so import the vendored file directly
// by relative path (same approach as the polygon patch regression specs in this repo). A template
// specifier keeps the resolution dynamic so tsc types it as `any` — the .mjs ships no declaration.
const TENANTS_BUILD = '../../../../node_modules/@credo-ts/tenants/build'
const { TenantSessionMutex } = await import(`${TENANTS_BUILD}/context/TenantSessionMutex.mjs`)

// Minimal logger stub matching the TsLogger surface the mutex uses.
const logger: any = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, trace: () => {} }

// Mirrors the fixed acquire -> work -> release contract (release in finally).
const withSession = async (mutex: any, work: () => Promise<void>): Promise<void> => {
  await mutex.acquireSession()
  try {
    await work()
  } finally {
    mutex.releaseSession()
  }
}

describe('tenant session pool — leak/freeze regression', () => {
  it('drains to 0 and clears pending acquisitions after many balanced acquire/release cycles', async () => {
    const mutex: any = new TenantSessionMutex(logger, 100, 10000)
    for (let i = 0; i < 500; i++) {
      await mutex.acquireSession()
      mutex.releaseSession()
    }
    expect(mutex.currentSessions).toBe(0)
    expect(mutex.pendingSessions).toBe(0)
  })

  it('never wedges even when a large fraction of in-session work throws (release in finally)', async () => {
    const mutex: any = new TenantSessionMutex(logger, 10, 2000)
    for (let i = 0; i < 200; i++) {
      try {
        await withSession(mutex, async () => {
          if (i % 3 === 0) throw new Error('simulated initialize()/callback failure')
        })
      } catch {
        // expected for the failing third of iterations
      }
    }
    // With release guaranteed in finally, the pool is fully drained despite ~1/3 failing.
    expect(mutex.currentSessions).toBe(0)
    expect(mutex.pendingSessions).toBe(0)
    // And a fresh request still acquires immediately (pool not frozen).
    await expect(mutex.acquireSession()).resolves.toBeUndefined()
    mutex.releaseSession()
  })

  it('documents the failure mode: skipping release on error wedges the pool at the ceiling', async () => {
    const mutex: any = new TenantSessionMutex(logger, 3, 300)
    // Simulate the pre-fix leak: acquire, then work throws and release is SKIPPED.
    for (let i = 0; i < 3; i++) {
      try {
        await mutex.acquireSession()
        throw new Error('initialize failed — release skipped (pre-fix behaviour)')
      } catch {
        /* leaked slot */
      }
    }
    // Counter pinned at the limit, with no remaining capacity.
    expect(mutex.currentSessions).toBe(3)
    expect(mutex.pendingSessions).toBe(0)
    // A healthy request can no longer get in — it times out: the production freeze.
    await expect(mutex.acquireSession()).rejects.toThrow(/Failed to acquire an agent context session/)
  })
})
