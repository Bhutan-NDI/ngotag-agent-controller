/**
 * Deployment default, ceiling and per-request validation for proof request expiry (phase 2
 * decision, option c): DIDCOMM_PROOF_REQUEST_EXPIRY as the default, minimum 300 s, maximum the
 * purge ceiling (PURGE_CRON_ABANDONED_TTL_SECONDS minus a margin, or 7 days without the stale-proof
 * sweep), reject rather than clamp.
 */
import { BadRequestError } from '../../errors'
import {
  DEFAULT_PROOF_REQUEST_EXPIRY_SECONDS,
  MIN_PROOF_REQUEST_EXPIRY_SECONDS,
  NO_PURGE_PROOF_REQUEST_EXPIRY_CEILING_SECONDS,
  PURGE_CEILING_MARGIN_SECONDS,
  getProofRequestExpiryConfig,
  parseExpiresInSeconds,
  resetProofRequestExpiryConfig,
  resolveProofRequestExpiryConfig,
} from '../proofRequestExpiry'

const ENV_KEYS = [
  'DIDCOMM_PROOF_REQUEST_EXPIRY',
  'PURGE_ENABLED',
  'PURGE_CRON_ENABLED',
  'PURGE_CRON_STALE_PROOF_ENABLED',
  'PURGE_CRON_ABANDONED_TTL_SECONDS',
] as const

describe('resolveProofRequestExpiryConfig', () => {
  const saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {}

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key]
      delete process.env[key]
    }
    resetProofRequestExpiryConfig()
  })

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key]
      else process.env[key] = saved[key]
    }
    resetProofRequestExpiryConfig()
  })

  const enableCronPurge = (abandonedTtlSeconds?: number) => {
    process.env.PURGE_ENABLED = 'true'
    process.env.PURGE_CRON_ENABLED = 'true'
    if (abandonedTtlSeconds !== undefined) {
      process.env.PURGE_CRON_ABANDONED_TTL_SECONDS = String(abandonedTtlSeconds)
    }
  }

  it('defaults to 1800 s with a fixed 7-day ceiling when purge is off', () => {
    expect(resolveProofRequestExpiryConfig()).toEqual({
      defaultSeconds: DEFAULT_PROOF_REQUEST_EXPIRY_SECONDS,
      maxSeconds: NO_PURGE_PROOF_REQUEST_EXPIRY_CEILING_SECONDS,
    })
  })

  it('reads the default from DIDCOMM_PROOF_REQUEST_EXPIRY (QA/dev value)', () => {
    process.env.DIDCOMM_PROOF_REQUEST_EXPIRY = '300'
    expect(resolveProofRequestExpiryConfig().defaultSeconds).toBe(300)
  })

  it('uses the purge TTL minus the margin as the ceiling while the stale-proof sweep runs', () => {
    enableCronPurge()
    expect(resolveProofRequestExpiryConfig().maxSeconds).toBe(7 * 24 * 60 * 60 - PURGE_CEILING_MARGIN_SECONDS)

    enableCronPurge(2 * 24 * 60 * 60)
    expect(resolveProofRequestExpiryConfig().maxSeconds).toBe(2 * 24 * 60 * 60 - PURGE_CEILING_MARGIN_SECONDS)
  })

  it('falls back to the 7-day ceiling when the cron purge does not sweep stale proofs', () => {
    enableCronPurge(2 * 24 * 60 * 60)
    process.env.PURGE_CRON_STALE_PROOF_ENABLED = 'false'
    expect(resolveProofRequestExpiryConfig().maxSeconds).toBe(NO_PURGE_PROOF_REQUEST_EXPIRY_CEILING_SECONDS)
  })

  it.each(['abc', '1800s', '1.5', '-300', '0'])('fails on a malformed default "%s"', (value) => {
    process.env.DIDCOMM_PROOF_REQUEST_EXPIRY = value
    expect(() => resolveProofRequestExpiryConfig()).toThrow(/DIDCOMM_PROOF_REQUEST_EXPIRY must be a positive integer/)
  })

  it('fails when the default is below the 300 s minimum', () => {
    process.env.DIDCOMM_PROOF_REQUEST_EXPIRY = '299'
    expect(() => resolveProofRequestExpiryConfig()).toThrow(/out of bounds/)
  })

  it('fails when the default is above the purge ceiling', () => {
    enableCronPurge(2 * 60 * 60) // 2 h purge TTL -> 1 h ceiling
    process.env.DIDCOMM_PROOF_REQUEST_EXPIRY = '3601'
    expect(() => resolveProofRequestExpiryConfig()).toThrow(/out of bounds/)
  })

  it('caches the resolved config until reset', () => {
    process.env.DIDCOMM_PROOF_REQUEST_EXPIRY = '600'
    expect(getProofRequestExpiryConfig().defaultSeconds).toBe(600)
    process.env.DIDCOMM_PROOF_REQUEST_EXPIRY = '900'
    expect(getProofRequestExpiryConfig().defaultSeconds).toBe(600)
    resetProofRequestExpiryConfig()
    expect(getProofRequestExpiryConfig().defaultSeconds).toBe(900)
  })
})

describe('parseExpiresInSeconds', () => {
  const config = { defaultSeconds: 1800, maxSeconds: 601_200 }

  it('uses the deployment default when missing or null', () => {
    expect(parseExpiresInSeconds(undefined, config)).toBe(1800)
    expect(parseExpiresInSeconds(null, config)).toBe(1800)
  })

  it.each([MIN_PROOF_REQUEST_EXPIRY_SECONDS, 1800, 601_200])('accepts %d', (value) => {
    expect(parseExpiresInSeconds(value, config)).toBe(value)
  })

  it.each([299, 601_201, 0, -1])('rejects %d as out of bounds, without clamping', (value) => {
    expect(() => parseExpiresInSeconds(value, config)).toThrow(BadRequestError)
    expect(() => parseExpiresInSeconds(value, config)).toThrow(/between 300 and 601200 seconds/)
  })

  it.each([1.5, '600', NaN, Infinity, true])('rejects %p as not a whole number', (value) => {
    expect(() => parseExpiresInSeconds(value, config)).toThrow(/whole number of seconds/)
  })
})
