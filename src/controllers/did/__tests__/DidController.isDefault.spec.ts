/**
 * Regression tests for writeDid's isDefault handling — specifically the #75 review finding that
 * handleIndicio's non-endorser branch (role !== 'endorser', an endorserDid supplied instead)
 * returns the raw registrar result (`{ didState: { did, didDocument, state }, ... }`), not a
 * normalized `{ did, didDocument }` like every other handler branch (handleBcovrin's equivalent
 * branch included). A plain `didRes.did` read is therefore undefined for this one path, so
 * `isDefault: true` was silently dropped: the request still returned 200, but no GenericRecord
 * was ever written, and the caller had no way to know their isDefault flag was ignored.
 *
 * Fix: writeDid falls back to `didRes.didState?.did` when `didRes.did` is absent, and throws
 * InternalServerError if isDefault was requested but neither yields a did — fail loudly rather
 * than silently no-op.
 *
 * Runs under Jest's ESM mode, mirroring DidController.polygon.spec.ts / DidController.ethereum
 * .spec.ts: tsyringe and cliAgent are mocked so constructing the controller doesn't require a real
 * DI container / agent spin-up. Unlike those two spec files (which call a public handleX method
 * directly), this one goes through the public writeDid entrypoint itself, since the bug is in
 * writeDid's own createdDid-resolution logic, not in handleIndicio.
 */
import { jest } from '@jest/globals'

const noopDecorator = () => () => {}

const mockRootAgent = { config: { logger: { info: jest.fn() } } }

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
const { InternalServerError } = await import('../../../errors')

const SEED = 'a'.repeat(32)
const ENDORSER_DID = 'did:indy:indicio:testnet:endorser123'
const CREATED_DID = 'did:indy:indicio:testnet:created456'

// createEndorserDid (invoked by handleIndicio's non-endorser branch) calls agent.dids.create and
// returns the raw registrar result unmodified — no top-level `did`, only `didState.did`.
const makeAgent = (createResult: unknown) => ({
  dids: { create: jest.fn(async () => createResult) as jest.Mock },
  genericRecords: {
    findAllByQuery: jest.fn(async () => []) as jest.Mock,
    save: jest.fn(async () => undefined) as jest.Mock,
    update: jest.fn(async () => undefined) as jest.Mock,
  },
})

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
  it('writes the GenericRecord using didState.did when the branch returns a raw registrar result with no top-level did', async () => {
    const agent = makeAgent({
      didState: { state: 'finished', did: CREATED_DID, didDocument: { id: CREATED_DID } },
    })
    const controller = new DidController()

    await controller.writeDid(makeRequest(agent), indicioNonEndorserOptions())

    expect(agent.genericRecords.save).toHaveBeenCalledWith({
      content: { did: CREATED_DID },
      tags: { isDefaultDid: 'true' },
    })
  })

  it('updates an existing default-DID GenericRecord (not create a second one) via the didState.did fallback', async () => {
    const agent = makeAgent({
      didState: { state: 'finished', did: CREATED_DID, didDocument: { id: CREATED_DID } },
    })
    const existingDefault = { content: { did: 'did:indy:indicio:testnet:old' } }
    agent.genericRecords.findAllByQuery = jest.fn(async () => [existingDefault]) as jest.Mock
    const controller = new DidController()

    await controller.writeDid(makeRequest(agent), indicioNonEndorserOptions())

    expect(agent.genericRecords.update).toHaveBeenCalledWith(existingDefault)
    expect(existingDefault.content.did).toBe(CREATED_DID)
    expect(agent.genericRecords.save).not.toHaveBeenCalled()
  })

  it('fails loudly with InternalServerError when isDefault was requested but no did can be determined at all', async () => {
    // Neither a top-level `did` nor a `didState.did` — a genuinely malformed registrar response.
    const agent = makeAgent({ didState: { state: 'finished' } })
    const controller = new DidController()

    await expect(controller.writeDid(makeRequest(agent), indicioNonEndorserOptions())).rejects.toBeInstanceOf(
      InternalServerError,
    )
    expect(agent.genericRecords.save).not.toHaveBeenCalled()
    expect(agent.genericRecords.update).not.toHaveBeenCalled()
  })

  it('does not touch genericRecords at all when isDefault is not requested', async () => {
    const agent = makeAgent({
      didState: { state: 'finished', did: CREATED_DID, didDocument: { id: CREATED_DID } },
    })
    const controller = new DidController()

    await controller.writeDid(makeRequest(agent), indicioNonEndorserOptions({ isDefault: false }))

    expect(agent.genericRecords.save).not.toHaveBeenCalled()
    expect(agent.genericRecords.update).not.toHaveBeenCalled()
  })
})
