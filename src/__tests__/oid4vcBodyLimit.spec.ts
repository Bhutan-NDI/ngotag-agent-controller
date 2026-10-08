/**
 * Credo registers its OID4VC routers during agent.initialize(), and those routers mount their own
 * json() with no limit -- 100 KiB. Express body parsers are first-one-wins, so whichever parser is
 * mounted first sets the effective limit for those routes. If the configured 5 MiB parsers are
 * mounted after initialize(), OID4VC silently drops to 100 KiB and larger presentations are
 * rejected with 413.
 */
import { jest } from '@jest/globals'
import express from 'express'

import { mountBaseMiddleware } from '../baseMiddleware'

// Stands in for Credo's issuer/verifier context routers.
function credoStyleRouter() {
  const router = express.Router()
  router.use(express.json())
  router.post('/credential', (_req, res) => {
    res.json({ ok: true })
  })
  return router
}

async function postJson(app: express.Express, bytes: number) {
  const server = app.listen(0)
  try {
    const { port } = server.address() as { port: number }
    const response = await fetch(`http://127.0.0.1:${port}/oid4vci/credential`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ blob: 'x'.repeat(bytes) }),
    })
    return response.status
  } finally {
    server.close()
  }
}

describe('OID4VC body limit', () => {
  jest.setTimeout(20000)

  beforeAll(() => {
    process.env.windowMs = '1000'
    process.env.maxRateLimit = '100000'
  })

  it('accepts a payload above the 100 KiB default when mounted before the OID4VC router', async () => {
    const app = express()
    mountBaseMiddleware(app)
    app.use('/oid4vci', credoStyleRouter())
    expect(await postJson(app, 110 * 1024)).toBe(200)
  })

  it('rejects it when the OID4VC router is registered first', async () => {
    const app = express()
    app.use('/oid4vci', credoStyleRouter())
    mountBaseMiddleware(app)
    expect(await postJson(app, 110 * 1024)).toBe(413)
  })

  it('is idempotent, so the limiter cannot be mounted twice', () => {
    const app = express()
    const countLayers = () => (app as unknown as { _router?: { stack: unknown[] } })._router?.stack.length ?? 0
    mountBaseMiddleware(app)
    const after = countLayers()
    mountBaseMiddleware(app)
    expect(countLayers()).toBe(after)
  })
})
