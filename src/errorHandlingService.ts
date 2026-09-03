import { AnonCredsError, AnonCredsRsError, AnonCredsStoreRecordError } from '@credo-ts/anoncreds'
import { CredoError, RecordNotFoundError, RecordDuplicateError, ClassValidationError } from '@credo-ts/core'
import { MessageSendingError } from '@credo-ts/didcomm'
import { IndyVdrError } from '@hyperledger/indy-vdr-nodejs'

import {
  BaseError,
  RecordDuplicateError as CustomRecordDuplicateError,
  NotFoundError,
  InternalServerError,
} from './errors/errors'
import convertError from './utils/errorConverter'

class ErrorHandlingService {
  public static handle(error: unknown): never {
    try {
      this.convert(error)
    } catch (converted) {
      // Keep the original: BaseError re-roots its own stack at the conversion site, so this is
      // the only surviving reference to where the failure actually came from. server.ts logs it.
      //
      // Only an Error is preserved. A non-Error rejection has no stack worth keeping and the
      // transport cannot sanitise its contents, so carrying it forward would put an arbitrary
      // value into the log record.
      if (converted instanceof BaseError && undefined === converted.cause && error instanceof Error) {
        converted.cause = error
      }
      throw converted
    }
  }

  private static convert(error: unknown): never {
    if (error instanceof RecordDuplicateError) {
      throw this.handleRecordDuplicateError(error)
    } else if (error instanceof ClassValidationError) {
      throw this.handleClassValidationError(error)
    } else if (error instanceof MessageSendingError) {
      throw this.handleMessageSendingError(error)
    } else if (error instanceof RecordNotFoundError) {
      throw this.handleRecordNotFoundError(error)
    } else if (error instanceof AnonCredsRsError) {
      throw this.handleAnonCredsRsError(error)
    } else if (error instanceof AnonCredsStoreRecordError) {
      throw this.handleAnonCredsStoreRecordError(error)
    } else if (error instanceof IndyVdrError) {
      throw this.handleIndyVdrError(error)
    } else if (error instanceof AnonCredsError) {
      throw this.handleAnonCredsError(error)
    } else if (error instanceof CredoError) {
      throw this.handleCredoError(error)
    } else if (error instanceof Error) {
      throw convertError(error.constructor.name, error.message)
    } else {
      // The value is deliberately not interpolated: a rejected string can be an upstream
      // response body carrying a token or a seed, and this message reaches the log line, the
      // OpenTelemetry body, the file sink and the HTTP response. Only its type is safe to keep.
      throw new InternalServerError(`An unknown error occurred (${typeof error})`)
    }
  }
  private static handleIndyVdrError(error: IndyVdrError) {
    throw new InternalServerError(`IndyVdrError: ${error.message}`)
  }

  private static handleAnonCredsError(error: AnonCredsError): BaseError {
    throw new InternalServerError(`AnonCredsError: ${error.message}`)
  }

  private static handleAnonCredsRsError(error: AnonCredsRsError): BaseError {
    throw new InternalServerError(`AnonCredsRsError: ${error.message}`)
  }

  private static handleAnonCredsStoreRecordError(error: AnonCredsStoreRecordError): BaseError {
    throw new InternalServerError(`AnonCredsStoreRecordError: ${error.message}`)
  }

  private static handleCredoError(error: CredoError): BaseError {
    throw new InternalServerError(`CredoError: ${error.message}`)
  }

  private static handleRecordNotFoundError(error: RecordNotFoundError): BaseError {
    throw new NotFoundError(error.message)
  }

  private static handleRecordDuplicateError(error: RecordDuplicateError): BaseError {
    throw new CustomRecordDuplicateError(error.message)
  }

  private static handleClassValidationError(error: ClassValidationError): BaseError {
    throw new InternalServerError(`ClassValidationError: ${error.message}`)
  }

  private static handleMessageSendingError(error: MessageSendingError): BaseError {
    throw new InternalServerError(`MessageSendingError: ${error.message}`)
  }
}

export default ErrorHandlingService
