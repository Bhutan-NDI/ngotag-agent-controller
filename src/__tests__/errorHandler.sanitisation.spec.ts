/**
 * Locks the response body shut. Every branch of the handler must keep library, parser and runtime
 * text server-side, because an anonymous caller can reach this handler on the public routes.
 *
 * The distinction the handler draws is *resolved status*, not error class: a 4xx BaseError carries
 * an author-written message a client needs ("tenant not found"), while a 5xx carries whatever
 * ErrorHandlingService wrapped -- `handleCredoError` interpolates raw Credo text into an
 * InternalServerError, so class alone would not tell the two apart.
 */
import { jest } from '@jest/globals'

const { createErrorHandler } = await import('../errorHandler')
const { NotFoundError, InternalServerError, BadRequestError } = await import('../errors/errors')
const { ValidateError } = await import('tsoa')

type Logged = { level: string; message: string; data?: Record<string, unknown> }

function makeLogger(sink: Logged[]) {
  const record =
    (level: string) =>
    (message: string, data?: Record<string, unknown>): void => {
      sink.push({ level, message, data })
    }
  return {
    test: record('test'),
    trace: record('trace'),
    debug: record('debug'),
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
    fatal: record('fatal'),
    logLevel: 0,
    isEnabled: () => true,
  }
}

function makeRes() {
  const captured: { status?: number; body?: Record<string, unknown> } = {}
  const res = {
    status(code: number) {
      captured.status = code
      return this
    },
    json(body: Record<string, unknown>) {
      captured.body = body
      return this
    },
  }
  return { res, captured }
}

const req = { method: 'GET', path: '/didcomm/url/some-invitation' }

describe('createErrorHandler response sanitisation', () => {
  let logged: Logged[]
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let handler: any

  beforeEach(() => {
    logged = []
    handler = createErrorHandler(makeLogger(logged) as never)
  })

  it('does not return tsoa validation fields, but does log them', async () => {
    const fields = {
      'body.state': { message: 'should be one of the following; ["proposal-sent","done"]', value: 'x' },
    }
    const { res, captured } = makeRes()
    await handler(new ValidateError(fields, ''), req, res, jest.fn())

    expect(captured.status).toBe(422)
    expect(captured.body).toEqual({ message: 'Validation Failed' })
    expect(JSON.stringify(captured.body)).not.toContain('proposal-sent')
    expect(logged[0].data?.fields).toEqual(fields)
  })

  it('does not return the message of a 5xx BaseError', async () => {
    const { res, captured } = makeRes()
    await handler(new InternalServerError('CredoError: DidCommConnectionRecord not found'), req, res, jest.fn())

    expect(captured.status).toBe(500)
    expect(captured.body).toEqual({ message: 'Internal Server Error' })
    expect(logged[0].message).toContain('DidCommConnectionRecord')
  })

  it('still returns the message of a 4xx BaseError, which the client needs', async () => {
    const { res, captured } = makeRes()
    await handler(new NotFoundError('connection with invitationId "abc" not found.'), req, res, jest.fn())

    expect(captured.status).toBe(404)
    expect(captured.body).toEqual({ message: 'connection with invitationId "abc" not found.' })
  })

  it('still returns the message of a 400 BaseError', async () => {
    const { res, captured } = makeRes()
    await handler(new BadRequestError('TRUST_SERVICE_TOKEN_URL is not configured'), req, res, jest.fn())

    expect(captured.status).toBe(400)
    expect(captured.body).toEqual({ message: 'TRUST_SERVICE_TOKEN_URL is not configured' })
  })

  it('does not return a runtime error message', async () => {
    const { res, captured } = makeRes()
    await handler(new TypeError("Cannot read properties of undefined (reading 'modules')"), req, res, jest.fn())

    expect(captured.status).toBe(500)
    expect(captured.body).toEqual({ message: 'Internal Server Error' })
    expect(JSON.stringify(captured.body)).not.toContain('modules')
  })

  it('does not return a body-parser message, only the status reason phrase', async () => {
    const parseError = Object.assign(new SyntaxError('Unexpected end of JSON input'), {
      status: 400,
      statusCode: 400,
      type: 'entity.parse.failed',
    })
    const { res, captured } = makeRes()
    await handler(parseError, req, res, jest.fn())

    expect(captured.status).toBe(400)
    expect(captured.body).toEqual({ message: 'Bad Request' })
    expect(JSON.stringify(captured.body)).not.toContain('JSON input')
  })

  it('does not tell an unauthenticated caller why their credential was rejected', async () => {
    const authError = Object.assign(new Error('Unauthorized: Multitenant routes are disabled for dedicated agent'), {
      status: 401,
    })
    const { res, captured } = makeRes()
    await handler(authError, req, res, jest.fn())

    expect(captured.status).toBe(401)
    expect(captured.body).toEqual({ message: 'Unauthorized' })
    expect(JSON.stringify(captured.body)).not.toContain('Multitenant')
    expect(logged[0].message).toContain('Multitenant')
  })
})
