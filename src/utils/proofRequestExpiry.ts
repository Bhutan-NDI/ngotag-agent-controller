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
import { buildPurgeConfig, parsePositiveInt } from '../purge/PurgeTypes'

/**
 * Proof-request expiry (RFC 0032 `~timing.expires_time`).
 *
 * Credo 0.6.2 has no option for this. The OOB path gets the message back from
 * `proofs.createRequest()` before it is sent, so the timing can be stamped there. The
 * connection-based `proofs.requestProof()` builds AND sends internally, so it is reproduced here
 * from Credo's public exports (`DidCommProofsApi.mjs` `requestProof`) with the stamp inserted
 * before the send. Remove once upstream accepts an expiry option on `requestProof`.
 *
 * Credo does not act on `expires_time` when receiving a message -- it is advisory; the holder
 * wallet must enforce it.
 */

// Full ISO-8601 date-time with a mandatory offset (`Z` or `±HH:MM`). `new Date(value)` alone also
// accepts non-ISO formats (e.g. "12/31/2030") and reads an offset-less date-time as server-local
// time, so the wire value would depend on the pod's timezone.
const ISO_8601_DATE_TIME_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/

/** Parses an ISO-8601 `expiresTime`; undefined when absent. Must be a valid instant in the future. */
export const parseExpiresTime = (value?: string): Date | undefined => {
  if (value === undefined || value === null || value === '') return undefined
  if (!ISO_8601_DATE_TIME_WITH_OFFSET.test(value)) {
    throw new BadRequestError(
      'expiresTime must be an ISO-8601 date-time with an explicit UTC offset (e.g. 2030-01-01T10:00:00Z)',
    )
  }
  const expiresTime = new Date(value)
  if (Number.isNaN(expiresTime.getTime())) {
    throw new BadRequestError('expiresTime must be an ISO-8601 date-time')
  }
  if (expiresTime.getTime() <= Date.now()) {
    throw new BadRequestError('expiresTime must be in the future')
  }
  return expiresTime
}

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

interface ProofRequestAgent {
  context: AgentContext
  modules: { didcomm: { proofs: DidCommProofsApi<any>; connections: DidCommConnectionsApi } }
}

/** `proofs.requestProof()` with an expiry stamped on the request before it is sent. */
export const requestProofWithExpiry = async (
  agent: ProofRequestAgent,
  options: RequestProofOptions<any>,
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

  await stampExpiry(agentContext, message, proofRecord.id, expiresTime)

  const outboundMessageContext = await getOutboundDidCommMessageContext(agentContext, {
    message,
    associatedRecord: proofRecord,
    connectionRecord,
  })
  await agentContext.dependencyManager.resolve(DidCommMessageSender).sendMessage(outboundMessageContext)

  return proofRecord
}

/*
 * Deployment default and bounds for `expiresInSeconds` (phase 2 decision, option c, 2 Oct 2026).
 *
 * - DIDCOMM_PROOF_REQUEST_EXPIRY is the deployment default: 1800 s in PROD/STAGE, 300 s in QA/dev.
 * - Minimum 300 s: delivery time plus a person reading the request.
 * - Maximum: the purge ceiling. While the cron purge sweeps stale proof exchanges, a request must
 *   expire before purge can delete it, or the holder never gets the problem-report. Without that
 *   sweep a fixed 7-day ceiling applies.
 */
export const DIDCOMM_PROOF_REQUEST_EXPIRY_ENV = 'DIDCOMM_PROOF_REQUEST_EXPIRY'
export const DEFAULT_PROOF_REQUEST_EXPIRY_SECONDS = 1_800
export const MIN_PROOF_REQUEST_EXPIRY_SECONDS = 300
export const NO_PURGE_PROOF_REQUEST_EXPIRY_CEILING_SECONDS = 7 * 24 * 60 * 60
// TODO: placeholder margin below PURGE_CRON_ABANDONED_TTL_SECONDS, pending confirmation.
export const PURGE_CEILING_MARGIN_SECONDS = 60 * 60

/** Record metadata key holding the absolute deadline, for the verifier-side (D4) job. */
export const PROOF_REQUEST_EXPIRY_METADATA_KEY = 'proofRequestExpiry'

export interface ProofRequestExpiryConfig {
  defaultSeconds: number
  maxSeconds: number
}

/**
 * Reads the deployment default and the ceiling from the environment. Throws when the default is
 * not a positive integer or falls outside [MIN, max], so a bad deployment fails at startup instead
 * of on the first request.
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

  const cronConfig = buildPurgeConfig()?.cronConfig
  const maxSeconds =
    cronConfig?.enabled && cronConfig.staleProofEnabled
      ? cronConfig.abandonedTtlSeconds - PURGE_CEILING_MARGIN_SECONDS
      : NO_PURGE_PROOF_REQUEST_EXPIRY_CEILING_SECONDS

  if (defaultSeconds < MIN_PROOF_REQUEST_EXPIRY_SECONDS || defaultSeconds > maxSeconds) {
    throw new Error(
      `${DIDCOMM_PROOF_REQUEST_EXPIRY_ENV}=${defaultSeconds} is out of bounds: it must be between ` +
        `${MIN_PROOF_REQUEST_EXPIRY_SECONDS} and ${maxSeconds} seconds (the purge ceiling).`,
    )
  }
  return { defaultSeconds, maxSeconds }
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
 * Stamps `~timing.expires_time` on the request (see `stampExpiry`) and stores the absolute
 * deadline in the proof record's metadata as `expiresAt`, so a verifier-side job can find expired
 * requests without reading every message.
 */
export const applyProofRequestExpiry = async (
  agentContext: AgentContext,
  message: DidCommMessage,
  proofRecord: DidCommProofExchangeRecord,
  expiresTime: Date,
) => {
  await stampExpiry(agentContext, message, proofRecord.id, expiresTime)
  proofRecord.metadata.set(PROOF_REQUEST_EXPIRY_METADATA_KEY, { expiresAt: expiresTime.toISOString() })
  await agentContext.dependencyManager.resolve(DidCommProofExchangeRepository).update(agentContext, proofRecord)
}
