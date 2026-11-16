import type { AgentContext } from '@credo-ts/core'
import type { DidCommProofFormatProcessPresentationOptions } from '@credo-ts/didcomm'

import { DidCommDifPresentationExchangeProofFormatService } from '@credo-ts/didcomm'

export enum HolderBindingMode {
  OFF = 'off',
  WARN = 'warn',
  ENFORCE = 'enforce',
}

const ANONCREDS_DATA_INTEGRITY_CRYPTOSUITE = 'anoncreds-2023'

/** HOLDER_BINDING_CHECK: off | warn (default) | enforce. */
export function getHolderBindingMode(): HolderBindingMode {
  const value = process.env.HOLDER_BINDING_CHECK?.trim().toLowerCase()
  return Object.values(HolderBindingMode).includes(value as HolderBindingMode)
    ? (value as HolderBindingMode)
    : HolderBindingMode.WARN
}

const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : value === undefined ? [] : [value])

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

// AnonCreds credentials bind to the holder's link secret, not to a subject DID.
const isAnonCredsDataIntegrity = (credential: Record<string, unknown>) =>
  asArray(credential.proof).some(
    (proof) => isRecord(proof) && proof.cryptosuite === ANONCREDS_DATA_INTEGRITY_CRYPTOSUITE,
  )

/**
 * Returns why a JSON-LD presentation is not bound to its credentials' subjects, or undefined if it is: every
 * credential subject must be a DID that signed the presentation. JWT presentations are not checked.
 */
export function findHolderBindingMismatch(presentation: unknown): string | undefined {
  if (!isRecord(presentation)) return undefined

  const signers = new Set(
    asArray(presentation.proof)
      .map((proof) => (isRecord(proof) && typeof proof.verificationMethod === 'string' ? proof.verificationMethod : ''))
      .map((verificationMethod) => verificationMethod.split('#')[0])
      .filter(Boolean),
  )

  for (const [index, credential] of asArray(presentation.verifiableCredential).entries()) {
    if (!isRecord(credential)) return `credential ${index} is not a JSON-LD credential`
    if (isAnonCredsDataIntegrity(credential)) continue
    for (const subject of asArray(credential.credentialSubject)) {
      if (!isRecord(subject) || typeof subject.id !== 'string') return `credential ${index} has no subject DID`
      if (!signers.has(subject.id)) return `credential ${index} was not issued to the DID that signed the presentation`
    }
  }
  return undefined
}

/** Credo does not check that a JSON-LD presentation is signed by its credentials' subject. */
export class HolderBoundDifPresentationExchangeProofFormatService extends DidCommDifPresentationExchangeProofFormatService {
  public async processPresentation(
    agentContext: AgentContext,
    options: DidCommProofFormatProcessPresentationOptions,
  ): Promise<boolean> {
    if (!(await super.processPresentation(agentContext, options))) return false

    const mode = getHolderBindingMode()
    if (mode === HolderBindingMode.OFF) return true

    const mismatch = findHolderBindingMismatch(options.attachment.getDataAsJson())
    if (!mismatch) return true

    const enforce = mode === HolderBindingMode.ENFORCE
    agentContext.config.logger.warn(`[holder-binding] ${mismatch}${enforce ? '; presentation rejected' : ''}`, {
      proofRecordId: options.proofRecord.id,
    })
    return !enforce
  }
}
