import type { PurgeConfig } from '../purge/PurgeTypes'
import type { AgentContext } from '@credo-ts/core'
import type {
  DidCommMessage,
  DidCommProofProtocol,
  DidCommProofExchangeRecord,
  DidCommProofsApi,
  DidCommConnectionsApi,
  RequestProofOptions,
} from '@credo-ts/didcomm'

import {
  DidCommMessageRepository,
  DidCommMessageRole,
  DidCommMessageSender,
  DidCommProofExchangeRepository,
  getOutboundDidCommMessageContext,
} from '@credo-ts/didcomm'

import { BadRequestError } from '../errors'
import { PurgeRecordType, buildPurgeConfig, parsePositiveInt } from '../purge/PurgeTypes'

/**
 * Proof-request expiry (RFC 0032 `~timing.expires_time`).
 *
 * Both proof request endpoints take an optional `expiresInSeconds` (or the deployment default) and
 * stamp the resulting absolute deadline before sending.
 *
 * Credo 0.6.2 has no option for this. The OOB path gets the message back from
 * `proofs.createRequest()` before it is sent, so the timing can be stamped there. The
 * connection-based `proofs.requestProof()` builds AND sends internally, so it is reproduced here
 * from Credo's public exports (`DidCommProofsApi.mjs` `requestProof`) with the stamp inserted
 * before the send. Remove once upstream accepts an expiry option on `requestProof`.
 */

/**
 * Sets `~timing.expires_time` on an outgoing request message and re-saves the stored copy.
 *
 * The proof format coordinator persists the request message inside `createRequest`, before the
 * caller sees it, so stamping only the in-memory message would send the expiry but leave
 * `findRequestMessage()` returning a copy without it.
 */
export const stampExpiry = async (
  agentContext: AgentContext,
  message: DidCommMessage,
  proofRecordId: string,
  expiresTime: Date,
) => {
  message.setTiming({ expiresTime })
  await agentContext.dependencyManager.resolve(DidCommMessageRepository).saveOrUpdateAgentMessage(agentContext, {
    agentMessage: message,
    role: DidCommMessageRole.Sender,
    associatedRecordId: proofRecordId,
  })
}

/*
 * Deployment default and bounds for `expiresInSeconds`.
 *
 * - DIDCOMM_PROOF_REQUEST_EXPIRY is the deployment default: 1800 s in PROD/STAGE, 300 s in QA/dev.
 * - Minimum 300 s: delivery time plus a person reading the request.
 * - Maximum: a request must expire before any purge can delete its proof exchange, or the holder
 *   never gets the problem-report. Each enabled purge that deletes in-flight proof exchanges caps it
 *   at its TTL minus a margin: the cron stale-proof sweep (PURGE_CRON_ABANDONED_TTL_SECONDS) and the
 *   state-blind NATS purge (PURGE_NATS_TTL_SECONDS). A fixed 7-day ceiling always applies too, so
 *   a purge can only lower the maximum; the tightest cap wins.
 */
export const DIDCOMM_PROOF_REQUEST_EXPIRY_ENV = 'DIDCOMM_PROOF_REQUEST_EXPIRY'
export const DEFAULT_PROOF_REQUEST_EXPIRY_SECONDS = 1_800
export const MIN_PROOF_REQUEST_EXPIRY_SECONDS = 300
export const MAX_PROOF_REQUEST_EXPIRY_SECONDS = 7 * 24 * 60 * 60
// TODO: placeholder margin below the purge TTLs, pending confirmation.
export const PURGE_CEILING_MARGIN_SECONDS = 60 * 60

/** Record metadata key holding the absolute deadline, for the verifier-side expiry job. */
export const PROOF_REQUEST_EXPIRY_METADATA_KEY = 'proofRequestExpiry'

export interface ProofRequestExpiryCeiling {
  seconds: number
  /** The setting that imposes `seconds`, so errors point operators at the right knob. */
  source: string
}

export interface ProofRequestExpiryConfig {
  defaultSeconds: number
  maxSeconds: number
  ceilingSource: string
}

