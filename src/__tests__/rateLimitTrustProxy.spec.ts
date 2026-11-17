/**
 * Behind a load balancer or reverse proxy every request arrives from the proxy's address. Unless
 * Express trusts that proxy's X-Forwarded-For entry, the rate limiter keys every client on the
 * proxy's IP, so all clients share one bucket (and express-rate-limit logs a ValidationError).
 */
import { jest } from '@jest/globals'
import express from 'express'

import { mountBaseMiddleware, trustedProxyHops } from '../baseMiddleware'

// What a single proxy (ALB, NGINX with $proxy_add_x_forwarded_for, Apache mod_proxy) forwards: any
// header the client sent, followed by the client address the proxy saw.
const viaProxy = (clientIp: string, clientSent?: string) => (clientSent ? `${clientSent}, ${clientIp}` : clientIp)

async function statuses(app: express.Express, forwardedFor: (string | undefined)[]) {
  const server = app.listen(0)
  try {
    const { port } = server.address() as { port: number }
    const results: number[] = []
    for (const header of forwardedFor) {
      const response = await fetch(`http://127.0.0.1:${port}/ping`, {
        headers: header ? { 'X-Forwarded-For': header } : {},
      })
      results.push(response.status)
    }
    return results
  } finally {
    server.close()
  }
}

function limitedApp() {
  const app = express()
  mountBaseMiddleware(app)
  app.get('/ping', (_req, res) => {
    res.json({ ok: true })
  })
  return app
}

describe('rate limiter behind a proxy', () => {
  jest.setTimeout(20000)

  const saved = { ...process.env }
  beforeEach(() => {
    process.env.windowMs = '60000'
    process.env.maxRateLimit = '1'
    delete process.env.TRUST_PROXY_HOPS
  })
  afterAll(() => {
    process.env = saved
  })

  it('gives each client behind one proxy its own bucket', async () => {
    const results = await statuses(limitedApp(), [viaProxy('203.0.113.1'), viaProxy('203.0.113.2')])
    expect(results).toEqual([200, 200])
  })

  it('still limits a single client', async () => {
    const results = await statuses(limitedApp(), [viaProxy('203.0.113.1'), viaProxy('203.0.113.1')])
    expect(results).toEqual([200, 429])
  })

  it('ignores an X-Forwarded-For value the client wrote itself', async () => {
    const results = await statuses(limitedApp(), [
      viaProxy('203.0.113.1', '198.51.100.7'),
      viaProxy('203.0.113.1', '198.51.100.8'),
    ])
    expect(results).toEqual([200, 429])
  })

  it('does not log the express-rate-limit X-Forwarded-For validation error', async () => {
    const errors = jest.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      await statuses(limitedApp(), [viaProxy('203.0.113.1')])
      const messages = errors.mock.calls.map((call) => String(call[0]))
      expect(messages.filter((message) => message.includes('X-Forwarded-For'))).toEqual([])
    } finally {
      errors.mockRestore()
    }
  })

  it('trusts no header with TRUST_PROXY_HOPS=0, for clients that connect directly', async () => {
    process.env.TRUST_PROXY_HOPS = '0'
    const results = await statuses(limitedApp(), [viaProxy('203.0.113.1'), viaProxy('203.0.113.2')])
    expect(results).toEqual([200, 429])
  })

  it('falls back to the connection address when the proxy sends no header', async () => {
    const results = await statuses(limitedApp(), [undefined, undefined])
    expect(results).toEqual([200, 429])
  })
})

describe('trustedProxyHops', () => {
  it.each([
    [undefined, 1],
    ['', 1],
    ['0', 0],
    ['1', 1],
    ['2', 2],
  ])('TRUST_PROXY_HOPS=%s -> %s', (value, expected) => {
    expect(trustedProxyHops(value === undefined ? {} : { TRUST_PROXY_HOPS: value })).toBe(expected)
  })

  it.each(['-1', '1.5', 'true', 'yes', ' 1'])('rejects TRUST_PROXY_HOPS=%s', (value) => {
    expect(() => trustedProxyHops({ TRUST_PROXY_HOPS: value })).toThrow(
      'TRUST_PROXY_HOPS must be a non-negative integer',
    )
  })
})
