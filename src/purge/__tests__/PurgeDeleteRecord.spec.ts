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

const { InjectionSymbols, RecordNotFoundError } = await import('@credo-ts/core')
const { DidCommCredentialExchangeRecord, DidCommMessageRecord, DidCommOutOfBandRecord, DidCommProofExchangeRecord } =
  await import('@credo-ts/didcomm')
const { OpenId4VcIssuanceSessionRepository, OpenId4VcVerificationSessionRepository } =
  await import('@credo-ts/openid4vc')
const {
  RECORD_TYPES_WITH_DIDCOMM_MESSAGE_CHILDREN,
  deleteDidCommMessageChildren,
  deletePurgeRecord,
  findDidCommMessageChildIds,
} = await import('../PurgeDeleteRecord')
const { PurgeRecordType } = await import('../PurgeTypes')

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const AGENT_CONTEXT = { contextCorrelationId: 'tenant-abc' }

interface Harness {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  agent: any
  storageService: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    deleteById: jest.Mock<any>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    findByQuery: jest.Mock<any>
  }
  protocolApis: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    credentialsDeleteById: jest.Mock<any>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    proofsDeleteById: jest.Mock<any>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    oobDeleteById: jest.Mock<any>
  }
  repositories: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    issuanceDeleteById: jest.Mock<any>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    verificationDeleteById: jest.Mock<any>
  }
}

function makeHarness(messages: Array<{ id: string }> = []): Harness {
  const storageService = {
    deleteById: jest.fn(async () => {}),
    findByQuery: jest.fn(async () => messages),
  }
  const protocolApis = {
    credentialsDeleteById: jest.fn(async () => {}),
    proofsDeleteById: jest.fn(async () => {}),
    oobDeleteById: jest.fn(async () => {}),
  }
  const repositories = {
    issuanceDeleteById: jest.fn(async () => {}),
    verificationDeleteById: jest.fn(async () => {}),
  }

  const agent = {
    context: AGENT_CONTEXT,
    dependencyManager: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      resolve: (token: any) => {
        if (token === InjectionSymbols.StorageService) return storageService
        if (token === OpenId4VcIssuanceSessionRepository) return { deleteById: repositories.issuanceDeleteById }
        if (token === OpenId4VcVerificationSessionRepository) return { deleteById: repositories.verificationDeleteById }
        throw new Error(`unexpected token: ${String(token)}`)
      },
    },
    modules: {
      didcomm: {
        credentials: { deleteById: protocolApis.credentialsDeleteById },
        proofs: { deleteById: protocolApis.proofsDeleteById },
        oob: { deleteById: protocolApis.oobDeleteById },
      },
    },
  }

  return { agent, storageService, protocolApis, repositories }
}

