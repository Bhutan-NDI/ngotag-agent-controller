import { CredoError } from '@credo-ts/core'

/** Per-process admission budgets; these are not database connection limits. */
export function tenantSessionConfig(env: NodeJS.ProcessEnv = process.env) {
  const integer = (name: string, fallback: number, maximum: number): number => {
    const raw = env[name]
    if (raw === undefined) return fallback
    const value = Number(raw)
    if (!/^[0-9]+$/.test(raw) || !Number.isSafeInteger(value) || value < 1 || value > maximum) {
      throw new Error(`${name} must be an integer between 1 and ${maximum}`)
    }
    return value
  }
  return {
    sessionLimit: integer('SESSION_LIMIT', 10, 10000),
    sessionAcquireTimeout: integer('SESSION_ACQUIRE_TIMEOUT', 10000, 600000),
    sessionPendingLimit: integer('SESSION_PENDING_LIMIT', 1000, 10000),
  }
}

export function isTenantAdmissionError(error: unknown): boolean {
  return error instanceof CredoError && 'code' in error && error.code === 'TENANT_SESSION_CAPACITY_UNAVAILABLE'
}
