import { LogLevel } from '@credo-ts/core'

// Default threshold for emitStructured() instrumentation hops. The instrumentation emits at
// `trace`, so at the `warn` default every hop (controller.handler.*, event.credential/proof.state,
// session.acquire, jsonld.context.fetch, webhook.fire, gauge.snapshot, etc.) is suppressed —
// production stays quiet by default. To capture them, set the level to `trace` at runtime via
// POST /admin/log-level (the deepest, explicitly-enabled level); no redeploy needed.
let _level: LogLevel = LogLevel.warn

export function getDebugLogLevel(): LogLevel {
  return _level
}

export function setDebugLogLevel(level: LogLevel): void {
  _level = level
}
