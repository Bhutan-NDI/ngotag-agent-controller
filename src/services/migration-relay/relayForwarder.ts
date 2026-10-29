import { FORWARD_TIMEOUT_MS, MAX_FORWARD_RESPONSE_BYTES } from './relayConfig'

export type ForwardResult =
  // The target answered. Any status counts as delivered: the holder's app never retries on an HTTP status.
  | { kind: 'response'; status: number; contentType?: string; body: Buffer }
  // The request provably never left (no connection was made), so it is safe to send again.
  | { kind: 'neverLeft'; code: string }
  // It may have been delivered (timeout, reset): resending could make the target process it twice.
  | { kind: 'ambiguous'; reason: string }

export interface ForwardRequest {
  contentType: string
  body: string
}

export type ForwardFn = (target: string, request: ForwardRequest) => Promise<ForwardResult>

export const TLS_ERROR_CODES = new Set([
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'ERR_TLS_CERT_ALTNAME_INVALID',
])

const NEVER_LEFT_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
  ...TLS_ERROR_CODES,
])

// The target's body is read in chunks and abandoned once it passes the cap, so a hostile target cannot make the shared
// agent buffer more than the cap per forwarded message. Undefined means it was over the cap.
const readCapped = async (response: Response, cap: number): Promise<Buffer | undefined> => {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > cap) {
    await response.body?.cancel().catch(() => undefined)
    return undefined
  }
  if (!response.body) return Buffer.alloc(0)
  const chunks: Buffer[] = []
  let total = 0
  const reader = response.body.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return Buffer.concat(chunks)
    total += value.length
    if (total > cap) {
      await reader.cancel().catch(() => undefined)
      return undefined
    }
    chunks.push(Buffer.from(value))
  }
}

const errorCode = (error: unknown): string | undefined => {
  const cause = (error as { cause?: { code?: unknown } })?.cause
  const code = cause?.code ?? (error as { code?: unknown })?.code
  return 'string' === typeof code ? code : undefined
}

/**
 * POSTs an envelope, byte for byte, to the organisation's agent. A failure is classified by whether the request can
 * have reached it: only a failure before the connection was established (refused, unresolvable or unreachable host, TLS handshake) is safe to retry (Credo's own sender cannot
 * tell a timeout from a delivery either, DidCommHttpOutboundTransport).
 */
export const createForwarder =
  (timeoutMs: number = FORWARD_TIMEOUT_MS): ForwardFn =>
  async (target, request) => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetch(target, {
        method: 'POST',
        headers: { 'content-type': request.contentType },
        body: request.body,
        redirect: 'error',
        signal: controller.signal,
      })
      const body = await readCapped(response, MAX_FORWARD_RESPONSE_BYTES)
      if (!body) {
        return { kind: 'ambiguous', reason: 'RESPONSE_TOO_LARGE' }
      }
      return {
        kind: 'response',
        status: response.status,
        contentType: response.headers.get('content-type') ?? undefined,
        body,
      }
    } catch (error) {
      const code = errorCode(error)
      if (code && NEVER_LEFT_CODES.has(code)) {
        return { kind: 'neverLeft', code }
      }
      return { kind: 'ambiguous', reason: controller.signal.aborted ? 'TIMEOUT' : (code ?? 'NETWORK_ERROR') }
    } finally {
      clearTimeout(timer)
    }
  }

export const forwardEnvelope: ForwardFn = createForwarder()
