/**
 * Locks the request error path in place:
 *
 *   1. `ErrorHandlingService.handle()` converts the error but must preserve the pre-conversion
 *      one as `cause`. `BaseError` calls Error.captureStackTrace, which re-roots its own stack
 *      at the conversion site, so `cause` is the only surviving reference to the real origin.
 *
 *   2. The Express handler picks its level from the *resolved status*, not the branch. A 404 is
 *      a normal outcome of a normal request and must not sit in the error stream.
 *
 *   3. Every rejection produces exactly one log line and one response — including a thrown
 *      string or plain object, which previously fell through to a bare next() and produced
 *      neither.
 */
import { jest } from '@jest/globals'

const { createErrorHandler } = await import('../errorHandler')
const ErrorHandlingService = (await import('../errorHandlingService')).default
const { BaseError, NotFoundError, InternalServerError } = await import('../errors/errors')

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
  const captured: { status?: number; body?: unknown } = {}
  const res = {
    status(code: number) {
      captured.status = code
      return this
    },
    json(body: unknown) {
      captured.body = body
      return this
    },
  }
  return { res, captured }
}

const req = { method: 'POST', path: '/credentials' }

describe('ErrorHandlingService.handle', () => {
  function originalFailure(): never {
    throw new Error('Askar: wallet not found')
  }

  it('preserves the pre-conversion error as cause', () => {
    let converted: InstanceType<typeof BaseError> | undefined
    try {
      try {
        originalFailure()
      } catch (error) {
        ErrorHandlingService.handle(error)
      }
    } catch (error) {
      converted = error as InstanceType<typeof BaseError>
    }

    expect(converted).toBeInstanceOf(BaseError)
    const cause = converted?.cause as Error
    expect(cause.message).toBe('Askar: wallet not found')
    // The converted error's own stack is re-rooted; the cause still points at the throw site.
    expect(cause.stack).toContain('originalFailure')
    expect(converted?.stack).not.toContain('originalFailure')
  })
})

describe('createErrorHandler', () => {
  let logged: Logged[]
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let handler: any

  beforeEach(() => {
    logged = []
    handler = createErrorHandler(makeLogger(logged) as never)
  })

  it('logs a 404 at warn, not error', async () => {
    const { res, captured } = makeRes()
    await handler(new NotFoundError('Tenant not found'), req, res, jest.fn())

    expect(captured.status).toBe(404)
    expect(logged).toHaveLength(1)
    expect(logged[0].level).toBe('warn')
    expect(logged[0].message).toContain('POST /credentials -> 404')
  })

  it('logs a 500 at error', async () => {
    const { res, captured } = makeRes()
    await handler(new InternalServerError('CredoError: boom'), req, res, jest.fn())

    expect(captured.status).toBe(500)
    expect(logged).toHaveLength(1)
    expect(logged[0].level).toBe('error')
  })

  it('logs the cause, not the re-rooted converted error', async () => {
    const cause = new Error('Askar: wallet not found')
    const converted = new InternalServerError('CredoError: Askar: wallet not found')
    converted.cause = cause

    const { res } = makeRes()
    await handler(converted, req, res, jest.fn())

    expect(logged[0].data?.error).toBe(cause)
  })

  it('gives a non-Error rejection one log line and a controlled 500', async () => {
    const { res, captured } = makeRes()
    const next = jest.fn()
    await handler('a thrown string', req, res, next)

    expect(captured.status).toBe(500)
    expect(captured.body).toEqual({ message: 'Internal Server Error' })
    expect(logged).toHaveLength(1)
    expect(logged[0].level).toBe('error')
    expect(logged[0].message).toContain('non-Error rejection')
    // Previously this path called next() and produced no response at all.
    expect(next).not.toHaveBeenCalled()
  })

  it('handles a plain-object rejection the same way', async () => {
    const { res, captured } = makeRes()
    await handler({ reason: 'nope' }, req, res, jest.fn())

    expect(captured.status).toBe(500)
    expect(logged).toHaveLength(1)
  })
})
