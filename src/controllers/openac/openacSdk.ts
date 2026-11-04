/**
 * Loads openac-sdk and the 1k proving/verifying keys once per process.
 *
 * openac-sdk is ESM-only and the controller builds to CommonJS, where `import()` is compiled to `require()`, so the SDK
 * is loaded through a real dynamic import that TypeScript leaves alone.
 *
 * Keys are read from OPENAC_KEYS_DIR (default ./openac-keys), never fetched at runtime. Each file's SHA-256 is checked
 * against the digests the SDK pins for openac-5.0.0 (dist/index.js, KEY_SHA256), and the process fails closed: if the
 * keys are missing or wrong, every OpenAC route returns an error and nothing is proven or verified.
 */
import type * as OpenAcSdk from 'openac-sdk'
import type { KeySet, OpenAC } from 'openac-sdk'

import { createHash } from 'crypto'
import { readFile } from 'fs/promises'
import { join, resolve } from 'path'

import { InternalServerError } from '../../errors/errors'

export const VC_SIZE = '1k' as const

// Copied from openac-sdk@5.0.0 dist/index.js KEY_SHA256. Re-check on any SDK upgrade (the CDN path is versioned).
const KEY_SHA256: Record<string, string> = {
  '1k_prepare_proving.key': '095f9c253274a831eb5d8225b6d7b855ab8471621968e773c041c83f32c46e8a',
  '1k_prepare_verifying.key': 'f1fcc1d5036ef6ca9efb538b3510a5a492518018beb217c50ee2c014d7351add',
  '1k_show_proving.key': '809f24ca6ee003b684e2282b77f5a47279528edee7654a3801770a2ffca67831',
  '1k_show_verifying.key': 'f0c447a9757d182e8aa23083bc3dba5a9a22f3e0fcbb344724568cc3c83352d8',
}

type Sdk = typeof OpenAcSdk

const importEsm = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<Sdk>

export interface OpenAcRuntime {
  sdk: Sdk
  openac: OpenAC
  keys: KeySet
}

export const keysDir = (): string => resolve(process.env.OPENAC_KEYS_DIR ?? './openac-keys')

const readVerified = async (dir: string, filename: string): Promise<Uint8Array> => {
  const bytes = await readFile(join(dir, filename))
  const actual = createHash('sha256').update(bytes).digest('hex')
  if (actual !== KEY_SHA256[filename]) {
    throw new Error(`${filename} failed its SHA-256 check (expected ${KEY_SHA256[filename]}, got ${actual})`)
  }
  return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}

let runtime: Promise<OpenAcRuntime> | undefined

/** Initialises on first use and caches the result. A failure is cached too, so a bad key set is not retried per request. */
export const getOpenAcRuntime = (): Promise<OpenAcRuntime> => {
  runtime ??= (async () => {
    try {
      const dir = keysDir()
      const sdk = await importEsm('openac-sdk')
      const openac = await sdk.OpenAC.init()
      if (!openac.isReady) throw new Error('openac-sdk did not initialise')
      const [prepareProvingKey, prepareVerifyingKey, showProvingKey, showVerifyingKey] = await Promise.all([
        readVerified(dir, `${VC_SIZE}_prepare_proving.key`),
        readVerified(dir, `${VC_SIZE}_prepare_verifying.key`),
        readVerified(dir, `${VC_SIZE}_show_proving.key`),
        readVerified(dir, `${VC_SIZE}_show_verifying.key`),
      ])
      const keys = await openac.loadKeys({ prepareProvingKey, prepareVerifyingKey, showProvingKey, showVerifyingKey })
      return { sdk, openac, keys }
    } catch (error) {
      throw new InternalServerError(
        `OpenAC is unavailable: ${error instanceof Error ? error.message : String(error)}. ` +
          `Expected the 1k key files in ${keysDir()} (OPENAC_KEYS_DIR).`,
      )
    }
  })()
  return runtime
}

/** Test hook. */
export const resetOpenAcRuntime = (): void => {
  runtime = undefined
}
