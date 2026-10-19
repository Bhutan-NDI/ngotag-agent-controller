import type { RelayRedis } from './RelayStore'
import type { TsLogger } from '../../utils/logger'
import type { RequestHandler } from 'express'

import { Redis } from 'ioredis'

import { RelayDrainer } from './RelayDrainer'
import { createRelayMiddleware } from './RelayMiddleware'
import { RelayService } from './RelayService'
import { RelayStore } from './RelayStore'
import { REDIS_COMMAND_TIMEOUT_MS, REDIS_CONNECT_TIMEOUT_MS, isRelayEnabled } from './relayConfig'
import { forwardEnvelope } from './relayForwarder'

export interface RelayRuntime {
  store: RelayStore
  drainer: RelayDrainer
  service: RelayService
  middleware: RequestHandler
}

let runtime: RelayRuntime | undefined

/** Builds the relay if MIGRATION_RELAY_ENABLED is set and a shared Redis is configured; otherwise there is none. */
export const initRelayRuntime = (logger: TsLogger): RelayRuntime | undefined => {
  if (runtime) return runtime
  if (!isRelayEnabled()) {
    if ('true' === process.env.MIGRATION_RELAY_ENABLED) {
      logger.warn(
        '[Relay] MIGRATION_RELAY_ENABLED is set but REDIS_URL is not: the relay needs the shared Redis, so it stays off',
      )
    }
    return undefined
  }

  const redis = new Redis(process.env.REDIS_URL as string, {
    connectTimeout: REDIS_CONNECT_TIMEOUT_MS,
    commandTimeout: REDIS_COMMAND_TIMEOUT_MS,
    family: 4,
    enableOfflineQueue: false,
    maxRetriesPerRequest: null,
    retryStrategy: (times: number): number => Math.min(200 * 2 ** (times - 1), 10_000),
  })
  redis.on('error', (error) => logger.error(`[Relay] Redis error: ${error}`))

  const store = new RelayStore(redis as unknown as RelayRedis)
  const drainer = new RelayDrainer(store, forwardEnvelope, logger)
  const service = new RelayService(store, drainer, logger)
  runtime = {
    store,
    drainer,
    service,
    middleware: createRelayMiddleware({ store, forward: forwardEnvelope, drainer, logger }),
  }
  logger.info('[Relay] migration relay enabled')
  return runtime
}

export const getRelayRuntime = (): RelayRuntime | undefined => runtime

export const shutdownRelayRuntime = async (): Promise<void> => {
  if (!runtime) return
  runtime.drainer.stop()
  await runtime.store.disconnect()
  runtime = undefined
}