function expectNoProtocolDeletes(harness: Harness) {
  expect(harness.protocolApis.credentialsDeleteById).not.toHaveBeenCalled()
  expect(harness.protocolApis.proofsDeleteById).not.toHaveBeenCalled()
  expect(harness.protocolApis.oobDeleteById).not.toHaveBeenCalled()
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('deletePurgeRecord — storage-level deletes only (§4.1)', () => {
  test('credential exchange: deletes the exchange record via StorageService, never via the protocol API', async () => {
    const harness = makeHarness()

    await deletePurgeRecord(harness.agent, PurgeRecordType.DIDCOMM_CREDENTIAL, 'cred-exchange-1')

    expect(harness.storageService.deleteById).toHaveBeenCalledTimes(1)
    expect(harness.storageService.deleteById).toHaveBeenCalledWith(
      AGENT_CONTEXT,
      DidCommCredentialExchangeRecord,
      'cred-exchange-1',
    )

    // The whole point of the fix: the protocol delete (which cascades into the stored credential)
    // must never be reached.
    expectNoProtocolDeletes(harness)
  })

  test('credential exchange: no W3c / AnonCreds credential record is ever deleted', async () => {
    const harness = makeHarness()

    await deletePurgeRecord(harness.agent, PurgeRecordType.DIDCOMM_CREDENTIAL, 'cred-exchange-1')

    // Only ONE delete happened, and it named the exchange record class. Any cascade into a stored
    // credential would have to go through either an extra storage delete with a different record
    // class, or the protocol API — both of which are asserted absent.
    const deletedClasses = harness.storageService.deleteById.mock.calls.map((call) => call[1])
    expect(deletedClasses).toEqual([DidCommCredentialExchangeRecord])
    for (const recordClass of deletedClasses) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((recordClass as any).type).toBe('CredentialRecord')
    }
    expectNoProtocolDeletes(harness)
  })

  test('proof exchange: deletes via StorageService with the proof record class', async () => {
    const harness = makeHarness()

    await deletePurgeRecord(harness.agent, PurgeRecordType.DIDCOMM_PROOF, 'proof-1')

    expect(harness.storageService.deleteById).toHaveBeenCalledWith(AGENT_CONTEXT, DidCommProofExchangeRecord, 'proof-1')
    expectNoProtocolDeletes(harness)
  })

  test('OOB: deletes via StorageService with the OOB record class', async () => {
    const harness = makeHarness()

    await deletePurgeRecord(harness.agent, PurgeRecordType.DIDCOMM_OOB, 'oob-1')

    expect(harness.storageService.deleteById).toHaveBeenCalledWith(AGENT_CONTEXT, DidCommOutOfBandRecord, 'oob-1')
    expectNoProtocolDeletes(harness)
  })

  test('OID4VC issuance/verification: stay on their repositories, which are already parent-only', async () => {
    const harness = makeHarness()

    await deletePurgeRecord(harness.agent, PurgeRecordType.OID4VC_ISSUANCE, 'issuance-1')
    await deletePurgeRecord(harness.agent, PurgeRecordType.OID4VC_VERIFICATION, 'verification-1')

    expect(harness.repositories.issuanceDeleteById).toHaveBeenCalledWith(AGENT_CONTEXT, 'issuance-1')
    expect(harness.repositories.verificationDeleteById).toHaveBeenCalledWith(AGENT_CONTEXT, 'verification-1')
    expect(harness.storageService.deleteById).not.toHaveBeenCalled()
  })

  test('propagates RecordNotFoundError so callers can treat "already gone" as idempotent success', async () => {
    const harness = makeHarness()
    harness.storageService.deleteById.mockImplementation(async () => {
      throw new RecordNotFoundError('gone', { recordType: 'CredentialRecord' })
    })

    await expect(deletePurgeRecord(harness.agent, PurgeRecordType.DIDCOMM_CREDENTIAL, 'cred-1')).rejects.toBeInstanceOf(
      RecordNotFoundError,
    )
  })
})

describe('DidCommMessageRecord cascade', () => {
  test('only credential and proof exchanges own message children', () => {
    expect(RECORD_TYPES_WITH_DIDCOMM_MESSAGE_CHILDREN.has(PurgeRecordType.DIDCOMM_CREDENTIAL)).toBe(true)
    expect(RECORD_TYPES_WITH_DIDCOMM_MESSAGE_CHILDREN.has(PurgeRecordType.DIDCOMM_PROOF)).toBe(true)
    // OOB carries its invitation inline; the OID4VC sessions are not DIDComm at all. Querying for
    // children there would be a wasted round-trip per record on the largest category.
    expect(RECORD_TYPES_WITH_DIDCOMM_MESSAGE_CHILDREN.has(PurgeRecordType.DIDCOMM_OOB)).toBe(false)
    expect(RECORD_TYPES_WITH_DIDCOMM_MESSAGE_CHILDREN.has(PurgeRecordType.OID4VC_ISSUANCE)).toBe(false)
    expect(RECORD_TYPES_WITH_DIDCOMM_MESSAGE_CHILDREN.has(PurgeRecordType.OID4VC_VERIFICATION)).toBe(false)
  })

  test('children are looked up by the associatedRecordId tag', async () => {
    const harness = makeHarness([{ id: 'msg-1' }, { id: 'msg-2' }])

    const childIds = await findDidCommMessageChildIds(harness.agent, 'cred-exchange-1')

    expect(harness.storageService.findByQuery).toHaveBeenCalledWith(AGENT_CONTEXT, DidCommMessageRecord, {
      associatedRecordId: 'cred-exchange-1',
    })
    expect(childIds).toEqual(['msg-1', 'msg-2'])
  })

  test('children are deleted as DidCommMessageRecords', async () => {
    const harness = makeHarness()

    await deleteDidCommMessageChildren(harness.agent, ['msg-1', 'msg-2'])

    expect(harness.storageService.deleteById.mock.calls).toEqual([
      [AGENT_CONTEXT, DidCommMessageRecord, 'msg-1'],
      [AGENT_CONTEXT, DidCommMessageRecord, 'msg-2'],
    ])
  })
})
