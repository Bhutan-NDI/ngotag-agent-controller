/**
 * Regression tests for the §4.1 credential-safety fix (INTEGRATION-PLAN-develop.md).
 *
 * The hazard being locked down: `DidCommBaseCredentialProtocol.delete()` defaults
 * `deleteAssociatedCredentials` to `true`, so the protocol-level delete the purge previously used
 * (`agent.modules.didcomm.credentials.deleteById(id)`) also destroyed the stored
 * `W3cCredentialRecord` / `AnonCredsCredentialRecord`. For a holder cloud wallet that is data loss.
 *
 * These tests assert that a purge deletes the exchange record through the `StorageService` and
 * touches nothing else — in particular that the protocol APIs are never called.
 *
 * Runs under Jest ESM mode (see jest.config.base.ts).
 */
import { jest } from '@jest/globals'

const { RecordNotFoundError, W3cCredentialRepository } = await import('@credo-ts/core')
const { DidCommCredentialExchangeRepository, DidCommMessageRepository, DidCommProofExchangeRepository } =
  await import('@credo-ts/didcomm')
const { OpenId4VcIssuanceSessionRepository, OpenId4VcVerificationSessionRepository } =
  await import('@credo-ts/openid4vc')
const {
  RECORD_TYPES_WITH_DIDCOMM_MESSAGE_CHILDREN,
  deleteDidCommMessageChildren,
  deletePurgeRecord,
  findDidCommMessageChildIds,
  findPurgeRecordById,
} = await import('../PurgeDeleteRecord')
const { PurgeRecordType } = await import('../PurgeTypes')

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const AGENT_CONTEXT = { contextCorrelationId: 'tenant-abc' }

function makeHarness(messages: Array<{ id: string }> = []) {
  const calls: Array<{ repo: string; op: string; id: string }> = []
  const resolved: unknown[] = []
  const deleteErrors: Record<string, Error> = {}

  const repo = (name: string) => ({
    deleteById: jest.fn(async (_ctx: unknown, id: string) => {
      const error = deleteErrors[id]
      if (error) throw error
      calls.push({ repo: name, op: 'delete', id })
    }),
    findById: jest.fn(async (_ctx: unknown, id: string) => ({ id })),
    findByQuery: jest.fn(async () => messages),
  })

  const credentials = repo('credentialExchange')
  const proofs = repo('proofExchange')
  const didcommMessages = repo('didcommMessage')
  const issuance = repo('oid4vcIssuance')
  const verification = repo('oid4vcVerification')
  const w3c = repo('w3cCredential')

  // Protocol-layer entry points. Reaching ANY of these is the bug this file exists to prevent.
  const protocolApis = {
    credentialsDeleteById: jest.fn(async () => {}),
    proofsDeleteById: jest.fn(async () => {}),
  }
  // The OOB API is the one exception: it must be used, for the mediator routing cleanup.
  const oobDeleteById = jest.fn(async () => {})
  const oobFindById = jest.fn(async (id: string) => ({ id }))

  const agent = {
    context: AGENT_CONTEXT,
    dependencyManager: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      resolve: (token: any) => {
        resolved.push(token)
        if (token === DidCommCredentialExchangeRepository) return credentials
        if (token === DidCommProofExchangeRepository) return proofs
        if (token === DidCommMessageRepository) return didcommMessages
        if (token === OpenId4VcIssuanceSessionRepository) return issuance
        if (token === OpenId4VcVerificationSessionRepository) return verification
        if (token === W3cCredentialRepository) return w3c
        throw new Error(`unexpected token: ${String(token)}`)
      },
    },
    modules: {
      didcomm: {
        credentials: { deleteById: protocolApis.credentialsDeleteById },
        proofs: { deleteById: protocolApis.proofsDeleteById },
        oob: { deleteById: oobDeleteById, findById: oobFindById },
      },
    },
  }

  return {
    agent,
    calls,
    resolved,
    deleteErrors,
    repos: { credentials, proofs, didcommMessages, issuance, verification, w3c },
    protocolApis,
    oobDeleteById,
    oobFindById,
  }
}

