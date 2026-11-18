import type { Express } from 'express'

import bodyParser from 'body-parser'
import { rateLimit } from 'express-rate-limit'

const baseMiddlewareMounted = new WeakSet<Express>()

/**
 * How many reverse proxies in front of the controller Express trusts to report the client address
 * in X-Forwarded-For. The rate limiter keys on that address: without it every client behind the
 * load balancer shares one bucket keyed by the load balancer's own IP.
 *
 * Defaults to 1 (one load balancer or ingress, as in every current deployment). Set 0 when clients
 * connect directly; a value above the real hop count lets clients pick their own limiter key.
 */
export function trustedProxyHops(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.TRUST_PROXY_HOPS
  if (raw === undefined || raw === '') return 1
  if (/^\d+$/.test(raw)) return Number(raw)
  throw new Error('TRUST_PROXY_HOPS must be a non-negative integer')
}

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

  app.set('trust proxy', trustedProxyHops())

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