/** The tightest of the fixed 7-day ceiling and the enabled purges that delete in-flight proof exchanges. */
export const resolveProofRequestExpiryCeiling = (purgeConfig?: PurgeConfig): ProofRequestExpiryCeiling => {
  const ceilings: ProofRequestExpiryCeiling[] = [
    { seconds: MAX_PROOF_REQUEST_EXPIRY_SECONDS, source: 'the fixed 7-day ceiling' },
  ]
  const purgeCeiling = (envKey: string, ttlSeconds: number) => ({
    seconds: ttlSeconds - PURGE_CEILING_MARGIN_SECONDS,
    source: `${envKey}=${ttlSeconds} minus the ${PURGE_CEILING_MARGIN_SECONDS}s margin`,
  })

  if (purgeConfig) {
    const { cronConfig, natsConfig } = purgeConfig
    if (
      cronConfig.enabled &&
      cronConfig.staleProofEnabled &&
      cronConfig.recordTypes.includes(PurgeRecordType.DIDCOMM_PROOF)
    ) {
      ceilings.push(purgeCeiling('PURGE_CRON_ABANDONED_TTL_SECONDS', cronConfig.abandonedTtlSeconds))
    }
    if (natsConfig.enabled && natsConfig.recordTypes.includes(PurgeRecordType.DIDCOMM_PROOF)) {
      ceilings.push(purgeCeiling('PURGE_NATS_TTL_SECONDS', natsConfig.ttlSeconds))
    }
  }

  return ceilings.reduce((tightest, ceiling) => (ceiling.seconds < tightest.seconds ? ceiling : tightest))
}

/**
 * Reads the deployment default and the ceiling from the environment. Throws when the default is
 * not a positive integer or falls outside [MIN, max], or when the purge settings leave no valid
 * expiry at all, so a bad deployment fails at startup instead of on the first request.
 */
export const resolveProofRequestExpiryConfig = (): ProofRequestExpiryConfig => {
  let defaultSeconds: number
  try {
    defaultSeconds = parsePositiveInt(
      process.env[DIDCOMM_PROOF_REQUEST_EXPIRY_ENV],
      DIDCOMM_PROOF_REQUEST_EXPIRY_ENV,
      DEFAULT_PROOF_REQUEST_EXPIRY_SECONDS,
    )
  } catch {
    throw new Error(
      `${DIDCOMM_PROOF_REQUEST_EXPIRY_ENV} must be a positive integer number of seconds, got: "${process.env[DIDCOMM_PROOF_REQUEST_EXPIRY_ENV]}"`,
    )
  }

  const ceiling = resolveProofRequestExpiryCeiling(buildPurgeConfig())
  if (ceiling.seconds < MIN_PROOF_REQUEST_EXPIRY_SECONDS) {
    throw new Error(
      `Proof request expiry ceiling is ${ceiling.seconds}s (${ceiling.source}), below the ` +
        `${MIN_PROOF_REQUEST_EXPIRY_SECONDS}s minimum, so no request could be sent. Raise the purge TTL to at least ` +
        `${MIN_PROOF_REQUEST_EXPIRY_SECONDS + PURGE_CEILING_MARGIN_SECONDS}s.`,
    )
  }
  if (defaultSeconds < MIN_PROOF_REQUEST_EXPIRY_SECONDS || defaultSeconds > ceiling.seconds) {
    throw new Error(
      `${DIDCOMM_PROOF_REQUEST_EXPIRY_ENV}=${defaultSeconds} is out of bounds: it must be between ` +
        `${MIN_PROOF_REQUEST_EXPIRY_SECONDS} and ${ceiling.seconds} seconds (${ceiling.source}).`,
    )
  }
  return { defaultSeconds, maxSeconds: ceiling.seconds, ceilingSource: ceiling.source }
}

let cachedConfig: ProofRequestExpiryConfig | undefined

/** The resolved config, read from the environment once. Called at startup so a bad value fails fast. */
export const getProofRequestExpiryConfig = (): ProofRequestExpiryConfig => {
  cachedConfig ??= resolveProofRequestExpiryConfig()
  return cachedConfig
}

