import type { Logger } from '@credo-ts/core'

import fetch from 'node-fetch'

export const sendWebhookEvent = async (
  webhookUrl: string,
  body: Record<string, unknown>,
  logger: Logger,
  timeoutMs = Number(process.env.WEBHOOK_TIMEOUT_MS) || 1000
) => {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)

  try {
    await fetch(webhookUrl, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
    })
  } catch (error: any) {
    logger.error(`Error sending ${body.type} webhook event to ${webhookUrl}`, {
      cause: error,
      aborted: error.name === 'AbortError',
    })
  } finally {
    clearTimeout(timeout)
  }
}
