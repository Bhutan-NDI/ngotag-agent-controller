import type { AgentContext } from '@credo-ts/core'

import { computeSchemaChecksum, SCHEMA_CHECKSUM_ALGORITHM } from '@bhutan-ndi/ethr-credo-module'
import { W3cCredentialsModuleConfig } from '@credo-ts/core'
import { computeAddress, getAddress } from 'ethers'

export type SchemaVerificationStatus = 'verified' | 'legacy' | 'failed'

export interface SchemaVerificationResult {
  status: SchemaVerificationStatus
  reason?: string
  schemaUrl: string
  checksumAlgorithm?: string
  expectedChecksum?: string
  computedChecksum?: string
  /** Whether the record's writer (DID key vs. contract admin or a rotated-out key) was checked. */
  writerChecked: boolean
}

type RecordCheck = Omit<SchemaVerificationResult, 'schemaUrl' | 'writerChecked'>

const SHA256_HEX = /^[0-9a-f]{64}$/

export function addressFromEthrDid(did: string): string {
  if (!did.startsWith('did:ethr:')) {
    throw new Error(`Not a did:ethr DID: ${did}`)
  }
  const id = did.split(':').pop() ?? ''
  if (/^0x[0-9a-fA-F]{40}$/.test(id)) return getAddress(id)
  if (/^0x[0-9a-fA-F]{66}$/.test(id)) return computeAddress(id)
  throw new Error(`Unsupported did:ethr identifier: ${did}`)
}

/**
 * Loads the schema through the agent's JSON-LD document loader, so the object checked is the
 * (possibly cached) one used when signing credentials that reference it.
 */
export async function loadSchemaDocument(agentContext: AgentContext, schemaUrl: string): Promise<object> {
  const loader = agentContext.dependencyManager.resolve(W3cCredentialsModuleConfig).documentLoader(agentContext)
  const { document } = await loader(schemaUrl)
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    throw new Error(`Schema document at ${schemaUrl} is not a JSON object`)
  }
  return document
}

export function checkSchemaRecord(did: string, schemaId: string, recordJson: string, schema: object): RecordCheck {
  const failed = (reason: string): RecordCheck => ({ status: 'failed', reason })

  let record: Record<string, unknown>
  try {
    record = JSON.parse(recordJson)
  } catch {
    return failed('On-chain record is not valid JSON')
  }

  if (record.resourceURI !== `${did}/resources/${schemaId}`) {
    return failed('On-chain resourceURI does not match the DID and schema ID')
  }
  const address = addressFromEthrDid(did)
  if (
    typeof record.resourceCollectionId !== 'string' ||
    record.resourceCollectionId.toLowerCase() !== address.toLowerCase()
  ) {
    return failed('On-chain resourceCollectionId does not match the DID address')
  }

  if (!('checksumAlgorithm' in record)) {
    return { status: 'legacy', reason: 'Record has no checksumAlgorithm; its checksum carries no integrity' }
  }
  const checksumAlgorithm = record.checksumAlgorithm
  if (checksumAlgorithm !== SCHEMA_CHECKSUM_ALGORITHM) {
    return failed(`Unsupported checksumAlgorithm: ${String(checksumAlgorithm)}`)
  }
  const expectedChecksum = record.checksum
  if (typeof expectedChecksum !== 'string' || !SHA256_HEX.test(expectedChecksum)) {
    return failed('On-chain checksum is malformed')
  }

  const computedChecksum = computeSchemaChecksum(schema)
  return {
    status: computedChecksum === expectedChecksum ? 'verified' : 'failed',
    reason: computedChecksum === expectedChecksum ? undefined : 'Schema content does not match the on-chain checksum',
    checksumAlgorithm,
    expectedChecksum,
    computedChecksum,
  }
}
