/**
 * Regression tests for writeDid's isDefault handling — specifically the #75 review finding that
 * handleIndicio's non-endorser branch (role !== 'endorser', an endorserDid supplied instead)
 * returns the raw registrar result (`{ didState: { did, didDocument, state }, ... }`), not a
 * normalized `{ did, didDocument }` like every other handler branch (handleBcovrin's equivalent
 * branch included). A plain `didRes.did` read is therefore undefined for this one path, so
 * `isDefault: true` was silently dropped: the request still returned 200, but the tag was never
 * written, and the caller had no way to know their isDefault flag was ignored.
 *
 * Fix: writeDid falls back to `didRes.didState?.did` when `didRes.did` is absent.
 *
 * Also covers the #75 follow-up findings (kinxa0, 2026-08-17): isDefault is tracked as a tag on
 * the DID's own DidRecord (via DidRepository), not a separate GenericRecord pointer — verified
 * directly against the installed @credo-ts/core/@credo-ts/askar packages that arbitrary DidRecord
 * tags round-trip through save and query. This suite exercises: the didState.did fallback, the
 * previous-default-clearing behavior (fixing the legacy bug where the old default was never
 * cleared), the self-clearing no-op guard, that both writes now go through updateByIdWithLock
 * (Askar's atomic read-modify-write with forUpdate: true, not a plain get+update), and the same
 * "never 500 an already-successful DID creation over bookkeeping" contract as before (the
 * bookkeeping is wrapped in its own try/catch and only logs a warning on failure; writeDid still
 * returns the real created DID either way).
 *
 * Runs under Jest's ESM mode, mirroring DidController.polygon.spec.ts / DidController.ethereum
 * .spec.ts: tsyringe and cliAgent are mocked so constructing the controller doesn't require a real
 * DI container / agent spin-up. Unlike those two spec files (which call a public handleX method
 * directly), this one goes through the public writeDid entrypoint itself, since the bug is in
 * writeDid's own createdDid-resolution logic, not in handleIndicio.
 */
import { jest } from '@jest/globals'

const noopDecorator = () => () => {}

const mockRootAgent = { config: { logger: { info: jest.fn(), warn: jest.fn() } } }

jest.unstable_mockModule('tsyringe', () => ({
  injectable: noopDecorator,
  singleton: noopDecorator,
  scoped: noopDecorator,
  autoInjectable: noopDecorator,
  inject: noopDecorator,
  injectAll: noopDecorator,
  delay: (fn: unknown) => fn,
  Lifecycle: { Singleton: 0, Transient: 1, ResolutionScoped: 2, ContainerScoped: 3 },
  container: {
    resolve: jest.fn(() => mockRootAgent),
    register: jest.fn(),
    registerInstance: jest.fn(),
    isRegistered: jest.fn(() => false),
  },
}))

// Avoid spinning up the agent module graph (express + native bindings) on import.
jest.unstable_mockModule('../../../cliAgent', () => ({}))

const { DidController } = await import('../DidController')
const { DidRepository } = await import('@credo-ts/core')

const SEED = 'a'.repeat(32)
const ENDORSER_DID = 'did:indy:indicio:testnet:endorser123'
const CREATED_DID = 'did:indy:indicio:testnet:created456'

const makeDidRecordFake = (id: string) => ({ id, setTag: jest.fn() })

// createEndorserDid (invoked by handleIndicio's non-endorser branch) calls agent.dids.create and
// returns the raw registrar result unmodified — no top-level `did`, only `didState.did`.
//
// updateByIdWithLock is faked against a small id -> record registry rather than a real Askar
// transaction: production passes the callback a freshly re-fetched (locked) record instance, not
// necessarily the same object reference findCreatedDid/findByQuery already returned, so the fake
// must do the same "look up the current record by id, hand it to the callback" indirection for the
// setTag-call assertions below to mean anything.
const makeAgent = (createResult: unknown) => {
  const knownRecords = new Map<string, ReturnType<typeof makeDidRecordFake>>()
  const didRepository = {
    findCreatedDid: jest.fn(async () => null) as jest.Mock,
    findByQuery: jest.fn(async () => []) as jest.Mock,
    updateByIdWithLock: jest.fn(async (_ctx: unknown, id: string, callback: (r: unknown) => Promise<unknown>) => {
      const record = knownRecords.get(id)
      if (!record) {
        throw new Error(`no known record for id ${id}`)
      }
      return callback(record)
    }) as jest.Mock,
  }
  return {
    dids: { create: jest.fn(async () => createResult) as jest.Mock },
    dependencyManager: {
      resolve: jest.fn((token: unknown) => (token === DidRepository ? didRepository : undefined)) as jest.Mock,
    },
    context: { contextCorrelationId: 'test-tenant' },
    _didRepository: didRepository,
    _knownRecords: knownRecords,
  }
}

