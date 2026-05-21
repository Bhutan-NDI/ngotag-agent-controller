// Shared rolling counters for the controller gauge emitter.

let _sessionsInFlight = 0
let _sessionsWaiting = 0
let _sessionsWaitedMs: number[] = []
let _webhookFiresLast10s = 0

export function sessionAcquireStart(): void {
  _sessionsWaiting++
}

export function sessionAcquireEnd(waitMs: number): void {
  _sessionsWaiting = Math.max(0, _sessionsWaiting - 1)
  _sessionsInFlight++
  _sessionsWaitedMs.push(waitMs)
  if (_sessionsWaitedMs.length > 500) _sessionsWaitedMs.shift()
}

export function sessionReleased(): void {
  _sessionsInFlight = Math.max(0, _sessionsInFlight - 1)
}

export function recordWebhookFire(): void {
  _webhookFiresLast10s++
}

export interface ControllerGaugeSnapshot {
  sessions_in_flight: number
  sessions_waiting: number
  session_wait_p50_ms: number | null
  session_wait_p95_ms: number | null
  session_wait_sample_n: number
  webhook_fires_10s: number
}

export function snapshotAndReset(): ControllerGaugeSnapshot {
  const sorted = [..._sessionsWaitedMs].sort((a, b) => a - b)
  const n = sorted.length
  const p50 = n > 0 ? sorted[Math.floor(n * 0.5)] : null
  const p95 = n > 0 ? sorted[Math.floor(n * 0.95)] : null

  const snap: ControllerGaugeSnapshot = {
    sessions_in_flight: _sessionsInFlight,
    sessions_waiting: _sessionsWaiting,
    session_wait_p50_ms: p50,
    session_wait_p95_ms: p95,
    session_wait_sample_n: n,
    webhook_fires_10s: _webhookFiresLast10s,
  }

  _sessionsWaitedMs = []
  _webhookFiresLast10s = 0

  return snap
}
