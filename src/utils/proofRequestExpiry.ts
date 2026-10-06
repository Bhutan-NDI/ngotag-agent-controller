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
  getOutboundDidCommMessageContext,
} from '@credo-ts/didcomm'

import { BadRequestError } from '../errors'

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

/** Parses an ISO-8601 `expiresTime`; undefined when absent. Must be a valid instant in the future. */
export const parseExpiresTime = (value?: string): Date | undefined => {
  if (value === undefined || value === null || value === '') return undefined
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
