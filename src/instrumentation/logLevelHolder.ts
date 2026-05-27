import { LogLevel } from '@credo-ts/core'

// Default threshold for emitStructured() instrumentation hops. At `warn`, all the info/debug
// trace hops (controller.handler.*, event.credential/proof.state, session.acquire,
// jsonld.context.fetch, webhook.fire, gauge.snapshot, http.inbound.received, etc.) are
// suppressed — production stays quiet by default. Raise it to `info` or `debug` at runtime via
// POST /admin/log-level when investigating; no redeploy needed.
let _level: LogLevel = LogLevel.warn

export function getDebugLogLevel(): LogLevel {
  return _level
}

export function setDebugLogLevel(level: LogLevel): void {
  _level = level
}
