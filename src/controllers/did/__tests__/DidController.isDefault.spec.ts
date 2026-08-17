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
 * Also covers the #75 follow-up finding (kinxa0, 2026-08-17): isDefault is tracked as a tag on the
 * DID's own DidRecord (via DidRepository), not a separate GenericRecord pointer — verified
 * directly against the installed @credo-ts/core/@credo-ts/askar packages that arbitrary DidRecord
 * tags round-trip through save and query. This suite exercises: the didState.did fallback, the
 * previous-default-clearing behavior (fixing the legacy bug where the old default was never
 * cleared), the self-clearing no-op guard, and the same "never 500 an already-successful DID
 * creation over bookkeeping" contract as before (the bookkeeping is wrapped in its own try/catch
 * and only logs a warning on failure; writeDid still returns the real created DID either way).
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
const makeAgent = (createResult: unknown) => {
  const didRepository = {
    findCreatedDid: jest.fn(async () => null) as jest.Mock,
    findByQuery: jest.fn(async () => []) as jest.Mock,
    update: jest.fn(async () => undefined) as jest.Mock,
  }
  return {
    dids: { create: jest.fn(async () => createResult) as jest.Mock },
    dependencyManager: {
      resolve: jest.fn((token: unknown) => (token === DidRepository ? didRepository : undefined)) as jest.Mock,
    },
    context: { contextCorrelationId: 'test-tenant' },
    _didRepository: didRepository,
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
    agent._didRepository.findCreatedDid = jest.fn(async () => newRecord) as jest.Mock
    const controller = new DidController()

    await controller.writeDid(makeRequest(agent), indicioNonEndorserOptions())

    expect(agent._didRepository.findCreatedDid).toHaveBeenCalledWith(agent.context, CREATED_DID)
    expect(newRecord.setTag).toHaveBeenCalledWith('isDefault', true)
    expect(agent._didRepository.update).toHaveBeenCalledWith(agent.context, newRecord)
  })

  it("clears the previous default DID's tag before tagging the newly created one", async () => {
    const agent = makeAgent({
      didState: { state: 'finished', did: CREATED_DID, didDocument: { id: CREATED_DID } },
    })
    const newRecord = makeDidRecordFake('rec-new')
    const oldRecord = makeDidRecordFake('rec-old')
    agent._didRepository.findCreatedDid = jest.fn(async () => newRecord) as jest.Mock
    agent._didRepository.findByQuery = jest.fn(async () => [oldRecord]) as jest.Mock
    const controller = new DidController()

    await controller.writeDid(makeRequest(agent), indicioNonEndorserOptions())

    expect(oldRecord.setTag).toHaveBeenCalledWith('isDefault', false)
    expect(agent._didRepository.update).toHaveBeenCalledWith(agent.context, oldRecord)
    expect(newRecord.setTag).toHaveBeenCalledWith('isDefault', true)
    expect(agent._didRepository.update).toHaveBeenCalledWith(agent.context, newRecord)
  })

  it('does not re-clear the new default DID itself if it already appears in the previous-defaults query', async () => {
    const agent = makeAgent({
      didState: { state: 'finished', did: CREATED_DID, didDocument: { id: CREATED_DID } },
    })
    const newRecord = makeDidRecordFake('rec-new')
    agent._didRepository.findCreatedDid = jest.fn(async () => newRecord) as jest.Mock
    agent._didRepository.findByQuery = jest.fn(async () => [newRecord]) as jest.Mock
    const controller = new DidController()

    await controller.writeDid(makeRequest(agent), indicioNonEndorserOptions())

    // Only the final `true` — no spurious `false` clear-then-set on the same record.
    expect(newRecord.setTag).toHaveBeenCalledTimes(1)
    expect(newRecord.setTag).toHaveBeenCalledWith('isDefault', true)
  })

  it('logs a warning instead of failing the request when no DidRecord exists yet for the created did', async () => {
    const agent = makeAgent({
      didState: { state: 'finished', did: CREATED_DID, didDocument: { id: CREATED_DID } },
    })
    agent._didRepository.findCreatedDid = jest.fn(async () => null) as jest.Mock
    const controller = new DidController()

    const result = await controller.writeDid(makeRequest(agent), indicioNonEndorserOptions())

    expect(result).toEqual({ didState: { state: 'finished', did: CREATED_DID, didDocument: { id: CREATED_DID } } })
    expect(agent._didRepository.update).not.toHaveBeenCalled()
    expect(mockRootAgent.config.logger.warn).toHaveBeenCalledWith(expect.stringContaining('isDefault bookkeeping'))
  })

  it('does not fail the request when no did can be determined at all — logs a warning instead, DID creation already succeeded', async () => {
    // Neither a top-level `did` nor a `didState.did` — a genuinely malformed registrar response.
    // Even so, the DID itself (for did:indy, already a ledger NYM) was created successfully —
    // only the isDefault bookkeeping couldn't happen, and that must not turn into a 500.
    const agent = makeAgent({ didState: { state: 'finished' } })
    const controller = new DidController()

    const result = await controller.writeDid(makeRequest(agent), indicioNonEndorserOptions())

    expect(result).toEqual({ didState: { state: 'finished' } })
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
    agent._didRepository.findCreatedDid = jest.fn(async () => newRecord) as jest.Mock
    agent._didRepository.update = jest.fn(async () => {
      throw new Error('simulated Askar session failure')
    }) as jest.Mock
    const controller = new DidController()

    const result = await controller.writeDid(makeRequest(agent), indicioNonEndorserOptions())

    expect(result).toEqual({ didState: { state: 'finished', did: CREATED_DID, didDocument: { id: CREATED_DID } } })
    expect(mockRootAgent.config.logger.warn).toHaveBeenCalledWith(expect.stringContaining('isDefault bookkeeping'))
  })

  it('does not touch the did repository at all when isDefault is not requested', async () => {
    const agent = makeAgent({
      didState: { state: 'finished', did: CREATED_DID, didDocument: { id: CREATED_DID } },
    })
    const controller = new DidController()

    await controller.writeDid(makeRequest(agent), indicioNonEndorserOptions({ isDefault: false }))

    expect(agent._didRepository.findCreatedDid).not.toHaveBeenCalled()
    expect(agent._didRepository.findByQuery).not.toHaveBeenCalled()
    expect(agent._didRepository.update).not.toHaveBeenCalled()
  })
})
