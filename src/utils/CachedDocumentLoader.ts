import type { TsLogger } from './logger'
import type { AgentContext } from '@credo-ts/core'
import type { DocumentLoaderWithContext } from '@credo-ts/core/build/modules/vc/data-integrity/libraries/documentLoader'
import type { DocumentLoaderResult } from '@credo-ts/core/build/modules/vc/data-integrity/libraries/jsonld'

import { CacheModuleConfig, LogLevel } from '@credo-ts/core'
import { DidResolverService } from '@credo-ts/core/build/modules/dids'
import { DEFAULT_CONTEXTS } from '@credo-ts/core/build/modules/vc/data-integrity/libraries/contexts'
import { defaultDocumentLoader } from '@credo-ts/core/build/modules/vc/data-integrity/libraries/documentLoader'

import { requestContext } from '../instrumentation/requestContext'

import { emitStructured, makeSpanId, monoNow, durationMs } from './StructuredLogger'
import { SECP256K1_RECOVERY_2020_V2 } from './staticContexts/secp256k1recovery2020v2'

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const DOC_CACHE_PREFIX = 'jsonld:document:'
const DOC_TTL_SECONDS = 60 * 60 * 24 * 7 // 7 days
const FETCH_TIMEOUT_MS = Number(process.env.JSONLD_FETCH_TIMEOUT_MS) || 3_000
// DID resolution gets a longer budget: Redis commandTimeout (~3 s) can be
// fully consumed before RPC resolution even starts, so reusing FETCH_TIMEOUT_MS
// for the DID path guarantees failure whenever Redis is degraded.
const DID_RESOLVE_TIMEOUT_MS = Number(process.env.DID_RESOLVE_TIMEOUT_MS) || 12_000
const MAX_DOC_BYTES = Number(process.env.JSONLD_MAX_DOC_BYTES) || 256 * 1024
const LRU_MAX = Number(process.env.INMEMORY_LRU_CACHE_LIMIT) || 500

// ---------------------------------------------------------------------------
// Layer 1 — static contexts embedded at build time (zero network, Redis-immune)
//
// Add any context here that (a) is not in Credo DEFAULT_CONTEXTS and (b)
// appears in DID documents or VPs we verify. Both the canonical w3id.org URL
// and the identity.foundation redirect target are mapped so whichever arrives
// is served in-process without a network round-trip.
// ---------------------------------------------------------------------------
const STATIC_CONTEXTS: Record<string, unknown> = {
  'https://w3id.org/security/suites/secp256k1recovery-2020/v2': SECP256K1_RECOVERY_2020_V2,
  'https://identity.foundation/EcdsaSecp256k1RecoverySignature2020/lds-ecdsa-secp256k1-recovery2020-2.0.jsonld':
    SECP256K1_RECOVERY_2020_V2,
}

// ---------------------------------------------------------------------------
// Layer 2 — allowlist: the only hosts we will ever FETCH from.
//
// Closes the SSRF vector present in the prior implementation (every non-schema
// URL in a presented credential was fetched live, unchecked). A URL whose host
// is not in this set is rejected immediately — no network call, no session held.
//
// Extend at runtime: ALLOWED_CONTEXT_HOSTS=host1.com,host2.com
// ---------------------------------------------------------------------------
const schemaHost = (() => {
  try {
    // Fall back to the default schema server so dev-schema.ngotag.com stays
    // allowlisted when SERVER_URL is not set (preserves pre-PR behaviour).
    return new URL(process.env.SERVER_URL ?? 'https://dev-schema.ngotag.com').host
  } catch {
    return ''
  }
})()

