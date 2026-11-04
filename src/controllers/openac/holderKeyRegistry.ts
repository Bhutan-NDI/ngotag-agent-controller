import type { AgentContext } from '@credo-ts/core'

import { GenericRecordsApi, Kms, TypedArrayEncoder } from '@credo-ts/core'

import { NotFoundError } from '../../errors/errors'

/**
 * Remembers which Askar key backs each holder-bound credential, so the OpenAC holder route can sign a verifier nonce
 * with it. The key is created by credentialBindingResolver (OpenId4Vci holder binding) and written into the credential's
 * `cnf.jwk`; Askar keys cannot be exported and the KMS has no lookup by JWK, so the link is stored here, keyed by the
 * JWK's RFC 7638 thumbprint.
 *
 * Records live in the wallet of the agent context that created the key, so each tenant only sees its own keys.
 */

const RECORD_ID_PREFIX = 'openac-holder-key-'
const RECORD_TAG = 'openacHolderKey'

// A type alias, not an interface: generic record content must be assignable to Record<string, unknown>.
export type HolderKeyRecordContent = {
  keyId: string
  thumbprint: string
}

const recordId = (thumbprint: string): string => `${RECORD_ID_PREFIX}${thumbprint}`

/** RFC 7638 SHA-256 thumbprint (base64url) of a public JWK, e.g. a credential's `cnf.jwk`. Extra members such as `kid` are ignored. */
export const holderKeyThumbprint = (jwk: unknown): string =>
  TypedArrayEncoder.toBase64URL(Kms.PublicJwk.fromUnknown(jwk).getJwkThumbprint())

/**
 * Records the Askar keyId of a freshly created holder key under its JWK thumbprint.
 *
 * Best effort: a failure is logged and never fails the credential request it runs inside. It would only show up later
 * as a "holder key not found" error when presenting.
 */
export const recordHolderKey = async (agentContext: AgentContext, publicJwk: Kms.PublicJwk): Promise<void> => {
  try {
    const genericRecords = agentContext.resolve(GenericRecordsApi)
    const thumbprint = holderKeyThumbprint(publicJwk.toJson())
    const id = recordId(thumbprint)

    if (await genericRecords.findById(id)) return

    const content: HolderKeyRecordContent = { keyId: publicJwk.keyId, thumbprint }
    await genericRecords.save({ id, content, tags: { [RECORD_TAG]: 'true' } })
  } catch (error) {
    agentContext.config.logger.warn('Could not record the holder key for OpenAC presentations', {
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

/**
 * Finds the Askar keyId for the key in a credential's `cnf.jwk`.
 * @throws NotFoundError when the credential was not bound by a key this agent recorded
 */
export const findHolderKeyId = async (agentContext: AgentContext, cnfJwk: unknown): Promise<string> => {
  const thumbprint = holderKeyThumbprint(cnfJwk)
  const record = await agentContext.resolve(GenericRecordsApi).findById(recordId(thumbprint))
  const content = record?.content as Partial<HolderKeyRecordContent> | undefined

  if (!content?.keyId) {
    throw new NotFoundError(
      `No holder key recorded for this credential (jwk thumbprint ${thumbprint}). It was not issued to a key created by this wallet.`,
    )
  }
  return content.keyId
}
