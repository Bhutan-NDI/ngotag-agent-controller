import type { ILogObject } from 'tslog'

import { LogLevel, BaseLogger } from '@credo-ts/core'
import { appendFile } from 'fs'
import { Logger } from 'tslog'

import { otelLogger } from '../tracer'

// Opt-in: unset means no file sink. ECS ships stdout only, so the file is never collected there.
const logFilePath = process.env.LOG_FILE_PATH

function logToTransport(logObject: ILogObject) {
  // Async and best-effort: a blocking or throwing write must never stall or kill the agent.
  appendFile(logFilePath as string, `${JSON.stringify(logObject)}\n`, () => undefined)
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

    this.logger = new Logger({
      name,
      // JSON in deployed envs so CloudWatch Logs Insights can query fields; pretty locally.
      type: 'json' === process.env.LOG_FORMAT ? 'json' : 'pretty',
      minLevel: this.logLevel == LogLevel.off ? undefined : this.tsLogLevelMap[this.logLevel],
      ignoreStackLevels: 5,
      attachedTransports: logFilePath
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
              minLevel: 'silly',
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

    if (data) {
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

    let errorDetails
    if (data?.error) {
      const error = data.error
      if (typeof error === 'string') {
        errorDetails = error
      } else if (error instanceof Error) {
        errorDetails = {
          name: error.name,
          message: error.message,
          stack: error.stack,
        }
      } else {
        try {
          errorDetails = JSON.parse(JSON.stringify(error))
        } catch {
          errorDetails = String(error)
        }
      }
    }
    otelLogger.emit({
      body: logMessage,
      severityText: LogLevel[level].toUpperCase(),
      attributes: {
        ...(data || {}),
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
