/**
 * Tests for purge configuration defaults and startup guards.
 *
 * The defaults are the last line of defence for a subsystem that permanently deletes data, so each
 * one is asserted explicitly:
 *   - an enabled purge actually deletes; dry-run is an opt-in census, and malformed values fail fast
 *   - the deprecated per-record webhook is off unless explicitly enabled
 *   - the deprecated state-blind NATS flow refuses to start without an explicit acknowledgement
 *   - an abandoned TTL below the safety floor is rejected rather than applied
 *
 * Runs under Jest ESM mode (see jest.config.base.ts).
 */
import { jest } from '@jest/globals'

// `nats` is imported by PurgeConfigValidator for the JetStream reachability probe. Stub it so the
// validator's non-NATS branches can be tested without a broker, and so the deprecation guard is
// proven to fire *before* any connection is attempted.
const connect = jest.fn(async () => ({
  jetstreamManager: jest.fn(async () => ({})),
  close: jest.fn(async () => {}),
}))

jest.unstable_mockModule('nats', () => ({
  connect,
  // Also consumed by `utils/NatsAuthenticator`, which PurgeConfigValidator imports.
  credsAuthenticator: jest.fn(),
  nkeyAuthenticator: jest.fn(),
  usernamePasswordAuthenticator: jest.fn(),
}))

const { buildPurgeConfig, PurgeRecordType } = await import('../PurgeTypes')
const { validatePurgeConfig } = await import('../PurgeConfigValidator')

const PURGE_ENV_KEYS = Object.keys(process.env).filter((key) => key.startsWith('PURGE_'))

