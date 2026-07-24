import type { AgentContext, DocumentLoader } from '@credo-ts/core'
import type { DocumentLoaderResult } from '@credo-ts/core/build/modules/vc/data-integrity/jsonldUtil.mjs'

import { CacheModuleConfig } from '@credo-ts/core'
import { defaultDocumentLoader } from '@credo-ts/core/build/modules/vc/data-integrity/libraries/documentLoader.mjs'

import { isCustomDocumentLoaderEnabled } from './config'
import { CustomDocumentLoader } from './customDocumentLoader'

const CACHE_KEY_PREFIX = 'jsonld:document:'
const DEFAULT_TTL_SECONDS = 60 * 60 * 24 * 7 // 7 days

/**
 * Cache TTL for JSON-LD documents, in seconds. Configurable via
 * DOCUMENT_LOADER_CACHE_TTL_SECONDS; defaults to 7 days.
 */
const getCacheTtlSeconds = (): number => {
  const parsed = Number(process.env.DOCUMENT_LOADER_CACHE_TTL_SECONDS)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TTL_SECONDS
}

/**
 * URLs whose documents are cached — the schema host serving external @context
 * files. Configurable via DOCUMENT_LOADER_CACHE_URL_PREFIX, falling back to
 * SERVER_URL. When neither is set, caching is disabled (the loader passes
 * straight through to the underlying loader).
 */
const getCacheableUrlPrefix = (): string | undefined =>
  process.env.DOCUMENT_LOADER_CACHE_URL_PREFIX || process.env.SERVER_URL || undefined

/**
 * Document loader that adds a cache layer over the active loader — the custom
 * domain-rewriting loader when ENABLE_CUSTOM_DOCUMENT_LOADER is set, otherwise
 * Credo's default. External JSON-LD @context / schema documents served from the
 * schema host are cached in the configured CacheModule cache (Redis when
 * configured, in-memory otherwise) so W3C verification does not hit the live
 * host on every request. Cache errors degrade gracefully to a direct fetch.
 */
export const CachedDocumentLoader = (agentContext: AgentContext): DocumentLoader => {
  const logger = agentContext.config.logger
  const innerLoader = isCustomDocumentLoaderEnabled()
    ? CustomDocumentLoader(agentContext)
    : defaultDocumentLoader(agentContext)
  const cacheableUrlPrefix = getCacheableUrlPrefix()
  const ttlSeconds = getCacheTtlSeconds()

  return async (url: string): Promise<DocumentLoaderResult> => {
    // Only cache external documents from the schema host; bundled contexts and
    // DIDs go straight to the underlying loader.
    if (!cacheableUrlPrefix || !url.startsWith(cacheableUrlPrefix)) {
      return innerLoader(url)
    }

    const cacheKey = `${CACHE_KEY_PREFIX}${url}`

    try {
      const cache = agentContext.dependencyManager.resolve(CacheModuleConfig).cache
      const cached = await cache.get<DocumentLoaderResult>(agentContext, cacheKey)
      if (cached) {
        logger.debug(`Document loader cache hit: ${url}`)
        return cached
      }
    } catch (error) {
      logger.warn(`Document loader cache unavailable for ${url}: ${error}`)
    }

    const document = await innerLoader(url)

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
        ttlSeconds,
      )
      logger.debug(`Document loader cached (${ttlSeconds}s): ${url}`)
    } catch (error) {
      logger.warn(`Failed to cache document for ${url}: ${error}`)
    }

    return document
  }
}
