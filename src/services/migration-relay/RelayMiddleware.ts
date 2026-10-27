import type { RelayDrainer } from './RelayDrainer'
import type { RelayMirror } from './RelayMirror'
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
  mirror?: RelayMirror
}

/**
 * Mounted on the HTTP inbound transport's app, ahead of Credo's handler (it sees `req.body` as the raw envelope
 * because the transport's text parser is already in front of it). A message for a tenant with a relay entry is held or
 * forwarded and never reaches Credo, which has no profile for a migrated tenant. Redis is asked first; when it is down
 * or has lost the entry, this process's mirror of the base wallet's entries decides, so a relayed tenant's message is
 * never handed to the wallet it moved away from. Only a message for a key no relay is known for passes through.
 */
export const createRelayMiddleware = ({
  store,
  forward,
  drainer,
  logger,
  mirror,
}: RelayMiddlewareDeps): RequestHandler => {
  const findEntry = async (fingerprints: string[]): Promise<RelayEntry | undefined> => {
    try {
      const tenantId = await store.findTenantIdByFingerprints(fingerprints)
      const entry = tenantId ? await store.getEntry(tenantId) : undefined
      if (entry) return entry
    } catch (error) {
      logger.error(`[RelayMiddleware] relay lookup in Redis failed, using the mirror: ${error}`)
    }
    const mirrored = mirror?.find(fingerprints)
    if (!mirrored) return undefined
    try {
      if (await store.isRemoved(mirrored.tenantId)) return undefined
    } catch {
      // Redis is down: keep the mirror's entry, which holds the message rather than handing it to a moved wallet.
    }
    return mirrored
  }

  return async (req, res, next) => {
    if ('POST' !== req.method) return next()
    const fingerprints = extractRecipientFingerprints(req.body)
    if (0 === fingerprints.length) return next()

    const entry = await findEntry(fingerprints)
    if (!entry) return next()

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
      if (!res.headersSent) res.status(503).set('Retry-After', '30').end()
    }
  }
}
