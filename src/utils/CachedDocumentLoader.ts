import type { AgentContext, DocumentLoader } from '@credo-ts/core'
import type { DocumentLoaderResult } from '@credo-ts/core/build/modules/vc/data-integrity/jsonldUtil.mjs'

import { CacheModuleConfig, DidsApi } from '@credo-ts/core'
import { defaultDocumentLoader } from '@credo-ts/core/build/modules/vc/data-integrity/libraries/documentLoader.mjs'

import { isCustomDocumentLoaderEnabled } from './config'
import { CustomDocumentLoader } from './customDocumentLoader'
import { SECP256K1_RECOVERY_2020_V2 } from './staticContexts/secp256k1recovery2020v2'

// Depend on the underlying jsonld package directly rather than Credo's own
// `.../libraries/jsonld.mjs` re-export: that subpath is not declared in
// @credo-ts/core's package.json "exports" map, so deep-importing it throws
// ERR_PACKAGE_PATH_NOT_EXPORTED at runtime (Node enforces "exports" regardless
// of require/import). This also avoids needing a type-only patch for a missing
// default-export declaration on Credo's compiled .d.mts.
const jsonld = require('@digitalcredentials/jsonld') as {
  frame(input: object, frame: object, options?: object): Promise<object>
}

const CACHE_KEY_PREFIX = 'jsonld:document:'
const DEFAULT_TTL_SECONDS = 60 * 60 * 24 * 7 // 7 days
const DID_RESOLVE_TIMEOUT_MS = 12_000

// Contexts embedded at build time so did:ethr DID documents (which reference the
// secp256k1recovery-2020 suite) resolve without a network round-trip. Both the
// canonical w3id.org URL and the identity.foundation redirect target are mapped.
const STATIC_CONTEXTS: Record<string, unknown> = {
  'https://w3id.org/security/suites/secp256k1recovery-2020/v2': SECP256K1_RECOVERY_2020_V2,
  'https://identity.foundation/EcdsaSecp256k1RecoverySignature2020/lds-ecdsa-secp256k1-recovery2020-2.0.jsonld':
    SECP256K1_RECOVERY_2020_V2,
}

const withTimeout = <T>(promise: Promise<T>, ms: number, message: string): Promise<T> =>
  Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(message)), ms)
    }),
  ])

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

  const loader = async (url: string): Promise<DocumentLoaderResult> => {
    // Static contexts (e.g. secp256k1recovery-2020/v2, used by did:ethr DID documents)
    // are served from the embedded map with zero network cost, regardless of caching
    // config — this runs unconditionally so it's active in every environment, not just
    // when ENABLE_CUSTOM_DOCUMENT_LOADER is set.
    const staticDoc = STATIC_CONTEXTS[url] ?? STATIC_CONTEXTS[url.split('#')[0]]
    if (staticDoc) {
      return { contextUrl: null, documentUrl: url, document: staticDoc as Record<string, unknown> }
    }

    // did: URLs are resolved here and framed through `loader` so that nested @context
    // loads (e.g. secp256k1recovery-2020/v2 referenced by did:ethr DID documents) route
    // through the static map above rather than an unwrapped live fetch. Bounded by
    // DID_RESOLVE_TIMEOUT_MS so a stalled RPC (did:ethr resolution hits an external
    // RPC) can't wedge the caller's tenant session open indefinitely.
    if (url.startsWith('did:')) {
      const didsApi = agentContext.dependencyManager.resolve(DidsApi)
      const resolution = await withTimeout(
        didsApi.resolve(url),
        DID_RESOLVE_TIMEOUT_MS,
        `DID resolution timed out after ${DID_RESOLVE_TIMEOUT_MS}ms: ${url}`,
      )
      if (resolution.didResolutionMetadata.error || !resolution.didDocument) {
        throw new Error(`Unable to resolve DID: ${url}: ${resolution.didResolutionMetadata.error ?? 'no document'}`)
      }
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore – jsonld typings do not expose documentLoader option
      const framed = await jsonld.frame(
        resolution.didDocument.toJSON(),
        { '@context': resolution.didDocument.context, '@embed': '@never', id: url },
        { documentLoader: loader },
      )
      return { contextUrl: null, documentUrl: url, document: framed as Record<string, unknown> }
    }

    // Only cache external documents from the schema host; static/did: documents
    // (handled above) and everything else go straight to the underlying loader.
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

  return loader
}