const ALLOWED_CONTEXT_HOSTS = new Set<string>([
  'www.w3.org',
  'w3.org',
  'w3id.org',
  'identity.foundation',
  ...(schemaHost ? [schemaHost] : []),
  ...(process.env.ALLOWED_CONTEXT_HOSTS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
])

// ---------------------------------------------------------------------------
// Layer 3a — in-process LRU (survives a Redis outage on the hot path)
//
// Minimal LRU backed by an insertion-ordered Map — no external dependency.
// ---------------------------------------------------------------------------
class SimpleLRU<V> {
  private readonly cache = new Map<string, V>()

  public constructor(private readonly max: number) {}

  public get(key: string): V | undefined {
    if (!this.cache.has(key)) return undefined
    const v = this.cache.get(key)!
    this.cache.delete(key)
    this.cache.set(key, v) // refresh to most-recently-used end
    return v
  }

  public set(key: string, value: V): void {
    if (this.cache.has(key)) {
      this.cache.delete(key)
    } else if (this.cache.size >= this.max) {
      this.cache.delete(this.cache.keys().next().value as string) // evict LRU
    }
    this.cache.set(key, value)
  }
}

const memCache = new SimpleLRU<DocumentLoaderResult>(LRU_MAX)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const withTimeout = <T>(p: Promise<T>, ms: number, url: string): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`document loader timeout after ${ms}ms for ${url}`)), ms)
    timer.unref() // don't keep the Node.js event loop alive for this timer alone
    p.then(
      (val) => {
        clearTimeout(timer)
        resolve(val)
      },
      (err) => {
        clearTimeout(timer)
        reject(err)
      }
    )
  })

// ---------------------------------------------------------------------------
// Loader factory
// ---------------------------------------------------------------------------
// jsonld is accessed via require to avoid adding import = require to the ESM
// import section (which triggers import/order group-boundary errors). The
// eslint-disable block covers the require call regardless of Prettier layout.
/* eslint-disable @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports */
const jsonld = (
  require('@credo-ts/core/build/modules/vc/data-integrity/libraries/jsonld') as {
    default: { frame(input: object, frame: object, options?: object): Promise<object> }
  }
).default
/* eslint-enable @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports */

