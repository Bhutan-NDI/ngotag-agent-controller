import { FORWARD_TIMEOUT_MS, MAX_FORWARD_RESPONSE_BYTES } from './relayConfig'

export type ForwardResult =
  // The target answered. Any status counts as delivered: the holder's app never retries on an HTTP status.
  | { kind: 'response'; status: number; contentType?: string; body: Buffer }
  // The request provably never left (connection refused, host not found), so it is safe to send again.
  | { kind: 'neverLeft'; code: string }
  // It may have been delivered (timeout, reset): resending could make the target process it twice.
  | { kind: 'ambiguous'; reason: string }

export interface ForwardRequest {
  contentType: string
  body: string
}

export type ForwardFn = (target: string, request: ForwardRequest) => Promise<ForwardResult>

const NEVER_LEFT_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN'])

const errorCode = (error: unknown): string | undefined => {
  const cause = (error as { cause?: { code?: unknown } })?.cause
  const code = cause?.code ?? (error as { code?: unknown })?.code
  return 'string' === typeof code ? code : undefined
}

/**
 * POSTs an envelope, byte for byte, to the organisation's agent. A failure is classified by whether the request can
 * have reached it: only a refused connection or an unresolvable host is safe to retry (Credo's own sender cannot
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
      const body = Buffer.from(await response.arrayBuffer())
      if (body.length > MAX_FORWARD_RESPONSE_BYTES) {
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
