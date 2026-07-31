/**
 * Single source of truth for which record states the purge is allowed to touch.
 *
 * Ported from the validated `credo-data-purge` batch tool (`src/states.ts`), which remains the
 * source of truth for purge semantics — see INTEGRATION-PLAN-develop.md §4.2 / §6. Keep the two
 * in sync by convention; a shared package is only worth extracting once both repos sit on the
 * same Credo minor.
 *
 * Every state here is written as a Credo enum member rather than a string literal, so a Credo
 * upgrade that renames or removes a state fails the build instead of silently producing a list
 * that matches nothing (which would make the purge a no-op) or, worse, matches the wrong thing.
 * The non-terminal lists are *derived* by exclusion, so a Credo upgrade that adds a new state
 * automatically classifies it as non-terminal — i.e. fails safe (never purged by the default path).
 */
import { DidCommCredentialState, DidCommOutOfBandState, DidCommProofState } from '@credo-ts/didcomm'
import { OpenId4VcIssuanceSessionState, OpenId4VcVerificationSessionState } from '@credo-ts/openid4vc'

/**
 * Terminal DIDComm exchange states — a completed/closed flow. Only these are purged by TTL.
 * Identical for credentials and proofs in Credo 0.6.x, but kept as two lists so a future
 * divergence in either enum is a compile error rather than a silent mismatch.
 */
export const DIDCOMM_CREDENTIAL_TERMINAL_STATES: string[] = [
  DidCommCredentialState.Done,
  DidCommCredentialState.Abandoned,
  DidCommCredentialState.Declined,
]

export const DIDCOMM_PROOF_TERMINAL_STATES: string[] = [
  DidCommProofState.Done,
  DidCommProofState.Abandoned,
  DidCommProofState.Declined,
]

/**
 * Non-terminal credential states. Exported for the safety guard and its regression test ONLY —
 * the purge path must never query these.
 *
 * Credential stale-incomplete purge is intentionally impossible, not merely disabled: a holder can
 * still be sitting on a pending offer (`offer-received`) in their wallet and accept it after any
 * TTL. Deleting the issuer-side exchange record while the holder's record lives breaks issuance
 * with no recovery path other than a brand-new offer — unacceptable for a national identity
 * credential.
 */
export const DIDCOMM_CREDENTIAL_NON_TERMINAL_STATES: string[] = Object.values(DidCommCredentialState).filter(
  (state) => !DIDCOMM_CREDENTIAL_TERMINAL_STATES.includes(state),
)

/**
 * Non-terminal proof states — purged only under the opt-in stale-proof policy, against a
 * separate and more conservative TTL (see `PURGE_CRON_STALE_PROOF_TTL_SECONDS`).
 *
 * Stale proof exchanges are safe to purge where stale credentials are not: a holder that responds
 * to a deleted proof request gets an error and the verifier simply re-requests. No credential data
 * is at risk.
 */
export const DIDCOMM_PROOF_NON_TERMINAL_STATES: string[] = Object.values(DidCommProofState).filter(
  (state) => !DIDCOMM_PROOF_TERMINAL_STATES.includes(state),
)

/**
 * OOB purge tracks (INTEGRATION-PLAN-develop.md §4.2, mirroring `credo-data-purge` `purgeOob`):
 *
 *   `done`           — terminal, any reusability             → purge past TTL
 *   `await-response` — non-reusable only                     → purge past TTL
 *   `await-response` — reusable                              → RETAIN (live invitation URL)
 *   `initial` / `prepare-response`                           → RETAIN (in-flight)
 *
 * A reusable `await-response` record backs an invitation URL that may be printed, embedded in a
 * QR code, or published; deleting it breaks every future scan of that invitation.
 */
export const DIDCOMM_OOB_PURGEABLE_STATES = {
  terminal: DidCommOutOfBandState.Done as string,
  stuck: DidCommOutOfBandState.AwaitResponse as string,
}

/**
 * Terminal OID4VC session states. The plan only spells out DIDComm state-awareness, but the same
 * hazard applies: purging by age alone deletes issuance sessions whose holder has not yet
 * completed the flow, and verification sessions still awaiting a response.
 */
export const OID4VC_ISSUANCE_TERMINAL_STATES: string[] = [
  OpenId4VcIssuanceSessionState.Completed,
  OpenId4VcIssuanceSessionState.Error,
]

export const OID4VC_VERIFICATION_TERMINAL_STATES: string[] = [
  OpenId4VcVerificationSessionState.ResponseVerified,
  OpenId4VcVerificationSessionState.Error,
]

/**
 * Record types the purge must NEVER delete, documented here so the omission reads as a decision
 * rather than an oversight:
 *
 *   `DidCommConnectionRecord` — a live relationship with a holder. Deleting it orphans every
 *                              credential the holder still holds and breaks all future DIDComm.
 *   `W3cCredentialRecord`     — the stored credential itself.
 *   `AnonCredsCredentialRecord`
 *   `SdJwtVcRecord` / `MdocRecord`
 *
 * The last three are what the pre-fix protocol-level delete destroyed as a side effect; see
 * `PurgeDeleteRecord.ts`.
 */
export const NEVER_PURGED_RECORD_TYPES: readonly string[] = [
  'ConnectionRecord',
  'W3cCredentialRecord',
  'AnonCredsCredentialRecord',
  'SdJwtVcRecord',
  'MdocRecord',
]