export const buildCachedDocumentLoader = (logger: TsLogger): DocumentLoaderWithContext => {
  return (agentContext: AgentContext) => {
    const defaultLoader = defaultDocumentLoader(agentContext)
    const getCache = () => agentContext.dependencyManager.resolve(CacheModuleConfig).cache

    const wrappedLoader = async (url: string): Promise<DocumentLoaderResult> => {
      const noFrag = url.split('#')[0]
      const spanId = makeSpanId()
      const start = monoNow()
      const jweFp = requestContext.getStore()?.jweFp ?? ''

      // ------------------------------------------------------------------
      // 1a) STATIC contexts — embedded in bundle, zero network, Redis-immune
      // ------------------------------------------------------------------
      const staticDoc = STATIC_CONTEXTS[url] ?? STATIC_CONTEXTS[noFrag]
      if (staticDoc) {
        logger.debug(`Document loader static hit: ${url}`)
        emitStructured(LogLevel.trace, {
          hop: 'controller.jsonld.context.fetch.end',
          span_id: spanId,
          jwe_fp: jweFp,
          tenant_id: '',
          duration_ms: durationMs(start),
          cache_hit: true,
          url,
          notes: 'static',
        })
        return { contextUrl: null, documentUrl: url, document: staticDoc as Record<string, unknown> }
      }

      // ------------------------------------------------------------------
      // 1b) Credo DEFAULT_CONTEXTS bundle — also zero network
      // ------------------------------------------------------------------
      const bundledCtx =
        (DEFAULT_CONTEXTS as Record<string, unknown>)[url] ?? (DEFAULT_CONTEXTS as Record<string, unknown>)[noFrag]
      if (bundledCtx) {
        logger.debug(`Document loader Credo-bundled hit: ${url}`)
        emitStructured(LogLevel.trace, {
          hop: 'controller.jsonld.context.fetch.end',
          span_id: spanId,
          jwe_fp: jweFp,
          tenant_id: '',
          duration_ms: durationMs(start),
          cache_hit: true,
          url,
          notes: 'credo_bundled',
        })
        return { contextUrl: null, documentUrl: url, document: bundledCtx as Record<string, unknown> }
      }

      // ------------------------------------------------------------------
      // 2) non-HTTP URL — did: URLs are resolved here directly so that
      //    nested @context loads (e.g. secp256k1recovery-2020/v2 in
      //    did:ethr DID documents) route through wrappedLoader → layers
      //    1a–5, rather than Credo's inner loader which would do a live
      //    fetch bypassing the static map, allowlist, LRU, and Redis.
      //    Non-DID non-HTTP URLs fall back to defaultLoader unchanged.
      //
      //    DID_RESOLVE_TIMEOUT_MS is intentionally larger than
      //    FETCH_TIMEOUT_MS: Redis commandTimeout (~3 s) can be fully
      //    consumed before RPC resolution starts, so a 3 s budget
      //    guarantees failure whenever Redis is degraded.
      // ------------------------------------------------------------------
      const isHttp = url.startsWith('http://') || url.startsWith('https://')
      if (!isHttp) {
        emitStructured(LogLevel.trace, {
          hop: 'controller.jsonld.context.fetch.start',
          span_id: spanId,
          jwe_fp: jweFp,
          tenant_id: '',
          cache_hit: false,
          url,
        })
        let resolveNotes = 'did_resolve'
        try {
          let result: DocumentLoaderResult
          if (url.startsWith('did:')) {
            result = await withTimeout(
              (async () => {
                const didResolver = agentContext.dependencyManager.resolve(DidResolverService)
                const resolution = await didResolver.resolve(agentContext, url)
                if (resolution.didResolutionMetadata.error || !resolution.didDocument) {
                  throw new Error(
                    `Unable to resolve DID: ${url}: ${resolution.didResolutionMetadata.error ?? 'no document'}`
                  )
                }
                // eslint-disable-next-line @typescript-eslint/ban-ts-comment
                // @ts-ignore – jsonld typings do not expose documentLoader option
                const framed = await jsonld.frame(
                  resolution.didDocument.toJSON(),
                  { '@context': resolution.didDocument.context, '@embed': '@never', id: url },
                  { documentLoader: wrappedLoader }
                )
                return { contextUrl: null, documentUrl: url, document: framed as Record<string, unknown> }
              })(),
              DID_RESOLVE_TIMEOUT_MS,
              url
            )
            resolveNotes = 'did_resolve_wrapped'
          } else {
            result = await withTimeout(defaultLoader(url), FETCH_TIMEOUT_MS, url)
          }
          emitStructured(LogLevel.trace, {
            hop: 'controller.jsonld.context.fetch.end',
            span_id: spanId,
            jwe_fp: jweFp,
            tenant_id: '',
            duration_ms: durationMs(start),
            cache_hit: false,
            url,
            notes: resolveNotes,
          })
          return result
        } catch (err) {
          emitStructured(LogLevel.trace, {
            hop: 'controller.jsonld.context.fetch.end',
            span_id: spanId,
            jwe_fp: jweFp,
            tenant_id: '',
            duration_ms: durationMs(start),
            cache_hit: false,
            url,
            notes: `did_resolve_error: ${String(err)}`,
          })
          logger.error(`Document loader DID resolve failed: ${url}: ${err}`)
          throw err
        }
      }

      // ------------------------------------------------------------------
      // 3) Allowlist gate — SSRF prevention.
      //    Unknown host → immediate rejection, no network call, session freed.
      // ------------------------------------------------------------------
      let host = ''
      try {
        host = new URL(url).host
      } catch {
        /* invalid URL — falls through to rejection below */
      }
      if (!host || !ALLOWED_CONTEXT_HOSTS.has(host)) {
        logger.error(`Document loader BLOCKED non-allowlisted context: ${url}`)
        throw new Error(`document loader: context host not allowlisted: ${host || url}`)
      }

      // ------------------------------------------------------------------
      // 4a) In-memory LRU
      //     Serves allowlisted contexts even while Redis is timing out.
      //     This is the primary defence against the current Redis-timeout
      //     trigger: once a context is loaded once, it never touches Redis.
      // ------------------------------------------------------------------
      const memHit = memCache.get(url)
      if (memHit) {
        logger.debug(`Document loader in-memory LRU hit: ${url}`)
        emitStructured(LogLevel.trace, {
          hop: 'controller.jsonld.context.fetch.end',
          span_id: spanId,
          jwe_fp: jweFp,
          tenant_id: '',
          duration_ms: durationMs(start),
          cache_hit: true,
          url,
          notes: 'lru',
        })
        return memHit
      }

      // ------------------------------------------------------------------
      // 4b) Redis — commandTimeout already enforced by RedisCache (3 s).
      //     Any error is treated as a cache miss; never a hang.
      // ------------------------------------------------------------------
      const cacheKey = `${DOC_CACHE_PREFIX}${url}`
      try {
        const redisHit = await getCache().get<DocumentLoaderResult>(agentContext, cacheKey)
        if (redisHit) {
          memCache.set(url, redisHit) // promote to LRU for future hits
          logger.debug(`Document loader Redis cache hit: ${url}`)
          emitStructured(LogLevel.trace, {
            hop: 'controller.jsonld.context.fetch.end',
            span_id: spanId,
            jwe_fp: jweFp,
            tenant_id: '',
            duration_ms: durationMs(start),
            cache_hit: true,
            url,
            notes: 'redis',
          })
          return redisHit
        }
      } catch (err) {
        logger.warn(`Document loader Redis get failed (treating as miss) ${url}: ${err}`)
      }

      // ------------------------------------------------------------------
      // 5) Allowlisted cache miss — fetch with a hard timeout.
      //    The timeout guarantees this path always releases the session slot
      //    even if the remote context server is slow or unreachable.
      // ------------------------------------------------------------------
      emitStructured(LogLevel.trace, {
        hop: 'controller.jsonld.context.fetch.start',
        span_id: spanId,
        jwe_fp: jweFp,
        tenant_id: '',
        cache_hit: false,
        url,
      })

      let doc: DocumentLoaderResult
      try {
        doc = await withTimeout(defaultLoader(url), FETCH_TIMEOUT_MS, url)
      } catch (err) {
        emitStructured(LogLevel.trace, {
          hop: 'controller.jsonld.context.fetch.end',
          span_id: spanId,
          jwe_fp: jweFp,
          tenant_id: '',
          duration_ms: durationMs(start),
          cache_hit: false,
          url,
          notes: `fetch_error: ${String(err)}`,
        })
        logger.error(`Document loader fetch failed/timeout ${url}: ${err}`)
        throw err
      }

      emitStructured(LogLevel.trace, {
        hop: 'controller.jsonld.context.fetch.end',
        span_id: spanId,
        jwe_fp: jweFp,
        tenant_id: '',
        duration_ms: durationMs(start),
        cache_hit: false,
        url,
      })

      // Size-capped write-through to both caches
      try {
        const docSize = Buffer.byteLength(JSON.stringify(doc.document))
        if (docSize <= MAX_DOC_BYTES) {
          memCache.set(url, doc)
          await getCache().set(
            agentContext,
            cacheKey,
            {
              contextUrl: doc.contextUrl,
              documentUrl: doc.documentUrl,
              document: doc.document,
            },
            DOC_TTL_SECONDS
          )
          logger.debug(`Document loader cached: ${url} (${docSize} bytes)`)
        } else {
          logger.warn(`Document loader doc too large to cache (${docSize} bytes): ${url}`)
        }
      } catch (err) {
        logger.warn(`Document loader cache write failed ${url}: ${err}`)
      }

      return doc
    }
    return wrappedLoader
  }
}
