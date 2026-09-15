/**
 * A request whose body fails to parse never reaches middleware mounted after the body parsers --
 * body-parser calls next(err), which skips straight to the error handler. With the limiter mounted
 * after them, a flood of malformed payloads was answered 400 without ever being counted, leaving
 * the only volumetric control on the API inert against the cheapest possible request to send.
 *
 * The behavioural half of this file demonstrates that; the structural half asserts the real
 * server.ts still mounts things in the order that avoids it.
 */
import { jest } from '@jest/globals'
import bodyParser from 'body-parser'
import express from 'express'
import { rateLimit } from 'express-rate-limit'
import { readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const here = dirname(fileURLToPath(import.meta.url))

function appWith(order: 'limiter-first' | 'parsers-first') {
  const app = express()
  let counted = 0
  const limiter = rateLimit({ windowMs: 1000, max: 1000 })
  const count = (_req: unknown, _res: unknown, next: () => void) => {
    counted += 1
    next()
  }
  const parsers = () => {
    app.use(bodyParser.urlencoded({ extended: true, limit: '5mb' }))
    app.use(bodyParser.json({ limit: '5mb' }))
  }

  if (order === 'limiter-first') {
    app.use(count, limiter)
    parsers()
  } else {
    parsers()
    app.use(count, limiter)
  }

  app.post('/echo', (_req, res) => {
    res.json({ ok: true })
  })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app.use((err: any, _req: unknown, res: any, _next: unknown) => {
    res.status(err.statusCode ?? 500).json({ message: 'Bad Request' })
  })

  return { app, counted: () => counted }
}

async function postMalformed(app: express.Express) {
  const server = app.listen(0)
  try {
    const { port } = server.address() as { port: number }
    const response = await fetch(`http://127.0.0.1:${port}/echo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"unterminated":',
    })
    return response.status
  } finally {
    server.close()
  }
}

describe('rate limiter placement', () => {
  jest.setTimeout(20000)

  it('counts a request whose body fails to parse', async () => {
    const { app, counted } = appWith('limiter-first')
    expect(await postMalformed(app)).toBe(400)
    expect(counted()).toBe(1)
  })

  it('demonstrates the regression: mounted after the parsers, the same request is uncounted', async () => {
    const { app, counted } = appWith('parsers-first')
    expect(await postMalformed(app)).toBe(400)
    expect(counted()).toBe(0)
  })
})

describe('baseMiddleware.ts mount order', () => {
  const source = readFileSync(join(here, '..', 'baseMiddleware.ts'), 'utf8')
  const indexOf = (needle: string) => {
    const at = source.indexOf(needle)
    expect(at).toBeGreaterThan(-1)
    return at
  }

  it('mounts the limiter before both body parsers', () => {
    const limiter = indexOf('app.use(limiter)')
    expect(limiter).toBeLessThan(indexOf('bodyParser.urlencoded'))
    expect(limiter).toBeLessThan(indexOf('bodyParser.json'))
  })

  it('leaves the load balancer health check ahead of the limiter', () => {
    expect(indexOf("app.get('/health'")).toBeLessThan(indexOf('app.use(limiter)'))
  })
})

describe('cliAgent.ts app composition', () => {
  const source = readFileSync(join(here, '..', 'cliAgent.ts'), 'utf8')
  const indexOf = (needle: string) => {
    const at = source.indexOf(needle)
    expect(at).toBeGreaterThan(-1)
    return at
  }

  // A parser mounted on the app here would run before the limiter and reclaim the bypass, which is
  // invisible to the source assertions above.
  it('mounts no body parser of its own on the app it hands to setupServer', () => {
    expect(source).not.toMatch(/expressApp\.use\(\s*(express\.(json|urlencoded)|bodyParser)/)
  })

  // initialize() registers Credo's OID4VC routers, which mount their own 100 KiB json().
  it('mounts the base middleware before agent.initialize()', () => {
    expect(indexOf('mountBaseMiddleware(expressApp)')).toBeLessThan(indexOf('await agent.initialize()'))
  })
})
