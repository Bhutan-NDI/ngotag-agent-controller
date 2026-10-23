import type { RelayDrainer } from './RelayDrainer'
import type { RelayEntry, RelayStore } from './RelayStore'
import type { ForwardFn } from './relayForwarder'
import type { TsLogger } from '../../utils/logger'
import type { RequestHandler } from 'express'

import { extractRecipientFingerprints } from './relayEnvelope'

export interface RelayMiddlewareDeps {
  store: RelayStore
  forward: ForwardFn
  drainer: RelayDrainer
  logger: TsLogger
}

/**
 * Mounted on the HTTP inbound transport's app, ahead of Credo's handler (it sees `req.body` as the raw envelope
 * because the transport's text parser is already in front of it). A message for a tenant with a relay entry is held or
 * forwarded and never reaches Credo, which has no profile for a migrated tenant. Everything else passes straight
 * through, and a failure of the lookup itself fails open so a Redis problem cannot take the whole shared agent down.
 */
export const createRelayMiddleware = ({ store, forward, drainer, logger }: RelayMiddlewareDeps): RequestHandler => {
  return async (req, res, next) => {
    if ('POST' !== req.method) return next()
    const fingerprints = extractRecipientFingerprints(req.body)
    if (0 === fingerprints.length) return next()

    let tenantId: string | undefined
    let entry: RelayEntry | undefined
    try {
      tenantId = await store.findTenantIdByFingerprints(fingerprints)
      if (!tenantId) return next()
      entry = await store.getEntry(tenantId)
      if (!entry) return next()
    } catch (error) {
      logger.error(`[RelayMiddleware] relay lookup failed, passing the message through: ${error}`)
      return next()
    }

    const contentType = req.headers['content-type'] ?? 'application/didcomm-envelope-enc'
    const body = req.body as string
    const countMessage = (): void => {
      store.recordMessage(entry!.tenantId, fingerprints[0]).catch(() => undefined)
    }

    try {
      if ('HOLD' === entry.mode) {
        const held = await store.holdPush(entry.tenantId, {
          receivedAt: new Date().toISOString(),
          contentType,
          body,
        })
        if (!held) {
          logger.error(`[RelayMiddleware] hold buffer for tenant '${entry.tenantId}' is full; message refused`)
          res.status(503).set('Retry-After', '30').end()
          return
        }
        countMessage()
        res.status(202).end()
        return
      }

      const result = await forward(entry.target as string, { contentType, body })
      if ('response' === result.kind) {
        countMessage()
        if (result.contentType) res.set('content-type', result.contentType)
        res.status(result.status).send(result.body)
        return
      }
      if ('neverLeft' === result.kind) {
        // The target is down: keep the message and deliver it when it is back.
        if (await store.holdPush(entry.tenantId, { receivedAt: new Date().toISOString(), contentType, body })) {
          drainer.ensureDraining(entry.tenantId)
          countMessage()
          res.status(202).end()
          return
        }
        res.status(503).set('Retry-After', '30').end()
        return
      }
      logger.warn(
        `[RelayMiddleware] forward for tenant '${entry.tenantId}' may or may not have been delivered (${result.reason}); not retried`,
      )
      res.status(504).end()
    } catch (error) {
      logger.error(`[RelayMiddleware] relaying a message for tenant '${entry.tenantId}' failed: ${error}`)
      if (!res.headersSent) res.status(500).end()
    }
  }
}
