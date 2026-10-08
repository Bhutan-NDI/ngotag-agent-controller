import type { Express } from 'express'

import bodyParser from 'body-parser'
import { rateLimit } from 'express-rate-limit'

const baseMiddlewareMounted = new WeakSet<Express>()

/**
 * Health check, rate limiter and body parsers, in that order.
 *
 * Must run before any router that parses its own bodies is registered: Credo's OID4VC routers
 * mount `json()` with no limit, so whichever parser runs first sets the effective limit, and
 * theirs is 100 KiB against the 5 MiB configured here. Idempotent -- mounting the limiter twice
 * would count every request twice.
 */
export const mountBaseMiddleware = (app: Express) => {
  if (baseMiddlewareMounted.has(app)) return
  baseMiddlewareMounted.add(app)

  // Deliberately unauthenticated and unthrottled: used only by the load balancer to determine
  // whether the initialized HTTP server is available. Ahead of the limiter so a flood elsewhere
  // cannot make healthy instances look unhealthy.
  app.get('/health', (_req, res) => {
    res.status(200).json({ status: 'ok' })
  })

  const limiter = rateLimit({
    windowMs: Number(process.env.windowMs), // 1 second
    max: Number(process.env.maxRateLimit), // max 800 requests per second
  })

  // Ahead of the body parsers: a request that fails to parse never reaches what is mounted after them.
  app.use(limiter)

  app.use(
    bodyParser.urlencoded({
      extended: true,
      limit: process.env.APP_URL_ENCODED_BODY_SIZE ?? '5mb',
    }),
  )
  app.use(bodyParser.json({ limit: process.env.APP_JSON_BODY_SIZE ?? '5mb' }))
}
