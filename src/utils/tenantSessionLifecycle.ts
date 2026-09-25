import type { RequestHandler, Response } from 'express'

import { TenantAgent } from '@credo-ts/tenants'

/** Release after response completion, including end() on an already disconnected socket.
 * A close event alone is insufficient: the controller may still be using its session.
 */
export const tenantSessionLifecycle: RequestHandler = (request, response, next) => {
  let released = false
  const release = () => {
    if (released) return
    released = true
    const agent = request.agent
    if (agent instanceof TenantAgent) {
      void agent.endSession().catch(() => {
        // Never log the agent, request, wallet, or an arbitrary upstream error.
        agent.config.logger.error('Failed to release HTTP tenant session')
      })
    }
  }
  const end = response.end
  response.end = function (this: Response, ...args: Parameters<typeof end>) {
    try {
      return end.apply(this, args)
    } finally {
      release()
    }
  } as typeof end
  response.once('finish', release)
  next()
}