type Harness = ReturnType<typeof makeHarness>

function expectNoProtocolCredentialDeletes(harness: Harness) {
  expect(harness.protocolApis.credentialsDeleteById).not.toHaveBeenCalled()
  expect(harness.protocolApis.proofsDeleteById).not.toHaveBeenCalled()
  expect(harness.repos.w3c.deleteById).not.toHaveBeenCalled()
  expect(harness.resolved).not.toContain(W3cCredentialRepository)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('deletePurgeRecord — parent-only, never the credential-cascading protocol layer (§4.1)', () => {
  test('JSON-LD over DIDComm: the holder\u2019s stored W3cCredentialRecord is never reached', async () => {
    // The exact production stack, and the exact chain the old protocol delete followed:
    //   credentials.deleteById(id)
    //     -> DidCommCredentialV2Protocol.delete()        deleteAssociatedCredentials ?? true
    //     -> getFormatServiceForRecordType('w3c')        FIRST service claiming 'w3c', which in
    //                                                    cliAgent.ts is legacyIndy, NOT jsonLd
    //     -> AnonCredsRsHolderService.deleteCredential(id)
    //     -> W3cCredentialRepository.findById(id) hits   the binding IS a W3cCredentialRecord id
    //     -> W3cCredentialRepository.delete(...)         holder's credential destroyed
    const harness = makeHarness()

    await deletePurgeRecord(harness.agent as never, PurgeRecordType.DIDCOMM_CREDENTIAL, 'cred-exchange-1')

    expect(harness.calls).toEqual([{ repo: 'credentialExchange', op: 'delete', id: 'cred-exchange-1' }])
    expectNoProtocolCredentialDeletes(harness)
  })

  test('credential and proof exchanges go through their repositories, which emit lifecycle events', async () => {
    // Repository.deleteById is storageService.deleteById plus a RecordDeleted emit — no extra read
    // and no cascade — so it keeps the safety property while preserving the event every other Credo
    // delete path produces.
    const harness = makeHarness()

    await deletePurgeRecord(harness.agent as never, PurgeRecordType.DIDCOMM_CREDENTIAL, 'cred-1')
    await deletePurgeRecord(harness.agent as never, PurgeRecordType.DIDCOMM_PROOF, 'proof-1')

    expect(harness.repos.credentials.deleteById).toHaveBeenCalledWith(AGENT_CONTEXT, 'cred-1')
    expect(harness.repos.proofs.deleteById).toHaveBeenCalledWith(AGENT_CONTEXT, 'proof-1')
    expectNoProtocolCredentialDeletes(harness)
  })

  test('OOB uses its API so mediator routing is cleaned up, not the repository', async () => {
    // DidCommOutOfBandApi.deleteById deregisters the invitation's recipient keys from the mediator
    // when the record has a mediatorId, carries only inline services, and has no related connection.
    // The 7-day await-response track is exactly that case, and create-request-oob routes through
    // mediationRecipient.getRouting() — so a raw delete would leak keylist entries at the mediator
    // for every purged invitation. Unlike the credential API, this one cascades nothing else.
    const harness = makeHarness()

    await deletePurgeRecord(harness.agent as never, PurgeRecordType.DIDCOMM_OOB, 'oob-1')

    expect(harness.oobDeleteById).toHaveBeenCalledWith('oob-1')
    expect(harness.calls).toEqual([])
  })

  test('OID4VC issuance/verification stay on their repositories', async () => {
    const harness = makeHarness()

    await deletePurgeRecord(harness.agent as never, PurgeRecordType.OID4VC_ISSUANCE, 'issuance-1')
    await deletePurgeRecord(harness.agent as never, PurgeRecordType.OID4VC_VERIFICATION, 'verification-1')

    expect(harness.repos.issuance.deleteById).toHaveBeenCalledWith(AGENT_CONTEXT, 'issuance-1')
    expect(harness.repos.verification.deleteById).toHaveBeenCalledWith(AGENT_CONTEXT, 'verification-1')
  })

  test('propagates RecordNotFoundError so callers can treat "already gone" as idempotent success', async () => {
    const harness = makeHarness()
    harness.deleteErrors['cred-1'] = new RecordNotFoundError('gone', { recordType: 'CredentialRecord' })

    await expect(
      deletePurgeRecord(harness.agent as never, PurgeRecordType.DIDCOMM_CREDENTIAL, 'cred-1'),
    ).rejects.toBeInstanceOf(RecordNotFoundError)
  })
})

describe('findPurgeRecordById — re-read before deleting', () => {
  test('reads through the same repository / API used for deletion', async () => {
    const harness = makeHarness()

    await findPurgeRecordById(harness.agent as never, PurgeRecordType.DIDCOMM_PROOF, 'proof-1')
    await findPurgeRecordById(harness.agent as never, PurgeRecordType.DIDCOMM_OOB, 'oob-1')

    expect(harness.repos.proofs.findById).toHaveBeenCalledWith(AGENT_CONTEXT, 'proof-1')
    expect(harness.oobFindById).toHaveBeenCalledWith('oob-1')
  })
})

describe('DidCommMessageRecord cascade', () => {
  test('only credential and proof exchanges own message children', () => {
    expect(RECORD_TYPES_WITH_DIDCOMM_MESSAGE_CHILDREN.has(PurgeRecordType.DIDCOMM_CREDENTIAL)).toBe(true)
    expect(RECORD_TYPES_WITH_DIDCOMM_MESSAGE_CHILDREN.has(PurgeRecordType.DIDCOMM_PROOF)).toBe(true)
    // OOB carries its invitation inline; the OID4VC sessions are not DIDComm at all.
    expect(RECORD_TYPES_WITH_DIDCOMM_MESSAGE_CHILDREN.has(PurgeRecordType.DIDCOMM_OOB)).toBe(false)
    expect(RECORD_TYPES_WITH_DIDCOMM_MESSAGE_CHILDREN.has(PurgeRecordType.OID4VC_ISSUANCE)).toBe(false)
    expect(RECORD_TYPES_WITH_DIDCOMM_MESSAGE_CHILDREN.has(PurgeRecordType.OID4VC_VERIFICATION)).toBe(false)
  })

  test('children are looked up by the associatedRecordId tag', async () => {
    const harness = makeHarness([{ id: 'msg-1' }, { id: 'msg-2' }])

    const childIds = await findDidCommMessageChildIds(harness.agent as never, 'cred-exchange-1')

    expect(harness.repos.didcommMessages.findByQuery).toHaveBeenCalledWith(AGENT_CONTEXT, {
      associatedRecordId: 'cred-exchange-1',
    })
    expect(childIds).toEqual(['msg-1', 'msg-2'])
  })

  test('children are deleted through the message repository', async () => {
    const harness = makeHarness()

    const removed = await deleteDidCommMessageChildren(harness.agent as never, ['msg-1', 'msg-2'])

    expect(removed).toBe(2)
    expect(harness.calls).toEqual([
      { repo: 'didcommMessage', op: 'delete', id: 'msg-1' },
      { repo: 'didcommMessage', op: 'delete', id: 'msg-2' },
    ])
  })

  test('an already-gone child is counted as removed and does not abort the cascade', async () => {
    const harness = makeHarness()
    harness.deleteErrors['msg-1'] = new RecordNotFoundError('gone', { recordType: 'DidCommMessageRecord' })

    const removed = await deleteDidCommMessageChildren(harness.agent as never, ['msg-1', 'msg-2'])

    expect(removed).toBe(2)
    expect(harness.calls).toEqual([{ repo: 'didcommMessage', op: 'delete', id: 'msg-2' }])
  })

  test('a real child failure propagates so the parent is left in place', async () => {
    const harness = makeHarness()
    harness.deleteErrors['msg-1'] = new Error('storage locked')

    await expect(deleteDidCommMessageChildren(harness.agent as never, ['msg-1'])).rejects.toThrow('storage locked')
  })
})
