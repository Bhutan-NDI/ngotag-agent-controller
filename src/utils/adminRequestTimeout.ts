// Node ends any request that takes longer than five minutes to arrive. A sealed wallet pushed to the dedicated agent
// over a slow link takes longer, so the admin server allows a push to run as long as the platform lets it.
const DEFAULT_ADMIN_REQUEST_TIMEOUT_MS = 35 * 60 * 1000

export const adminRequestTimeoutMs = (env: NodeJS.ProcessEnv = process.env): number => {
  const configured = Number(env.ADMIN_REQUEST_TIMEOUT_MS)
  return Number.isInteger(configured) && 0 < configured ? configured : DEFAULT_ADMIN_REQUEST_TIMEOUT_MS
}
