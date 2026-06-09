import { LogLevel } from '@credo-ts/core'
import * as os from 'os'

import { getDebugLogLevel } from '../instrumentation/logLevelHolder'

export type HopName =
  | 'controller.config.dump'
  | 'controller.http.inbound.received'
  | 'controller.tenant.resolve.start'
  | 'controller.tenant.resolve.end'
  | 'controller.session.acquire.start'
  | 'controller.session.acquire.end'
  | 'controller.wallet.open.start'
  | 'controller.wallet.open.end'
  | 'controller.handler.entry'
  | 'controller.handler.exit'
  | 'controller.jsonld.context.fetch.start'
  | 'controller.jsonld.context.fetch.end'
  | 'controller.askar.query.start'
  | 'controller.askar.query.end'
  | 'controller.event.proof.state'
  | 'controller.event.credential.state'
  | 'controller.webhook.fire.start'
  | 'controller.webhook.fire.end'
  | 'controller.gauge.snapshot'

export type FlowType =
  | 'connection'
  | 'issuance'
  | 'verification'
  | 'pickup'
  | 'mediation-coord'
  | 'lifecycle'

export interface StructuredLogLine {
  hop: HopName
  flow?: FlowType
  thread_id?: string
  jwe_fp?: string
  recipient_key_short?: string
  tenant_id?: string
  conn_id?: string
  span_id?: string
  duration_ms?: number
  wait_ms?: number
  notes?: string
  [key: string]: unknown
}

const TASK_HOST = process.env.HOSTNAME || os.hostname()

// Master switch for the latency debug instrumentation (env INSTRUMENTATION_ENABLED,
// default off). When off, emitStructured() hard-returns and the wiring that calls
// it — HTTP inbound middleware, the instrumented tenant wrapper, gauges, the
// admin endpoint — is not installed, so the service runs the stock behaviour with
// no instrumentation on the hot path. When on, /admin/log-level controls verbosity.
const INSTRUMENTATION_ENABLED = process.env.INSTRUMENTATION_ENABLED === 'true'

export function isInstrumentationEnabled(): boolean {
  return INSTRUMENTATION_ENABLED
}

export function emitStructured(level: LogLevel, line: StructuredLogLine): void {
  if (!INSTRUMENTATION_ENABLED) return
  if (level < getDebugLogLevel()) return

  const out: Record<string, unknown> = {
    ts: new Date().toISOString(),
    ts_mono_ns: Number(process.hrtime.bigint()),
    service: 'agent-controller',
    task_host: TASK_HOST,
    ...line,
  }

  for (const key of Object.keys(out)) {
    if (out[key] === undefined) delete out[key]
  }

  process.stdout.write(JSON.stringify(out) + '\n')
}

export function makeSpanId(): string {
  return Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10)
}

export function monoNow(): number {
  return Number(process.hrtime.bigint())
}

export function durationMs(startMono: number): number {
  return Math.round((Number(process.hrtime.bigint()) - startMono) / 1e6)
}

export function truncateKey(key: string): string {
  if (key.length <= 14) return key
  return key.slice(0, 6) + '…' + key.slice(-6)
}

// Extracts the JWE top-level `iv` as a per-message fingerprint and the recipient key
// for cross-service log correlation.
export function tryExtractFromJwe(rawBody: string): { recipientKeyShort: string; jweFp: string } {
  try {
    const parsed = JSON.parse(rawBody) as Record<string, unknown>
    let recipientKeyShort = ''

    // Try top-level recipients first (standard JWE General JSON Serialization)
    const recipients = parsed['recipients']
    if (Array.isArray(recipients) && recipients.length > 0) {
      const firstRecip = recipients[0] as Record<string, unknown>
      const hdr = firstRecip['header'] as Record<string, unknown> | undefined
      const kid = hdr?.['kid']
      if (typeof kid === 'string' && kid.length > 0) recipientKeyShort = truncateKey(kid)
    }

    // Fall back: Aries DIDComm v1 Authcrypt puts recipients inside the protected header
    if (!recipientKeyShort) {
      const protectedB64 = parsed['protected']
      if (typeof protectedB64 === 'string') {
        try {
          const headerStr = Buffer.from(protectedB64, 'base64').toString('utf8')
          const header = JSON.parse(headerStr) as Record<string, unknown>
          const innerRecipients = header['recipients']
          if (Array.isArray(innerRecipients) && innerRecipients.length > 0) {
            const first = innerRecipients[0] as Record<string, unknown>
            const hdr = first['header'] as Record<string, unknown> | undefined
            const kid = hdr?.['kid']
            if (typeof kid === 'string') recipientKeyShort = truncateKey(kid)
          }
        } catch {
          // ignore
        }
      }
    }

    // iv fingerprint: unique per JWE encryption, visible at both ends without decryption
    const iv = parsed['iv']
    const jweFp = typeof iv === 'string' ? iv : ''

    return { recipientKeyShort, jweFp }
  } catch {
    return { recipientKeyShort: '', jweFp: '' }
  }
}
