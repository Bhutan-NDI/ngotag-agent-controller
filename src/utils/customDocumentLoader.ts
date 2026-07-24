import type { AgentContext, DocumentLoader } from '@credo-ts/core'
import type { DocumentLoaderResult } from '@credo-ts/core/build/modules/vc/data-integrity/jsonldUtil.mjs'

import { CredoError, DidsApi } from '@credo-ts/core'
import { defaultDocumentLoader } from '@credo-ts/core/build/modules/vc/data-integrity/libraries/documentLoader.mjs'
import jsonld from '@credo-ts/core/build/modules/vc/data-integrity/libraries/jsonld.mjs'

import { SECP256K1_RECOVERY_2020_V2 } from './staticContexts/secp256k1recovery2020v2'

// Contexts embedded at build time so did:ethr DID documents (which reference the
// secp256k1recovery-2020 suite) resolve without a network round-trip. Both the
// canonical w3id.org URL and the identity.foundation redirect target are mapped.
const STATIC_CONTEXTS: Record<string, unknown> = {
  'https://w3id.org/security/suites/secp256k1recovery-2020/v2': SECP256K1_RECOVERY_2020_V2,
  'https://identity.foundation/EcdsaSecp256k1RecoverySignature2020/lds-ecdsa-secp256k1-recovery2020-2.0.jsonld':
    SECP256K1_RECOVERY_2020_V2,
}

/**
 * Check if URL belongs to CREDEBL schema domain
 */
function isW3CDeprecatedUrl(url: string, agentContext: AgentContext): boolean {
  // agentContext.config.logger.debug(
  //   `Checking if w3c url(${url}) contains deprecated domain for agent: ${agentContext.config.label}`,
  // )
  return url.startsWith(process.env.DEPRECATED_DOMAIN!)
}

/**
 * For JSON-LD schemas replace deprecated domain to migrated/updated domain
 */
function replaceUrl(url: string, agent: AgentContext): string {
  agent.config.logger.debug(`Replacing deprecated domain with updated domain`)
  return url.replace(process.env.DEPRECATED_DOMAIN!, process.env.CURRENT_DOMAIN!)
}

/**
 * Custom loader that extends Credo's default loader
 */
export const CustomDocumentLoader = (agentContext: AgentContext): DocumentLoader => {
  const defaultLoader = defaultDocumentLoader(agentContext)

  const wrappedLoader = async function (url: string): Promise<DocumentLoaderResult> {
    try {
      // Intercept credebl schemas
      if (isW3CDeprecatedUrl(url, agentContext)) {
        // agentContext.config.logger.debug(
        //   `Found w3c url(${url}) containing deprecated domain for agent: ${agentContext.config.label}`,
        // )
        url = replaceUrl(url, agentContext)
      }

      // Static contexts (e.g. secp256k1recovery-2020/v2, used by did:ethr DID documents)
      // are served from the embedded map with zero network cost.
      const staticDoc = STATIC_CONTEXTS[url] ?? STATIC_CONTEXTS[url.split('#')[0]]
      if (staticDoc) {
        return { contextUrl: null, documentUrl: url, document: staticDoc as Record<string, unknown> }
      }

      // did: URLs are resolved here and framed through wrappedLoader so that
      // nested @context loads (e.g. secp256k1recovery-2020/v2 referenced by
      // did:ethr DID documents) route through the static map above, rather
      // than Credo's inner loader doing an unwrapped live fetch.
      if (url.startsWith('did:')) {
        const didsApi = agentContext.dependencyManager.resolve(DidsApi)
        const resolution = await didsApi.resolve(url)
        if (resolution.didResolutionMetadata.error || !resolution.didDocument) {
          throw new Error(`Unable to resolve DID: ${url}: ${resolution.didResolutionMetadata.error ?? 'no document'}`)
        }
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore – jsonld typings do not expose documentLoader option
        const framed = await jsonld.frame(
          resolution.didDocument.toJSON(),
          { '@context': resolution.didDocument.context, '@embed': '@never', id: url },
          { documentLoader: wrappedLoader },
        )
        return { contextUrl: null, documentUrl: url, document: framed as Record<string, unknown> }
      }

      agentContext.config.logger.debug(`Passing url(${url}) to default loader`)
      return await defaultLoader(url)
    } catch (error) {
      throw new CredoError(`Failed to load document for ${url}`, { cause: error as Error })
    }
  }

  return wrappedLoader
}
