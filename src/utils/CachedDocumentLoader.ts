import type { TsLogger } from './logger'
import type { AgentContext } from '@credo-ts/core'
import type { DocumentLoaderWithContext } from '@credo-ts/core/build/modules/vc/data-integrity/libraries/documentLoader'
import type { DocumentLoaderResult } from '@credo-ts/core/build/modules/vc/data-integrity/libraries/jsonld'

import { CacheModuleConfig } from '@credo-ts/core'
import { defaultDocumentLoader } from '@credo-ts/core/build/modules/vc/data-integrity/libraries/documentLoader'
import { LogLevel } from '@credo-ts/core'

import { emitStructured, makeSpanId, monoNow, durationMs } from './StructuredLogger'
import { requestContext } from '../instrumentation/requestContext'

const DOCUMENT_LOADER_CACHE_PREFIX = 'jsonld:document:'
const DOCUMENT_CACHE_TTL_SECONDS = 60 * 60 * 24 * 7 // 7 days
const SCHEMA_SERVER_URL = process.env.SERVER_URL ?? 'https://dev-schema.ngotag.com'

const NGOTAG_SCHEMA_PREFIX = `${SCHEMA_SERVER_URL}/schemas/`

export const buildCachedDocumentLoader = (logger: TsLogger): DocumentLoaderWithContext => {
  // Return a factory function that Credo calls with agentContext
  return (agentContext: AgentContext) => {
    // Get the default Credo loader for this context
    // handles: bundled DEFAULT_CONTEXTS, DID resolution, basic HTTP
    const defaultLoader = defaultDocumentLoader(agentContext)

    return async (url: string): Promise<DocumentLoaderResult> => {
      // Let Credo handle bundled contexts and DIDs natively
      const shouldCache = url.startsWith(NGOTAG_SCHEMA_PREFIX)
      if (!shouldCache) {
        return defaultLoader(url)
      }

      // Check cache for external URLs
      const cacheKey = `${DOCUMENT_LOADER_CACHE_PREFIX}${url}`
      const _fetchSpanId = makeSpanId()
      const _fetchStart = monoNow()

      try {
        const cache = agentContext.dependencyManager.resolve(CacheModuleConfig).cache

        const cached = await cache.get<DocumentLoaderResult>(agentContext, cacheKey)

        if (cached) {
          logger.debug(`Document loader cache hit for: ${url}`)
          emitStructured(LogLevel.trace, {
            hop: 'controller.jsonld.context.fetch.end',
            span_id: _fetchSpanId,
            jwe_fp: requestContext.getStore()?.jweFp ?? '',
            tenant_id: '',
            duration_ms: durationMs(_fetchStart),
            cache_hit: true,
            url,
          })
          return cached
        }
      } catch (err) {
        // Cache unavailable — fall through to HTTP fetch
        logger.warn(`Document loader cache unavailable for ${url}: ${err}`)
      }

      // Cache miss — fetch via default loader
      logger.debug(`Document loader cache miss — fetching: ${url}`)

      emitStructured(LogLevel.trace, {
        hop: 'controller.jsonld.context.fetch.start',
        span_id: _fetchSpanId,
        jwe_fp: requestContext.getStore()?.jweFp ?? '',
        tenant_id: '',
        cache_hit: false,
        url,
      })

      let document: DocumentLoaderResult

      try {
        document = await defaultLoader(url)
        emitStructured(LogLevel.trace, {
          hop: 'controller.jsonld.context.fetch.end',
          span_id: _fetchSpanId,
          jwe_fp: requestContext.getStore()?.jweFp ?? '',
          tenant_id: '',
          duration_ms: durationMs(_fetchStart),
          cache_hit: false,
          url,
        })
      } catch (err) {
        emitStructured(LogLevel.trace, {
          hop: 'controller.jsonld.context.fetch.end',
          span_id: _fetchSpanId,
          jwe_fp: requestContext.getStore()?.jweFp ?? '',
          tenant_id: '',
          duration_ms: durationMs(_fetchStart),
          cache_hit: false,
          url,
          notes: `fetch_error: ${String(err)}`,
        })
        logger.error(`Document loader failed to fetch ${url}: ${err}`)
        throw err
      }

      // Cache the fetched document
      try {
        const cache = agentContext.dependencyManager.resolve(CacheModuleConfig).cache

        await cache.set(
          agentContext,
          cacheKey,
          {
            contextUrl: document.contextUrl,
            documentUrl: document.documentUrl,
            document: document.document,
          },
          DOCUMENT_CACHE_TTL_SECONDS
        )
        logger.debug(`Document loader cached successfully: ${url}`)
      } catch (err) {
        logger.warn(`Failed to cache document for ${url}: ${err}`)
      }
      return document
    }
  }
}
