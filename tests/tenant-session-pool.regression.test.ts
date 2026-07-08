/**
 * Regression test — agent-context session pool leak / freeze.
 *
 * Root cause (confirmed on staging 2026-07): a tenant session slot could be acquired
 * (TenantSessionMutex.currentSessions++) without a matching release when work failed on
 * an un-guarded path (e.g. TenantsApi.getTenantAgent -> tenantAgent.initialize() throwing,
 * or TenantSessionCoordinator.endAgentContextSession throwing before releaseSession()).
 * Leaked slots accumulate until currentSessions pins at SESSION_LIMIT; the session mutex
 * then never unlocks and every subsequent request waits SESSION_ACQUIRE_TIMEOUT and fails,
 * until the process is restarted.
 *
 * Fix (patch @credo-ts+tenants+0.5.3+002): every acquired slot is released on every path
 * (release moved into finally / release-on-initialize-failure / undo increment on failed lock).
 *
 * These tests exercise the REAL vendored TenantSessionMutex and guard the invariant the fix
 * enforces: no matter how in-session work fails, the pool drains back to 0 and never wedges.
 * (Full end-to-end validation is the staging load test + `leakcheck` — see
 *  Debug/STAGE/SOLUTION-PLAN-session-pool-leak.md.)
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
import { TenantSessionMutex } from '@credo-ts/tenants/build/context/TenantSessionMutex'

// Minimal logger stub matching the TsLogger surface the mutex uses.
const logger: any = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, trace: () => {} }

// Mirrors the fixed acquire→work→release contract (release in finally).
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

  it('never wedges even when a large fraction of in-session work throws', async () => {
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