const indicioNonEndorserOptions = (overrides: Record<string, unknown> = {}) =>
  ({
    method: 'indy',
    network: 'indicio:testnet',
    keyType: 'ed25519',
    seed: SEED,
    endorserDid: ENDORSER_DID,
    // role deliberately omitted/not 'endorser' — this is the non-endorser branch
    isDefault: true,
    ...overrides,
  }) as never

const makeRequest = (agent: unknown) => ({ agent }) as never

describe("writeDid — isDefault via handleIndicio's non-endorser branch", () => {
  beforeEach(() => {
    mockRootAgent.config.logger.warn.mockClear()
  })

  it('tags the created DID as default using the didState.did fallback when top-level did is absent', async () => {
    const agent = makeAgent({
      didState: { state: 'finished', did: CREATED_DID, didDocument: { id: CREATED_DID } },
    })
    const newRecord = makeDidRecordFake('rec-new')
    agent._knownRecords.set(newRecord.id, newRecord)
    agent._didRepository.findCreatedDid = jest.fn(async () => newRecord) as jest.Mock
    const controller = new DidController()

    await controller.writeDid(makeRequest(agent), indicioNonEndorserOptions())

    expect(agent._didRepository.findCreatedDid).toHaveBeenCalledWith(agent.context, CREATED_DID)
    expect(agent._didRepository.updateByIdWithLock).toHaveBeenCalledWith(
      agent.context,
      newRecord.id,
      expect.any(Function),
    )
    expect(newRecord.setTag).toHaveBeenCalledWith('isDefault', true)
  })

  it('reports isDefaultSet: true on the response when the bookkeeping actually succeeds', async () => {
    // #75 review: the response must distinguish "isDefault was requested and actually recorded"
    // from "isDefault was requested but the bookkeeping silently failed" -- see the isDefaultSet:
    // false cases below for the failure side of this same contract.
    const agent = makeAgent({
      didState: { state: 'finished', did: CREATED_DID, didDocument: { id: CREATED_DID } },
    })
    const newRecord = makeDidRecordFake('rec-new')
    agent._knownRecords.set(newRecord.id, newRecord)
    agent._didRepository.findCreatedDid = jest.fn(async () => newRecord) as jest.Mock
    const controller = new DidController()

    const result = await controller.writeDid(makeRequest(agent), indicioNonEndorserOptions())

    expect(result).toEqual(
      expect.objectContaining({
        isDefaultSet: true,
      }),
    )
  })

  it("tags the newly created DID as default and clears the previous default DID's tag", async () => {
    const agent = makeAgent({
      didState: { state: 'finished', did: CREATED_DID, didDocument: { id: CREATED_DID } },
    })
    const newRecord = makeDidRecordFake('rec-new')
    const oldRecord = makeDidRecordFake('rec-old')
    agent._knownRecords.set(newRecord.id, newRecord)
    agent._knownRecords.set(oldRecord.id, oldRecord)
    agent._didRepository.findCreatedDid = jest.fn(async () => newRecord) as jest.Mock
    agent._didRepository.findByQuery = jest.fn(async () => [oldRecord]) as jest.Mock
    const controller = new DidController()

    await controller.writeDid(makeRequest(agent), indicioNonEndorserOptions())

    expect(oldRecord.setTag).toHaveBeenCalledWith('isDefault', false)
    expect(agent._didRepository.updateByIdWithLock).toHaveBeenCalledWith(
      agent.context,
      oldRecord.id,
      expect.any(Function),
    )
    expect(newRecord.setTag).toHaveBeenCalledWith('isDefault', true)
    expect(agent._didRepository.updateByIdWithLock).toHaveBeenCalledWith(
      agent.context,
      newRecord.id,
      expect.any(Function),
    )
  })

  it('tags the new default BEFORE clearing the previous one — not the other order', async () => {
    // #73 review: the previous order (clear old defaults, then tag the new one) made the worst
    // case of a failure on that final write "zero tagged defaults" -- the self-attested-issuance
    // endpoint 404s where it worked a moment before. Tagging first makes the worst case "two
    // tagged defaults" instead, which the read path already tolerates by design.
    const agent = makeAgent({
      didState: { state: 'finished', did: CREATED_DID, didDocument: { id: CREATED_DID } },
    })
    const newRecord = makeDidRecordFake('rec-new')
    const oldRecord = makeDidRecordFake('rec-old')
    agent._knownRecords.set(newRecord.id, newRecord)
    agent._knownRecords.set(oldRecord.id, oldRecord)
    agent._didRepository.findCreatedDid = jest.fn(async () => newRecord) as jest.Mock
    agent._didRepository.findByQuery = jest.fn(async () => [oldRecord]) as jest.Mock
    const controller = new DidController()

    await controller.writeDid(makeRequest(agent), indicioNonEndorserOptions())

    const updateCalls = (agent._didRepository.updateByIdWithLock as jest.Mock).mock.calls as Array<[unknown, string]>
    const newRecordCallIndex = updateCalls.findIndex(([, id]) => id === newRecord.id)
    const oldRecordCallIndex = updateCalls.findIndex(([, id]) => id === oldRecord.id)
    expect(newRecordCallIndex).toBeLessThan(oldRecordCallIndex)
  })

  it('leaves the previous default tagged (not cleared) when tagging the new default fails — the old order left zero defaults instead', async () => {
    const agent = makeAgent({
      didState: { state: 'finished', did: CREATED_DID, didDocument: { id: CREATED_DID } },
    })
    const newRecord = makeDidRecordFake('rec-new')
    const oldRecord = makeDidRecordFake('rec-old')
    agent._knownRecords.set(newRecord.id, newRecord)
    agent._knownRecords.set(oldRecord.id, oldRecord)
    agent._didRepository.findCreatedDid = jest.fn(async () => newRecord) as jest.Mock
    agent._didRepository.findByQuery = jest.fn(async () => [oldRecord]) as jest.Mock
    // The write that tags the new record as default fails (a real Askar/storage error, a lock
    // timeout) -- the same class of failure the surrounding best-effort try/catch exists for.
    agent._didRepository.updateByIdWithLock = jest.fn(
      async (_ctx: unknown, id: string, callback: (r: unknown) => Promise<unknown>) => {
        if (id === newRecord.id) {
          throw new Error('simulated storage failure tagging the new default')
        }
        return callback(agent._knownRecords.get(id))
      },
    ) as jest.Mock
    const controller = new DidController()

    const result = await controller.writeDid(makeRequest(agent), indicioNonEndorserOptions())

    // oldRecord's tag is never touched -- the clearing loop only runs after the new-tag write
    // succeeds, so the tenant is left with its previous default still intact rather than none.
    expect(oldRecord.setTag).not.toHaveBeenCalled()
    expect(result).toEqual(expect.objectContaining({ isDefaultSet: false }))
  })

  it('reports isDefaultSet: true even when the clearing loop itself fails — the tag write already succeeded and is what issuance actually uses', async () => {
    // #75 review: isDefaultSet was only set true after the *whole* tag+clear sequence completed,
    // so a failure in the clearing loop alone reported isDefaultSet: false even though the new
    // DID was already tagged and, being the newest by createdAt, is exactly what
    // AgentController's sorted read path picks. A client told "not set" for a request that was
    // in fact honored has one recourse -- retry -- which anchors a second, orphaned ledger DID.
    const agent = makeAgent({
      didState: { state: 'finished', did: CREATED_DID, didDocument: { id: CREATED_DID } },
    })
    const newRecord = makeDidRecordFake('rec-new')
    const oldRecord = makeDidRecordFake('rec-old')
    agent._knownRecords.set(newRecord.id, newRecord)
    agent._knownRecords.set(oldRecord.id, oldRecord)
    agent._didRepository.findCreatedDid = jest.fn(async () => newRecord) as jest.Mock
    agent._didRepository.findByQuery = jest.fn(async () => [oldRecord]) as jest.Mock
    // The clearing write (oldRecord) fails; the tagging write (newRecord) already succeeded.
    agent._didRepository.updateByIdWithLock = jest.fn(
      async (_ctx: unknown, id: string, callback: (r: unknown) => Promise<unknown>) => {
        if (id === oldRecord.id) {
          throw new Error('simulated storage failure clearing the previous default')
        }
        return callback(agent._knownRecords.get(id))
      },
    ) as jest.Mock
    const controller = new DidController()

    const result = await controller.writeDid(makeRequest(agent), indicioNonEndorserOptions())

    expect(newRecord.setTag).toHaveBeenCalledWith('isDefault', true)
    expect(result).toEqual(expect.objectContaining({ isDefaultSet: true }))
  })

  it('snapshots previousDefaults BEFORE tagging the new default, not after — the after-tagging order let two concurrent isDefault writes each clear the other and converge on zero defaults', async () => {
    // #75 review, reviewer confirming and owning it: reading previousDefaults *after* the tag
    // write (the shape the #73 fix landed in) let two concurrent isDefault:true requests for two
    // different DIDs each observe the other's freshly-tagged record as "previous" and clear it --
    // both converging on ZERO tagged defaults, worse than the pre-#73 order (which at least
    // converged on a single winner). Snapshotting first keeps the #73 fix's "worst case is two
    // defaults, never zero" property while closing this race: this request's own view of
    // "previous" can no longer include a default a concurrent request tags after this read.
    const agent = makeAgent({
      didState: { state: 'finished', did: CREATED_DID, didDocument: { id: CREATED_DID } },
    })
    const newRecord = makeDidRecordFake('rec-new')
    const oldRecord = makeDidRecordFake('rec-old')
    agent._knownRecords.set(newRecord.id, newRecord)
    agent._knownRecords.set(oldRecord.id, oldRecord)
    agent._didRepository.findCreatedDid = jest.fn(async () => newRecord) as jest.Mock
    agent._didRepository.findByQuery = jest.fn(async () => [oldRecord]) as jest.Mock
    const controller = new DidController()

    await controller.writeDid(makeRequest(agent), indicioNonEndorserOptions())

    const findByQueryOrder = (agent._didRepository.findByQuery as jest.Mock).mock.invocationCallOrder[0]
    const updateCalls = (agent._didRepository.updateByIdWithLock as jest.Mock).mock.calls as Array<[unknown, string]>
    const tagNewRecordCallIndex = updateCalls.findIndex(([, id]) => id === newRecord.id)
    const tagNewRecordOrder = (agent._didRepository.updateByIdWithLock as jest.Mock).mock.invocationCallOrder[
      tagNewRecordCallIndex
    ]
    expect(findByQueryOrder).toBeLessThan(tagNewRecordOrder)
  })

  it('does not re-clear the new default DID itself if it already appears in the previous-defaults query', async () => {
    const agent = makeAgent({
      didState: { state: 'finished', did: CREATED_DID, didDocument: { id: CREATED_DID } },
    })
    const newRecord = makeDidRecordFake('rec-new')
    agent._knownRecords.set(newRecord.id, newRecord)
    agent._didRepository.findCreatedDid = jest.fn(async () => newRecord) as jest.Mock
    agent._didRepository.findByQuery = jest.fn(async () => [newRecord]) as jest.Mock
    const controller = new DidController()

    await controller.writeDid(makeRequest(agent), indicioNonEndorserOptions())

    // Only the final `true` — no spurious `false` clear-then-set on the same record, and only one
    // updateByIdWithLock call for it (not one for the "clear" plus one for the "set").
    expect(newRecord.setTag).toHaveBeenCalledTimes(1)
    expect(newRecord.setTag).toHaveBeenCalledWith('isDefault', true)
    expect(agent._didRepository.updateByIdWithLock).toHaveBeenCalledTimes(1)
  })

  it('logs a warning instead of failing the request when no DidRecord exists yet for the created did', async () => {
    const agent = makeAgent({
      didState: { state: 'finished', did: CREATED_DID, didDocument: { id: CREATED_DID } },
    })
    agent._didRepository.findCreatedDid = jest.fn(async () => null) as jest.Mock
    const controller = new DidController()

    const result = await controller.writeDid(makeRequest(agent), indicioNonEndorserOptions())

    // isDefaultSet: false -- #75 review: isDefault was explicitly requested but the bookkeeping
    // couldn't happen, so the response must say so rather than silently looking identical to a
    // request that succeeded.
    expect(result).toEqual({
      didState: { state: 'finished', did: CREATED_DID, didDocument: { id: CREATED_DID } },
      isDefaultSet: false,
    })
    expect(agent._didRepository.updateByIdWithLock).not.toHaveBeenCalled()
    expect(mockRootAgent.config.logger.warn).toHaveBeenCalledWith(expect.stringContaining('isDefault bookkeeping'))
  })

  it('does not fail the request when no did can be determined at all — logs a warning instead, DID creation already succeeded', async () => {
    // Neither a top-level `did` nor a `didState.did` — a genuinely malformed registrar response.
    // Even so, the DID itself (for did:indy, already a ledger NYM) was created successfully —
    // only the isDefault bookkeeping couldn't happen, and that must not turn into a 500.
    const agent = makeAgent({ didState: { state: 'finished' } })
    const controller = new DidController()

    const result = await controller.writeDid(makeRequest(agent), indicioNonEndorserOptions())

    expect(result).toEqual({ didState: { state: 'finished' }, isDefaultSet: false })
    expect(agent._didRepository.findCreatedDid).not.toHaveBeenCalled()
    expect(mockRootAgent.config.logger.warn).toHaveBeenCalledWith(expect.stringContaining('isDefault bookkeeping'))
  })

  it('does not fail the request when the bookkeeping storage write itself throws — the DID was already created successfully', async () => {
    // A concrete instance of the same principle: a real storage/Askar failure (not a malformed
    // registrar response) writing the tag must not discard an already-successful, non-idempotent
    // DID creation and prompt a client retry that anchors a second orphaned DID.
    const agent = makeAgent({
      didState: { state: 'finished', did: CREATED_DID, didDocument: { id: CREATED_DID } },
    })
    const newRecord = makeDidRecordFake('rec-new')
    agent._knownRecords.set(newRecord.id, newRecord)
    agent._didRepository.findCreatedDid = jest.fn(async () => newRecord) as jest.Mock
    agent._didRepository.updateByIdWithLock = jest.fn(async () => {
      throw new Error('simulated Askar session failure')
    }) as jest.Mock
    const controller = new DidController()

    const result = await controller.writeDid(makeRequest(agent), indicioNonEndorserOptions())

    expect(result).toEqual({
      didState: { state: 'finished', did: CREATED_DID, didDocument: { id: CREATED_DID } },
      isDefaultSet: false,
    })
    expect(mockRootAgent.config.logger.warn).toHaveBeenCalledWith(expect.stringContaining('isDefault bookkeeping'))
  })

  it('does not touch the did repository at all when isDefault is not requested', async () => {
    const agent = makeAgent({
      didState: { state: 'finished', did: CREATED_DID, didDocument: { id: CREATED_DID } },
    })
    const controller = new DidController()

    const result = await controller.writeDid(makeRequest(agent), indicioNonEndorserOptions({ isDefault: false }))

    expect(agent._didRepository.findCreatedDid).not.toHaveBeenCalled()
    expect(agent._didRepository.findByQuery).not.toHaveBeenCalled()
    expect(agent._didRepository.updateByIdWithLock).not.toHaveBeenCalled()
    // isDefaultSet must be absent (not even `undefined` as an own key), not just falsy -- existing
    // callers that never use isDefault must see no shape change at all from this fix.
    expect(result).not.toHaveProperty('isDefaultSet')
  })
})
