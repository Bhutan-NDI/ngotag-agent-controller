/**
 * ECS stops a task with SIGTERM and kills it once its stop timeout runs out (30s by default). The
 * graceful shutdown has several steps that can each wait on something -- the purge schedulers, Redis, the
 * wallet-portability and relay runtimes, the agent -- so it carries one overall bound, set under that
 * limit, after which the process leaves on its own terms instead of being killed mid-step.
 */
export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 25_000

export function shutdownTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const configured = Number(env.SHUTDOWN_TIMEOUT_MS)
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_SHUTDOWN_TIMEOUT_MS
}

/** Calls `onExpire` after `ms` unless the returned function cancels it. Never keeps the process alive. */
export function armShutdownDeadline(ms: number, onExpire: () => void): () => void {
  const timer = setTimeout(onExpire, ms)
  timer.unref()
  return () => clearTimeout(timer)
}
