import type { ApiError } from './errors'
import type { Logger } from '@credo-ts/core'
import type { Response as ExResponse, Request as ExRequest, NextFunction, ErrorRequestHandler } from 'express'

import { ValidateError } from 'tsoa'

import { ErrorMessages } from './enums'
import { BaseError } from './errors/errors'

/**
 * The single place a failed request is turned into a response, and the only place the resolved
 * status is known -- which is why it is also the only place the error is logged. Kept out of
 * server.ts so it can be tested without standing up an agent.
 */
export const createErrorHandler = (logger: Logger): ErrorRequestHandler =>
  (async (err: unknown, req: ExRequest, res: ExResponse, _next: NextFunction): Promise<ExResponse | void> => {
    if (err instanceof ValidateError) {
      logger.warn(`${req.method} ${req.path} -> 422: validation failed`, { fields: err.fields })
      return res.status(422).json({
        message: 'Validation Failed',
        details: err?.fields,
      })
    } else if (err instanceof BaseError) {
      // Level follows the resolved status: a 404 is a normal outcome, not an error. `cause` is
      // the pre-conversion error, whose stack still points at the real origin.
      const level = 500 <= err.statusCode ? 'error' : 'warn'
      logger[level](`${req.method} ${req.path} -> ${err.statusCode}: ${err.message}`, {
        error: err.cause ?? err,
      })
      return res.status(err.statusCode).json({
        message: err.message,
      })
    } else if (err instanceof Error) {
      // Extend the Error type with custom properties
      const error = err as Error & { statusCode?: number; status?: number; stack?: string }
      if (error.status === 401) {
        logger.warn(`${req.method} ${req.path} -> 401: ${error.message}`, { error })
        return res.status(401).json({
          message: `Unauthorized`,
          details: err.message !== ErrorMessages.Unauthorized ? err.message : undefined,
        } satisfies ApiError)
      }
      const statusCode = error.statusCode || error.status || 500
      const level = 500 <= statusCode ? 'error' : 'warn'
      logger[level](`${req.method} ${req.path} -> ${statusCode}: ${error.message}`, { error })
      return res.status(statusCode).json({
        message: error.message || 'Internal Server Error',
      })
    }
    // A rejection that is not an Error at all -- a thrown string, or next(someObject). This used
    // to fall through to a bare next(), which logged nothing and sent no response.
    //
    // Only the *type* is logged, never the value: a rejected string can be an upstream response
    // body carrying a token or seed, and nothing here can tell that from a safe message. The
    // method and path identify the site well enough to find it.
    logger.error(`${req.method} ${req.path} -> 500: non-Error rejection (${typeof err})`)
    return res.status(500).json({
      message: 'Internal Server Error',
    })
  }) as ErrorRequestHandler
