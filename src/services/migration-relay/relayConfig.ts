// The relay runs on the production shared agent, so it is off unless explicitly enabled, and it needs the shared
// Redis its state lives in (every ECS task must see the same entries and buffers).
export const isRelayEnabled = (env: NodeJS.ProcessEnv = process.env): boolean =>
  'true' === env.MIGRATION_RELAY_ENABLED && Boolean(env.REDIS_URL)

export const HOLD_BUFFER_CAP = 10_000
export const HOLD_BUFFER_TTL_SECONDS = 24 * 60 * 60

const positiveInteger = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value)
  return Number.isInteger(parsed) && 0 < parsed ? parsed : fallback
}

export const holdBufferCap = (env: NodeJS.ProcessEnv = process.env): number =>
  positiveInteger(env.MIGRATION_RELAY_HOLD_CAP, HOLD_BUFFER_CAP)

export const holdBufferTtlSeconds = (env: NodeJS.ProcessEnv = process.env): number =>
  positiveInteger(env.MIGRATION_RELAY_HOLD_TTL_SECONDS, HOLD_BUFFER_TTL_SECONDS)

// How often each shared-agent task re-reads the relay entries from the base wallet, which is what it falls back on
// when Redis is down or has been flushed.
export const MIRROR_REFRESH_MS = 30_000
// A removed relay is remembered for longer than a refresh, so a task with a stale mirror does not hold messages for it.
export const TOMBSTONE_TTL_SECONDS = 120
export const FORWARD_TIMEOUT_MS = 15_000
export const PROBE_TIMEOUT_MS = 5_000
export const MAX_FORWARD_RESPONSE_BYTES = 5 * 1024 * 1024
// Hot path: one Redis round trip per inbound message, so a slow Redis must fail open quickly, not stall the agent.
export const REDIS_COMMAND_TIMEOUT_MS = 500
export const REDIS_CONNECT_TIMEOUT_MS = 5_000
export const DAILY_COUNTER_TTL_SECONDS = 400 * 24 * 60 * 60
// Per-key "last seen" counters roll over after 12 months.
export const SEEN_COUNTER_TTL_SECONDS = 365 * 24 * 60 * 60
export const DRAIN_LOCK_MS = 30_000
export const DRAIN_BACKOFF_BASE_MS = 1_000
export const DRAIN_BACKOFF_MAX_MS = 60_000
export const REINJECT_PROCESSED_TIMEOUT_MS = 10_000
// A restore waits this long for a drainer that is mid-forward (FORWARD_TIMEOUT_MS) to let go of the lock.
export const RESTORE_LOCK_WAIT_MS = FORWARD_TIMEOUT_MS + 5_000
export const LOCK_POLL_MS = 250
