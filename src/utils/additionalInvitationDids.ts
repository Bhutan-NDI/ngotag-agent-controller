import type { DidCommOutOfBandRecord } from '@credo-ts/didcomm'
import type { Request } from 'express'

import { DidKey, isDid } from '@credo-ts/core'
import { DidCommDocumentService, DidCommOutOfBandRepository } from '@credo-ts/didcomm'

import { BadRequestError } from '../errors/errors'

type RequestAgent = Request['agent']

export const MAX_ADDITIONAL_INVITATION_DIDS = 3

/**
 * Checks the extra invitation DIDs of a request before anything is created, so a bad request leaves no half-made
 * exchange or invitation behind. Each must be a well-formed DID that this agent created and that resolves to a DIDComm
 * service: an invitation advertising a DID whose keys this agent does not hold, or that has no service, would send
 * holders somewhere they cannot reach.
 */
export const validateAdditionalInvitationDids = async (
  agent: RequestAgent,
  dids: unknown,
  primaryDid?: string,
): Promise<string[]> => {
  if (undefined === dids || null === dids) return []
  if (!Array.isArray(dids) || dids.some((did) => 'string' !== typeof did)) {
    throw new BadRequestError('additionalInvitationDids must be an array of DIDs.')
  }
  if (dids.length > MAX_ADDITIONAL_INVITATION_DIDS) {
    throw new BadRequestError(`additionalInvitationDids can hold at most ${MAX_ADDITIONAL_INVITATION_DIDS} DIDs.`)
  }

  const documentService = agent.dependencyManager.resolve(DidCommDocumentService)
  const seen = new Set<string>(primaryDid ? [primaryDid] : [])
  for (const did of dids as string[]) {
    if (!isDid(did)) {
      throw new BadRequestError(`additionalInvitationDids contains a value that is not a DID: '${did}'.`)
    }
    if (seen.has(did)) {
      throw new BadRequestError(`additionalInvitationDids repeats a DID, or repeats invitationDid: '${did}'.`)
    }
    seen.add(did)
    if (0 === (await agent.dids.getCreatedDids({ did })).length) {
      throw new BadRequestError(`additionalInvitationDids contains a DID this agent did not create: '${did}'.`)
    }
    const services = await documentService.resolveServicesFromDid(agent.context, did).catch(() => [])
    if (0 === services.length) {
      throw new BadRequestError(`additionalInvitationDids contains a DID with no DIDComm service to reach: '${did}'.`)
    }
  }
  return dids as string[]
}

/**
 * Lists extra DIDs as further services of an invitation just created, after its first one, and brings the record in
 * line: the recipient keys it is looked up by, so a connection request addressed to any of the DIDs finds it. Call
 * before the invitation's URL or JSON is built, since both are produced from the invitation as it then stands.
 */
export const addAdditionalInvitationDids = async (
  agent: RequestAgent,
  outOfBandRecord: DidCommOutOfBandRecord,
  dids: string[],
): Promise<void> => {
  if (0 === dids.length) return

  const { outOfBandInvitation } = outOfBandRecord
  // Credo keeps the services private and has no way to add one after creation.
  const services = (outOfBandInvitation as unknown as { services: unknown[] }).services
  services.push(...dids)

  const documentService = agent.dependencyManager.resolve(DidCommDocumentService)
  const fingerprints: string[] = []
  for (const service of outOfBandInvitation.getServices()) {
    if ('string' === typeof service) {
      const resolved = await documentService.resolveServicesFromDid(agent.context, service)
      fingerprints.push(...resolved.flatMap(({ recipientKeys }) => recipientKeys.map((key) => key.fingerprint)))
    } else {
      fingerprints.push(...service.recipientKeys.map((didKey) => DidKey.fromDid(didKey).publicJwk.fingerprint))
    }
  }

  outOfBandRecord.setTag('recipientKeyFingerprints', fingerprints)
  await agent.dependencyManager.resolve(DidCommOutOfBandRepository).update(agent.context, outOfBandRecord)
}
