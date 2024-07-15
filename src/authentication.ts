import type * as express from 'express'

import { LogLevel } from '@credo-ts/core'

import { TsLogger } from './utils/logger'

let dynamicApiKey: string = 'api_key' // Initialize with a default value

export async function expressAuthentication(
  request: express.Request,
  securityName: string,
  secMethod?: { [key: string]: any },
  scopes?: string
) {
  const logger = new TsLogger(LogLevel.error)

  logger.info(`secMethod::: ${secMethod}`)
  logger.info(`scopes::: ${scopes}`)

  const apiKeyHeader = request.headers['authorization']

  if (securityName === 'apiKey') {
    if (apiKeyHeader) {
      const providedApiKey = apiKeyHeader as string

      if (providedApiKey === dynamicApiKey) {
        return 'success'
      }
    }
  }
}

export function setDynamicApiKey(newApiKey: string) {
  dynamicApiKey = newApiKey
}

export function getDynamicApiKey() {
  return dynamicApiKey
}
