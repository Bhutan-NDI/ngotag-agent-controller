import ErrorHandlingService from '../../errorHandlingService'
import { BadRequestError, ConflictError, NotFoundError } from '../../errors/errors'
import {
  ArtifactChecksumMismatchError,
  ImportSessionNotFoundError,
  StorageVersionMismatchError,
  TargetNotPristineError,
  WalletPortabilityJobConflictError,
} from '../../services/wallet-portability/WalletPortabilityTypes'

export const mapImportError = (error: unknown): unknown => {
  if (
    error instanceof TargetNotPristineError ||
    error instanceof StorageVersionMismatchError ||
    error instanceof WalletPortabilityJobConflictError
  ) {
    return new ConflictError(error.message)
  }
  if (error instanceof ImportSessionNotFoundError) {
    return new NotFoundError(error.message)
  }
  if (error instanceof ArtifactChecksumMismatchError) {
    return new BadRequestError(error.message)
  }
  return ErrorHandlingService.handle(error)
}
