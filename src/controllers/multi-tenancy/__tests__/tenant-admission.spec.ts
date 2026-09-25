import 'reflect-metadata'
import { CredoError } from '@credo-ts/core'
import { readFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'

import ErrorHandlingService from '../../../errorHandlingService'
import { tenantSessionConfig, isTenantAdmissionError } from '../../../utils/tenantSessionConfig'

const TENANTS_BUILD = '../../../../node_modules/@credo-ts/tenants/build'
const { TenantSessionMutex } = await import(`${TENANTS_BUILD}/context/TenantSessionMutex.mjs`)
const logger = { debug() {}, warn() {} }
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe('bounded tenant admission', () => {
  it('drains a concurrent burst, respects FIFO and recovers from work failures', async () => {
    const pool = new TenantSessionMutex(logger, 3, 1000, 30)
    const admitted: number[] = []
    let active = 0
    let peak = 0
    const results = await Promise.allSettled(
      Array.from({ length: 30 }, async (_, index) => {
        await pool.acquireSession()
        admitted.push(index)
        peak = Math.max(peak, ++active)
        try {
          await delay(2)
          if (index % 5 === 0) throw new Error('synthetic work failure')
        } finally {
          active--
          pool.releaseSession()
        }
      }),
    )
    expect(admitted).toEqual(Array.from({ length: 30 }, (_, index) => index))
    expect(peak).toBe(3)
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(24)
    expect(pool.currentSessions).toBe(0)
    expect(pool.pendingSessions).toBe(0)
  })

  it('rejects overflow and removes expired waiters without cancelling active work', async () => {
    const pool = new TenantSessionMutex(logger, 1, 15, 2)
    await pool.acquireSession()
    const queued = [pool.acquireSession(), pool.acquireSession()]
    const outcomes = Promise.allSettled(queued)
    await expect(pool.acquireSession()).rejects.toMatchObject({ code: 'TENANT_SESSION_CAPACITY_UNAVAILABLE' })
    expect(pool.pendingSessions).toBe(2)
    expect((await outcomes).every((result) => result.status === 'rejected')).toBe(true)
    expect(pool.pendingSessions).toBe(0)
    expect(pool.currentSessions).toBe(1)
    pool.releaseSession()
    await pool.acquireSession()
    pool.releaseSession()
    expect(pool.currentSessions).toBe(0)
  })

  it('checks the deadline even before a delayed timer callback can run', async () => {
    const pool = new TenantSessionMutex(logger, 1, 5, 2)
    await pool.acquireSession()
    const waiting = pool.acquireSession()
    const rejected = expect(waiting).rejects.toMatchObject({ code: 'TENANT_SESSION_CAPACITY_UNAVAILABLE' })
    const until = performance.now() + 15
    while (performance.now() < until) {
      /* simulate a busy event loop */
    }
    pool.releaseSession()
    await rejected
    expect(pool.currentSessions).toBe(0)
    expect(pool.pendingSessions).toBe(0)
  })

  it('transfers slots before admitting new arrivals and ignores redundant releases', async () => {
    const pool = new TenantSessionMutex(logger, 1, 1000, 2)
    await pool.acquireSession()
    const first = pool.acquireSession()
    pool.releaseSession()
    const second = pool.acquireSession()
    expect(pool.currentSessions).toBe(1)
    expect(pool.pendingSessions).toBe(1)
    await first
    pool.releaseSession()
    await second
    pool.releaseSession()
    pool.releaseSession()
    expect(pool.currentSessions).toBe(0)
  })

  it('maps only tagged Credo admission errors to 503', async () => {
    const pool = new TenantSessionMutex(logger, 1, 5, 1)
    await pool.acquireSession()
    const error = await pool.acquireSession().catch((error: unknown) => error)
    expect(isTenantAdmissionError(error)).toBe(true)
    expect(isTenantAdmissionError(Object.assign(new Error(), { code: 'TENANT_SESSION_CAPACITY_UNAVAILABLE' }))).toBe(
      false,
    )
    try {
      ErrorHandlingService.handle(error)
    } catch (converted) {
      expect(converted).toMatchObject({ statusCode: 503 })
    }
    expect(isTenantAdmissionError(new CredoError('ordinary failure'))).toBe(false)
    pool.releaseSession()
  })
})

describe('tenant session configuration', () => {
  it('has finite defaults and accepts explicit budgets', () => {
    expect(tenantSessionConfig({})).toEqual({
      sessionLimit: 10,
      sessionAcquireTimeout: 10000,
      sessionPendingLimit: 1000,
    })
    expect(
      tenantSessionConfig({ SESSION_LIMIT: '20', SESSION_ACQUIRE_TIMEOUT: '500', SESSION_PENDING_LIMIT: '100' }),
    ).toEqual({ sessionLimit: 20, sessionAcquireTimeout: 500, sessionPendingLimit: 100 })
  })
  it.each(['', ' ', '0', '-1', '1.5', 'Infinity', 'NaN', '1e2', '9007199254740992', 'sensitive-value'])(
    'rejects malformed budgets without echoing input: %s',
    (value) => {
      for (const name of ['SESSION_LIMIT', 'SESSION_ACQUIRE_TIMEOUT', 'SESSION_PENDING_LIMIT']) {
        expect(() => tenantSessionConfig({ [name]: value })).toThrow(`${name} must be an integer`)
      }
    },
  )
  it('rejects out-of-range budgets', () => {
    expect(() => tenantSessionConfig({ SESSION_LIMIT: '10001' })).toThrow()
    expect(() => tenantSessionConfig({ SESSION_PENDING_LIMIT: '10001' })).toThrow()
    expect(() => tenantSessionConfig({ SESSION_ACQUIRE_TIMEOUT: '600001' })).toThrow()
  })
})

it('reports effective budgets and distinguishes defaults from explicit values', () => {
  const entries: unknown[] = []
  const config = tenantSessionConfig({ SESSION_LIMIT: '12' }, { info: (...args) => entries.push(args) })
  expect(entries).toEqual([
    [
      'Tenant session admission budgets (per process)',
      {
        ...config,
        sources: { sessionLimit: 'explicit', sessionAcquireTimeout: 'default', sessionPendingLimit: 'default' },
      },
    ],
  ])
})

it('accepts the shipped demo session settings', () => {
  const env = Object.fromEntries(
    readFileSync('.env.demo', 'utf8')
      .split('\n')
      .filter((line) => /^SESSION_(LIMIT|ACQUIRE_TIMEOUT|PENDING_LIMIT)=/.test(line))
      .map((line) => line.split('=')),
  )
  expect(tenantSessionConfig(env)).toEqual({
    sessionLimit: 10,
    sessionAcquireTimeout: 10000,
    sessionPendingLimit: 1000,
  })
})
