import type { ILogObject } from 'tslog'

import { LogLevel, BaseLogger } from '@credo-ts/core'
import { promises as fsPromises } from 'fs'
import { Logger } from 'tslog'

import { otelLogger } from '../tracer'

// Opt-in: unset means no file sink. ECS ships stdout only, so the file is never collected there.
const logFilePath = process.env.LOG_FILE_PATH
// Bounds the sink so an opt-in debug flag can't fill the disk: one rotation, `${path}.1`, kept as backup.
const maxLogFileBytes = Number(process.env.LOG_FILE_MAX_BYTES) || 10 * 1024 * 1024

// Bound on the rendering of a thrown non-Error, so a large object cannot flood a log line.
const MAX_NON_ERROR_LENGTH = 500

// Serializes writes so rotation (stat -> rename -> append) can't race across overlapping log calls.
let writeQueue: Promise<void> = Promise.resolve()

async function writeLogLine(path: string, line: string) {
  try {
    const stats = await fsPromises.stat(path)
    if (stats.size >= maxLogFileBytes) {
      await fsPromises.rename(path, `${path}.1`)
    }
  } catch {
    // No existing file to rotate yet — fall through to the initial append.
  }
  await fsPromises.appendFile(path, line)
}

function logToTransport(logObject: ILogObject) {
  const line = `${JSON.stringify(logObject)}\n`
  // Chained via .catch (not a separate call) so a failed write can't leave writeQueue permanently
  // rejected — that would silently skip every write queued after it.
  writeQueue = writeQueue
    .then(() => writeLogLine(logFilePath as string, line))
    .catch((error) => {
      process.stderr.write(`[logger] failed to write to LOG_FILE_PATH: ${String(error)}\n`)
    })
}

/**
 * HTTP and SSI libraries hang request state off their errors as *enumerable own properties* --
 * an Axios error keeps `config` (URL, headers, request body) and `response`. tslog copies every
 * enumerable own property into its `details` field and into `errorString`, so handing such an
 * error straight to the transport writes bearer tokens, client secrets and wallet seeds to
 * stdout and CloudWatch.
 *
 * Rebuild it as a bare Error carrying only name, message and stack. A fresh Error has no
 * enumerable own properties, so `details` stays empty; the original stack text survives in
 * tslog's `errorString`. Structured stack frames and the codeFrame are lost -- V8's internal
 * frame state cannot be transplanted -- which is the deliberate cost of not leaking secrets.
 */
function toSafeError(value: unknown): Error | undefined {
  if (undefined === value || null === value) {
    return undefined
  }
  if (!(value instanceof Error)) {
    // A non-Error rejection: keep a bounded rendering, never the object itself.
    return new Error(String(value).slice(0, MAX_NON_ERROR_LENGTH))
  }
  const safe = new Error(value.message)
  // Non-enumerable, or it would land back in tslog's `details`.
  Object.defineProperty(safe, 'name', { value: value.name, enumerable: false, writable: true, configurable: true })
  safe.stack = value.stack
  return safe
}

export class TsLogger extends BaseLogger {
  private logger: Logger

  // Map our log levels to tslog levels
  private tsLogLevelMap = {
    [LogLevel.test]: 'silly',
    [LogLevel.trace]: 'trace',
    [LogLevel.debug]: 'debug',
    [LogLevel.info]: 'info',
    [LogLevel.warn]: 'warn',
    [LogLevel.error]: 'error',
    [LogLevel.fatal]: 'fatal',
  } as const

  public constructor(logLevel: LogLevel, name: string = 'credo-controller-service' as string) {
    super(logLevel)

    const minLevel = this.logLevel == LogLevel.off ? undefined : this.tsLogLevelMap[this.logLevel]

    this.logger = new Logger({
      name,
      // JSON in deployed envs so CloudWatch Logs Insights can query fields; pretty locally.
      type: 'json' === process.env.LOG_FORMAT ? 'json' : 'pretty',
      minLevel,
      ignoreStackLevels: 5,
      // minLevel is undefined only when LogLevel.off, in which case no transport should fire anyway.
      attachedTransports:
        logFilePath && minLevel
          ? [
              {
                transportLogger: {
                  silly: logToTransport,
                  debug: logToTransport,
                  trace: logToTransport,
                  info: logToTransport,
                  warn: logToTransport,
                  error: logToTransport,
                  fatal: logToTransport,
                },
                // tslog filters attached transports independently of the logger's own minLevel,
                // so this must be set explicitly to match — otherwise the file sink gets everything.
                minLevel,
              },
            ]
          : [],
    })
  }

  private log(
    level: Exclude<LogLevel, LogLevel.off>,
    message: string | { message: string },
    data?: Record<string, any>,
  ): void {
    const tsLogLevel = this.tsLogLevelMap[level]

    // Sanitised once, here, so no call site can leak by forgetting to. tslog inspects a plain
    // object into a single string, so the error is passed as its own argument to keep name,
    // message and errorString as named JSON fields.
    const safeError = toSafeError(data?.error)
    if (safeError) {
      const { error: _rawError, ...rest } = data as Record<string, any>
      if (0 < Object.keys(rest).length) {
        this.logger[tsLogLevel](message, safeError, rest)
      } else {
        this.logger[tsLogLevel](message, safeError)
      }
    } else if (data) {
      this.logger[tsLogLevel](message, data)
    } else {
      this.logger[tsLogLevel](message)
    }
    let logMessage = ''
    if (typeof message === 'string') {
      logMessage = message
    } else if (typeof message === 'object' && 'message' in message) {
      logMessage = message.message
    }

    // Same sanitised error as the console transport -- previously this branch JSON-stringified a
    // non-Error value wholesale, which had the same disclosure problem.
    const errorDetails = safeError
      ? { name: safeError.name, message: safeError.message, stack: safeError.stack }
      : undefined
    // `error` is dropped from the spread rather than relying on the later key to override it.
    const { error: _omitRawError, ...safeAttributes } = (data ?? {}) as Record<string, any>
    otelLogger.emit({
      body: logMessage,
      severityText: LogLevel[level].toUpperCase(),
      attributes: {
        ...safeAttributes,
        ...(errorDetails ? { error: errorDetails } : {}),
      },
    })
  }

  public test(message: string, data?: Record<string, any>): void {
    this.log(LogLevel.test, message, data)
  }

  public trace(message: string, data?: Record<string, any>): void {
    this.log(LogLevel.trace, message, data)
  }

  public debug(message: string, data?: Record<string, any>): void {
    this.log(LogLevel.debug, message, data)
  }

  public info(message: string, data?: Record<string, any>): void {
    this.log(LogLevel.info, message, data)
  }

  public warn(message: string, data?: Record<string, any>): void {
    this.log(LogLevel.warn, message, data)
  }

  public error(message: string, data?: Record<string, any>): void {
    this.log(LogLevel.error, message, data)
  }

  public fatal(message: string, data?: Record<string, any>): void {
    this.log(LogLevel.fatal, message, data)
  }
}