function withEnv<T>(env: Record<string, string | undefined>, run: () => T): T {
  const saved = new Map<string, string | undefined>()
  for (const key of [...PURGE_ENV_KEYS, ...Object.keys(env)]) {
    saved.set(key, process.env[key])
    delete process.env[key]
  }
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) process.env[key] = value
  }
  try {
    return run()
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

const CRON_ENABLED = { PURGE_ENABLED: 'true', PURGE_CRON_ENABLED: 'true' }

describe('buildPurgeConfig — fail-safe defaults', () => {
  test('returns undefined unless PURGE_ENABLED is the literal "true"', () => {
    expect(withEnv({}, buildPurgeConfig)).toBeUndefined()
    expect(withEnv({ PURGE_ENABLED: 'yes', PURGE_CRON_ENABLED: 'true' }, buildPurgeConfig)).toBeUndefined()
  })

  test('PURGE_ENABLED=true with no flow selected fails loudly rather than silently doing nothing', () => {
    // Previously this returned undefined, and cliAgent only validates a truthy config — so the
    // validator's own "enable at least one mode" error was unreachable and a typo in
    // PURGE_CRON_ENABLED produced a purge that never ran while the master switch reported it on.
    expect(() => withEnv({ PURGE_ENABLED: 'true' }, buildPurgeConfig)).toThrow(
      /neither PURGE_NATS_ENABLED nor PURGE_CRON_ENABLED/,
    )
    expect(() => withEnv({ PURGE_ENABLED: 'true', PURGE_CRON_ENABLED: 'ture' }, buildPurgeConfig)).toThrow(
      /neither PURGE_NATS_ENABLED nor PURGE_CRON_ENABLED/,
    )
  })

  test('an enabled cron purge deletes — dry-run is an opt-in census mode, not the default', () => {
    // Enabling the purge is already a two-flag statement of intent; a third flag standing between
    // "enabled" and "actually deleting" would let the job look healthy while data grew unbounded.
    expect(withEnv(CRON_ENABLED, buildPurgeConfig)!.cronConfig.dryRun).toBe(false)
    expect(withEnv({ ...CRON_ENABLED, PURGE_CRON_DRY_RUN: '' }, buildPurgeConfig)!.cronConfig.dryRun).toBe(false)
    expect(withEnv({ ...CRON_ENABLED, PURGE_CRON_DRY_RUN: 'false' }, buildPurgeConfig)!.cronConfig.dryRun).toBe(false)
    expect(withEnv({ ...CRON_ENABLED, PURGE_CRON_DRY_RUN: 'true' }, buildPurgeConfig)!.cronConfig.dryRun).toBe(true)
  })

  test('a malformed PURGE_CRON_DRY_RUN fails startup instead of silently picking a mode', () => {
    // The one boolean whose lenient parsing would be asymmetric in the dangerous direction, so it
    // is strict in BOTH directions rather than trading one silent failure for another.
    for (const value of ['no', 'ture', 'TRUE', '1', 'yes']) {
      expect(() => withEnv({ ...CRON_ENABLED, PURGE_CRON_DRY_RUN: value }, buildPurgeConfig)).toThrow(
        /PURGE_CRON_DRY_RUN must be exactly "true" or "false"/,
      )
    }
  })

  test('the deprecated webhook is off unless explicitly enabled', () => {
    expect(withEnv(CRON_ENABLED, buildPurgeConfig)!.webhookEnabled).toBe(false)
    expect(withEnv({ ...CRON_ENABLED, PURGE_WEBHOOK_ENABLED: 'true' }, buildPurgeConfig)!.webhookEnabled).toBe(true)
  })

  test('batching, throttle and TTL defaults match the validated batch tool', () => {
    const { cronConfig } = withEnv(CRON_ENABLED, buildPurgeConfig)!

    expect(cronConfig.ttlSeconds).toBe(2_592_000) // 30 days
    expect(cronConfig.batchSize).toBe(100)
    expect(cronConfig.throttleMs).toBe(250)
    expect(cronConfig.timeBudgetMs).toBe(0) // unbudgeted unless an operator opts in
    expect(cronConfig.staleProofEnabled).toBe(true) // request-sent was 68% of prod proof volume
    expect(cronConfig.abandonedTtlSeconds).toBe(604_800) // 7 days — shorter than the 30-day terminal TTL
    expect(cronConfig.abandonedTtlSeconds).toBeLessThan(cronConfig.ttlSeconds)
  })

  test('all five record types are purged by default, and flags narrow the set', () => {
    expect(withEnv(CRON_ENABLED, buildPurgeConfig)!.cronConfig.recordTypes).toEqual([
      PurgeRecordType.DIDCOMM_CREDENTIAL,
      PurgeRecordType.DIDCOMM_PROOF,
      PurgeRecordType.DIDCOMM_OOB,
      PurgeRecordType.OID4VC_ISSUANCE,
      PurgeRecordType.OID4VC_VERIFICATION,
    ])

    const narrowed = withEnv({ ...CRON_ENABLED, PURGE_DIDCOMM_OOB: 'true' }, buildPurgeConfig)!
    expect(narrowed.cronConfig.recordTypes).toEqual([PurgeRecordType.DIDCOMM_OOB])
  })

  test('rejects non-positive and malformed numeric settings instead of falling back silently', () => {
    for (const value of ['0', '-1', 'abc', '1.5']) {
      expect(() => withEnv({ ...CRON_ENABLED, PURGE_CRON_TTL_SECONDS: value }, buildPurgeConfig)).toThrow(
        /PURGE_CRON_TTL_SECONDS/,
      )
    }
    // A zero throttle is legitimate (disables the sleep); a negative one is not.
    expect(withEnv({ ...CRON_ENABLED, PURGE_CRON_THROTTLE_MS: '0' }, buildPurgeConfig)!.cronConfig.throttleMs).toBe(0)
    expect(() => withEnv({ ...CRON_ENABLED, PURGE_CRON_THROTTLE_MS: '-1' }, buildPurgeConfig)).toThrow(
      /PURGE_CRON_THROTTLE_MS/,
    )
  })
})

describe('validatePurgeConfig — startup guards', () => {
  beforeEach(() => {
    connect.mockClear()
  })

  test('accepts a cron-only configuration', async () => {
    const config = withEnv(CRON_ENABLED, buildPurgeConfig)!
    await expect(validatePurgeConfig(config)).resolves.toBeUndefined()
    expect(connect).not.toHaveBeenCalled()
  })

  test('accepts an abandoned TTL shorter than the terminal TTL — that is the intended shape', async () => {
    const config = withEnv(
      { ...CRON_ENABLED, PURGE_CRON_TTL_SECONDS: '2592000', PURGE_CRON_ABANDONED_TTL_SECONDS: '604800' },
      buildPurgeConfig,
    )!

    // Dead requests are purged sooner than completed exchanges by design. An earlier revision
    // rejected this configuration outright, which made the production-derived policy unreachable.
    await expect(validatePurgeConfig(config)).resolves.toBeUndefined()
  })

  test('rejects an invalid cron expression with a message that names the setting', async () => {
    // node-cron only validates when the task is created, and fails with a bare
    // "Cannot read properties of undefined (reading 'replace')" — a crashed agent and no clue why.
    const config = withEnv({ ...CRON_ENABLED, PURGE_CRON_SCHEDULE: 'every day at 3' }, buildPurgeConfig)!

    await expect(validatePurgeConfig(config)).rejects.toThrow(/PURGE_CRON_SCHEDULE is not a valid cron expression/)

    const valid = withEnv({ ...CRON_ENABLED, PURGE_CRON_SCHEDULE: '0 3 * * *' }, buildPurgeConfig)!
    await expect(validatePurgeConfig(valid)).resolves.toBeUndefined()
  })

  test('rejects an abandoned TTL below the safety floor unless explicitly overridden', async () => {
    const tooShort = { ...CRON_ENABLED, PURGE_CRON_ABANDONED_TTL_SECONDS: '60' }

    // The floor guards the only real hazard: deleting a flow a holder is mid-response to.
    await expect(validatePurgeConfig(withEnv(tooShort, buildPurgeConfig)!)).rejects.toThrow(/below the 3600s floor/)

    const overridden = withEnv({ ...tooShort, PURGE_CRON_ALLOW_SHORT_ABANDONED_TTL: 'true' }, buildPurgeConfig)!
    await expect(validatePurgeConfig(overridden)).resolves.toBeUndefined()
  })

  test('refuses the deprecated NATS flow unless the state-blind behaviour is acknowledged', async () => {
    const config = withEnv({ PURGE_ENABLED: 'true', PURGE_NATS_ENABLED: 'true' }, buildPurgeConfig)!

    await expect(validatePurgeConfig(config)).rejects.toThrow(/deprecated and refused by default/)
    // The guard must fire before any broker connection is attempted.
    expect(connect).not.toHaveBeenCalled()
  })

  test('allows the NATS flow once acknowledged, and then probes JetStream', async () => {
    const config = withEnv(
      { PURGE_ENABLED: 'true', PURGE_NATS_ENABLED: 'true', PURGE_NATS_ACK_STATE_BLIND: 'true' },
      buildPurgeConfig,
    )!

    await expect(validatePurgeConfig(config)).resolves.toBeUndefined()
    expect(connect).toHaveBeenCalledTimes(1)
  })
})