/** Testing only: forget the cached config so the next call re-reads the environment. */
export const resetProofRequestExpiryConfig = () => {
  cachedConfig = undefined
}

/**
 * Validates a caller-supplied `expiresInSeconds`; missing or null means the deployment default.
 * Anything else that is not a whole number within bounds is rejected, never clamped, because
 * clamping hides caller bugs.
 */
export const parseExpiresInSeconds = (value: unknown, config: ProofRequestExpiryConfig): number => {
  if (value === undefined || value === null) return config.defaultSeconds
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new BadRequestError('expiresInSeconds must be a whole number of seconds')
  }
  if (value < MIN_PROOF_REQUEST_EXPIRY_SECONDS || value > config.maxSeconds) {
    throw new BadRequestError(
      `expiresInSeconds must be between ${MIN_PROOF_REQUEST_EXPIRY_SECONDS} and ${config.maxSeconds} seconds`,
    )
  }
  return value
}

/**
 * The absolute deadline for a proof request: the caller's `expiresInSeconds` (validated by
 * `parseExpiresInSeconds`) or the deployment default, counted from now.
 */
export const resolveProofRequestExpiresTime = (expiresInSeconds: unknown): Date => {
  const seconds = parseExpiresInSeconds(expiresInSeconds, getProofRequestExpiryConfig())
  return new Date(Date.now() + seconds * 1000)
}

/**
 * Stamps `~timing.expires_time` on the request (see `stampExpiry`) and stores the absolute
 * deadline in the proof record's metadata as `expiresAt`, so a verifier-side job can find expired
 * requests without reading every message.
 *
 * Both records are already persisted inside `createRequest`, so neither write can be folded into
 * Credo's own saves without patching it. They touch different records, so they run concurrently.
 */
export const applyProofRequestExpiry = async (
  agentContext: AgentContext,
  message: DidCommMessage,
  proofRecord: DidCommProofExchangeRecord,
  expiresTime: Date,
) => {
  proofRecord.metadata.set(PROOF_REQUEST_EXPIRY_METADATA_KEY, { expiresAt: expiresTime.toISOString() })
  await Promise.all([
    stampExpiry(agentContext, message, proofRecord.id, expiresTime),
    agentContext.dependencyManager.resolve(DidCommProofExchangeRepository).update(agentContext, proofRecord),
  ])
}

interface ProofRequestAgent {
  context: AgentContext
  modules: { didcomm: { proofs: DidCommProofsApi<DidCommProofProtocol[]>; connections: DidCommConnectionsApi } }
}

/**
 * `proofs.requestProof()` with the expiry applied (see `applyProofRequestExpiry`) before the request
 * is sent over the connection.
 */
export const requestProofWithExpiry = async (
  agent: ProofRequestAgent,
  options: RequestProofOptions<DidCommProofProtocol[]>,
  expiresTime: Date,
): Promise<DidCommProofExchangeRecord> => {
  const { proofs, connections } = agent.modules.didcomm
  const agentContext = agent.context

  const connectionRecord = await connections.getById(options.connectionId)
  connectionRecord.assertReady()

  const protocol = proofs.config.proofProtocols.find((p: DidCommProofProtocol) => p.version === options.protocolVersion)
  if (!protocol) {
    throw new BadRequestError(`No proof protocol registered for protocol version ${options.protocolVersion}`)
  }

  const { message, proofRecord } = await protocol.createRequest(agentContext, {
    connectionRecord,
    proofFormats: options.proofFormats,
    autoAcceptProof: options.autoAcceptProof,
    parentThreadId: options.parentThreadId,
    comment: options.comment,
    goalCode: options.goalCode,
    goal: options.goal,
    willConfirm: options.willConfirm,
  })

  await applyProofRequestExpiry(agentContext, message, proofRecord, expiresTime)

  const outboundMessageContext = await getOutboundDidCommMessageContext(agentContext, {
    message,
    associatedRecord: proofRecord,
    connectionRecord,
  })
  await agentContext.dependencyManager.resolve(DidCommMessageSender).sendMessage(outboundMessageContext)

  return proofRecord
}
