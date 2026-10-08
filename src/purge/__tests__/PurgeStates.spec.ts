/**
 * Upgrade-safety guard for the purge retention policy.
 *
 * The abandoned-proof sweep is ON by default, so any state it queries is deleted after the abandoned
 * TTL. Deriving that list by exclusion from the Credo enum would fail OPEN: a state introduced by a
 * future Credo release would land in it automatically and become purgeable with nobody having
 * reviewed whether deleting it is safe.
 *
 * These tests force the decision instead. A Credo upgrade that adds a proof or credential state
 * fails the build here until someone classifies it — terminal, abandonable, or neither.
 *
 * Runs under Jest ESM mode (see jest.config.base.ts).
 */
export {} // top-level await requires this file to be a module

const { DidCommCredentialState, DidCommProofState } = await import('@credo-ts/didcomm')
const {
  DIDCOMM_CREDENTIAL_NON_TERMINAL_STATES,
  DIDCOMM_CREDENTIAL_TERMINAL_STATES,
  DIDCOMM_PROOF_ABANDONABLE_STATES,
  DIDCOMM_PROOF_NON_TERMINAL_STATES,
  DIDCOMM_PROOF_TERMINAL_STATES,
} = await import('../PurgeStates')

describe('proof state classification', () => {
  test('every proof state Credo defines is explicitly classified', () => {
    const classified = new Set([...DIDCOMM_PROOF_TERMINAL_STATES, ...DIDCOMM_PROOF_ABANDONABLE_STATES])
    const unclassified = Object.values(DidCommProofState).filter((state) => !classified.has(state))

    // If this fails after a Credo bump, decide deliberately: add the new state to
    // DIDCOMM_PROOF_TERMINAL_STATES (a closed flow, purged at the terminal TTL), to
    // DIDCOMM_PROOF_ABANDONABLE_STATES (a dead flow, purged at the shorter abandoned TTL), or to
    // neither — in which case add it to the exclusion list below with a comment saying why.
    expect(unclassified).toEqual([])
  })

  test('terminal and abandonable are disjoint', () => {
    const overlap = DIDCOMM_PROOF_TERMINAL_STATES.filter((state) => DIDCOMM_PROOF_ABANDONABLE_STATES.includes(state))
    expect(overlap).toEqual([])
  })

  test('the abandonable allowlist is a subset of the derived non-terminal set', () => {
    // Catches a terminal state being pasted into the allowlist by mistake, and keeps the allowlist
    // honest against the enum rather than drifting into free-text.
    for (const state of DIDCOMM_PROOF_ABANDONABLE_STATES) {
      expect(DIDCOMM_PROOF_NON_TERMINAL_STATES).toContain(state)
    }
  })

  test('the allowlist is enumerated, not derived', () => {
    // The engine must read from the explicit list. If someone "simplifies" it back to the derived
    // one these become identical and the upgrade-safety property is silently lost — so assert the
    // two are maintained separately even while their contents currently agree.
    expect(DIDCOMM_PROOF_ABANDONABLE_STATES).not.toBe(DIDCOMM_PROOF_NON_TERMINAL_STATES)
  })
})

describe('credential state classification', () => {
  test('every credential state is either terminal or derived non-terminal', () => {
    const classified = new Set([...DIDCOMM_CREDENTIAL_TERMINAL_STATES, ...DIDCOMM_CREDENTIAL_NON_TERMINAL_STATES])
    const unclassified = Object.values(DidCommCredentialState).filter((state) => !classified.has(state))

    expect(unclassified).toEqual([])
  })

  test('derivation is safe here because the non-terminal list is never queried', () => {
    // Credentials have no abandoned sweep at all — a holder can still accept a pending offer after
    // any TTL, so the issuer-side record is never purged while incomplete. That is why exclusion is
    // acceptable for this list and not for the proof one.
    const overlap = DIDCOMM_CREDENTIAL_TERMINAL_STATES.filter((state) =>
      DIDCOMM_CREDENTIAL_NON_TERMINAL_STATES.includes(state),
    )
    expect(overlap).toEqual([])
  })
})
