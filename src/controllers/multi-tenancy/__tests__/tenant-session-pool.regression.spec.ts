/**
 * Regression test — tenant agent-context session-pool leak / freeze.
 *
 * Root cause (confirmed on staging 2026-07): a tenant session slot could be acquired
 * (TenantSessionMutex.currentSessions++) without a matching release when work failed on an
 * unguarded path — TenantsApi._getTenantAgent() -> tenantAgent.initialize() throwing (slot already
 * acquired in getContextForSession), or the post-increment lock in acquireSession() timing out after
 * currentSessions was incremented. Leaked slots accumulate until currentSessions pins at the limit;
 * the session mutex then never unlocks and every subsequent request waits SESSION_ACQUIRE_TIMEOUT
 * and fails, until the process is restarted.
 *
 * Fix: patches/@credo-ts+tenants+0.6.2+002+session-release-exception-safe.patch — release the slot
 * on _getTenantAgent's initialize() failure (via endSession, which takes the normal mapping-present
 * path), and undo the increment when the post-increment lock rejects. (The coordinator's
 * unknown-mapping branch is intentionally left as the upstream throw: a call reaching it owns no
 * slot — sessionCount is already 0 — so releasing there would over-decrement another session.)
 *
 * These tests exercise the REAL vendored TenantSessionMutex and guard the invariant the fix
 * enforces: no matter how in-session work fails, the pool drains back to 0 and never wedges.
 * (The post-increment-lock decrement is a defensive guard for a rare concurrent interleaving that
 * async-mutex's synchronous locking makes non-deterministic to reproduce in a unit test.)
 */
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
  it('drains to 0 and stays unlocked after many balanced acquire/release cycles', async () => {
    const mutex: any = new TenantSessionMutex(logger, 100, 10000)
    for (let i = 0; i < 500; i++) {
      await mutex.acquireSession()
      mutex.releaseSession()
    }
    expect(mutex.currentSessions).toBe(0)
    expect(mutex.sessionMutex.isLocked()).toBe(false)
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
    expect(mutex.sessionMutex.isLocked()).toBe(false)
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
    // Counter pinned at the limit and the mutex is stuck locked.
    expect(mutex.currentSessions).toBe(3)
    expect(mutex.sessionMutex.isLocked()).toBe(true)
    // A healthy request can no longer get in — it times out: the production freeze.
    await expect(mutex.acquireSession()).rejects.toThrow(/Failed to acquire an agent context session/)
  })
})
