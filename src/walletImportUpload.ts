import type { Agent } from '@credo-ts/core'
import type { Express, NextFunction, Request, Response } from 'express'

import { LogLevel } from '@credo-ts/core'

import { expressAuthentication } from './authentication'
import { mapImportError } from './controllers/agent/walletImportErrors'
import { SCOPES } from './enums'
import { BadRequestError } from './errors/errors'
import { getWalletPortabilityService } from './services/wallet-portability/WalletPortabilityService'
import { TsLogger } from './utils/logger'

const CHECKSUM_PATTERN = /^[a-f0-9]{64}$/i
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/

/**
 * Push variant of POST /agent/wallet/import for a dedicated agent that cannot reach S3: the sealed artifact is the
 * raw request body, so it is streamed to disk rather than going through the 5 MB JSON body parser. A plain Express
 * route because tsoa has no streaming request body; it applies the same dedicated-agent authentication.
 */
export const mountWalletImportUpload = (app: Express): void => {
  app.post('/agent/wallet/import/upload', async (req: Request, res: Response, next: NextFunction) => {
    try {
      await expressAuthentication(req, 'jwt', [SCOPES.DEDICATED_AGENT])
    } catch (error) {
      next(error)
      return
    }

    try {
      if (!req.is('application/octet-stream')) {
        throw new BadRequestError('Content-Type must be application/octet-stream.')
      }
      const sessionId = req.get('x-session-id')
      const checksum = req.get('x-checksum')
      const sealedStoreKey = req.get('x-sealed-store-key')
      const storageVersion = req.get('x-storage-version')
      if (!sessionId || !checksum || !sealedStoreKey || !storageVersion) {
        throw new BadRequestError(
          'x-session-id, x-checksum, x-sealed-store-key and x-storage-version headers are all required.',
        )
      }
      if (!CHECKSUM_PATTERN.test(checksum)) {
        throw new BadRequestError('x-checksum must be a 64-character hexadecimal SHA-256 digest.')
      }
      if (!BASE64_PATTERN.test(sealedStoreKey)) {
        throw new BadRequestError('x-sealed-store-key must be base64.')
      }

      const result = await getWalletPortabilityService(
        new TsLogger(LogLevel.info, 'wallet-portability'),
      ).importRootWalletFromUpload(req.agent as unknown as Agent, req, {
        sessionId,
        checksum: checksum.toLowerCase(),
        sealedStoreKey,
        storageVersion,
        dryRun: 'true' === req.get('x-dry-run'),
      })
      res.status(200).json(result)
    } catch (error) {
      next(mapImportError(error))
    }
  })
}
