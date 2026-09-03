import type { ILogObject } from 'tslog'

import { LogLevel, BaseLogger } from '@credo-ts/core'
import { promises as fsPromises } from 'fs'
import { Logger } from 'tslog'

import { otelLogger } from '../tracer'

// Opt-in: unset means no file sink. ECS ships stdout only, so the file is never collected there.
const logFilePath = process.env.LOG_FILE_PATH
// Bounds the sink so an opt-in debug flag can't fill the disk: one rotation, `${path}.1`, kept as backup.
const maxLogFileBytes = Number(process.env.LOG_FILE_MAX_BYTES) || 10 * 1024 * 1024

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
 * enumerable own property into its `details` field and into `errorString`, and the OpenTelemetry
 * attribute map takes them too, so handing such an error to a transport writes bearer tokens,
 * client secrets and wallet seeds to stdout and CloudWatch.
 *
 * The guarantee this file makes: **no Error instance is ever serialised as-is.** Every Error in
 * the payload is replaced by name/message/stack and nothing else. That has to cover more than one
 * key, because callers pass errors in several shapes -- `{ error }`, `{ cause }` (the DIDComm
 * event handlers) and the Error itself as the whole data argument (authentication.ts).
 */
const MAX_SANITISE_DEPTH = 4

type SafeErrorShape = { name: string; message: string; stack?: string }

function toSafeErrorShape(value: Error): SafeErrorShape {
  return { name: value.name, message: value.message, stack: value.stack }
}

/**
 * A bare Error carrying only the three safe fields. A fresh Error has no enumerable own
 * properties, so tslog's `details` stays empty; the original stack text survives in
 * `errorString`. Structured frames and the codeFrame are lost with it -- V8's internal frame
 * state cannot be transplanted -- which is the deliberate cost of not leaking secrets.
 */
function toSafeError(value: Error): Error {
  const safe = new Error(value.message)
  // Non-enumerable, or it would land back in tslog's `details`.
  Object.defineProperty(safe, 'name', { value: value.name, enumerable: false, writable: true, configurable: true })
  safe.stack = value.stack
  return safe
}

/** Depth- and cycle-bounded, so a nested or self-referential payload cannot leak or hang. */
function sanitiseValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (value instanceof Error) {
    return toSafeErrorShape(value)
  }
  if (null === value || 'object' !== typeof value) {
    return value
  }
  if (MAX_SANITISE_DEPTH <= depth || seen.has(value)) {
    return '[omitted]'
  }
  seen.add(value)
  if (Array.isArray(value)) {
    return value.map((entry) => sanitiseValue(entry, depth + 1, seen))
  }
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(value)) {
    out[key] = sanitiseValue((value as Record<string, unknown>)[key], depth + 1, seen)
  }
  return out
}

/**
 * Splits a log payload into the one Error the transport should render as named fields, and the
 * remaining data with every Error inside it replaced. Wrapped in try/catch so a hostile getter
 * on a caller's object cannot take logging down with it.
 */
function sanitiseLogPayload(data?: Record<string, any>): { primaryError?: Error; rest?: Record<string, unknown> } {
  if (undefined === data || null === data) {
    return {}
  }
  try {
    // authentication.ts:82 and :157 pass the Error itself, cast to Record<string, any>.
    if (data instanceof Error) {
      return { primaryError: toSafeError(data) }
    }
    let primaryError: Error | undefined
    const rest: Record<string, unknown> = {}
    const seen = new WeakSet<object>()
    for (const key of Object.keys(data)) {
      const value = data[key]
      // The first Error at the top level travels as tslog's own argument, whatever key it sits
      // under, so `{ error }` and `{ cause }` behave identically.
      if (value instanceof Error && undefined === primaryError) {
        primaryError = toSafeError(value)
        continue
      }
      rest[key] = sanitiseValue(value, 0, seen)
    }
    return { primaryError, rest: 0 < Object.keys(rest).length ? rest : undefined }
  } catch {
    // Never let sanitisation failure silence the log line itself.
    return { rest: { sanitisation: 'failed' } }
  }
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
    // object into a single string, so the error travels as its own argument to keep name,
    // message and errorString as named JSON fields.
    const { primaryError, rest } = sanitiseLogPayload(data)
    if (primaryError && rest) {
      this.logger[tsLogLevel](message, primaryError, rest)
    } else if (primaryError) {
      this.logger[tsLogLevel](message, primaryError)
    } else if (rest) {
      this.logger[tsLogLevel](message, rest)
    } else {
      this.logger[tsLogLevel](message)
    }
    let logMessage = ''
    if (typeof message === 'string') {
      logMessage = message
    } else if (typeof message === 'object' && 'message' in message) {
      logMessage = message.message
    }

    // The same sanitised values the console transport received -- OpenTelemetry is a second
    // egress for the identical object, so it must not be given the raw one.
    const errorDetails = primaryError ? toSafeErrorShape(primaryError) : undefined
    const safeAttributes = rest ?? {}
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
