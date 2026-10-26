import fetch from 'node-fetch'

const PROBE_TIMEOUT_MS = 5000
const PROBE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface WebhookProbeResult {
  configured: boolean
  delivered: boolean
  status?: number
}

let configuredWebhookUrl: string | undefined

export const setWebhookUrl = (webhookUrl?: string): void => {
  configuredWebhookUrl = webhookUrl
}

export const isProbeId = (value: unknown): value is string => 'string' === typeof value && PROBE_ID.test(value)

/**
 * Sends one test event to `<webhookUrl>/probe`, the base the real events use, and reports whether anything answered.
 * What the receiver makes of it is for the receiver to say; the URL itself is never returned.
 */
export const probeWebhook = async (probeId: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<WebhookProbeResult> => {
  if (!configuredWebhookUrl) return { configured: false, delivered: false }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(`${configuredWebhookUrl}/probe`, {
      method: 'POST',
      body: JSON.stringify({ type: 'WebhookProbe', probeId }),
      headers: { 'Content-Type': 'application/json' },
      redirect: 'manual',
      signal: controller.signal,
    })
    return { configured: true, delivered: true, status: response.status }
  } catch {
    return { configured: true, delivered: false }
  } finally {
    clearTimeout(timer)
  }
}
