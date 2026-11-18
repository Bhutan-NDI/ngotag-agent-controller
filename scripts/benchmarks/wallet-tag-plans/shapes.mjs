// The wallet queries Credo 0.6.2 issues on hot paths, copied from the installed sources, with the
// manifest samples that make each one match exactly one record (or none, for the miss cases).
import { DidRecord } from '@credo-ts/core'
import {
  DidCommConnectionRecord,
  DidCommMessageRecord,
  DidCommOutOfBandRecord,
  DidCommProofExchangeRecord,
} from '@credo-ts/didcomm'
import { TenantRoutingRecord } from '@credo-ts/tenants'

import { BIG_PROFILE, ROOT_PROFILE } from './fixture.mjs'

const pick = (list, i) => list[i % list.length]

export function shapes(manifest, profile = BIG_PROFILE) {
  const { proofs, connections } = manifest.profiles[profile].samples
  return [
    {
      // DidCommConnectionRepository.findByDids: every inbound message on a connection.
      name: 'connection-by-dids (OR3 of AND2)',
      recordClass: DidCommConnectionRecord,
      profile,
      single: true,
      query: (i) => {
        const { ourDid, theirDid } = pick(connections, i)
        return {
          $or: [
            { did: ourDid, theirDid },
            { did: ourDid, previousTheirDids: [theirDid] },
            { previousDids: [ourDid], theirDid },
          ],
        }
      },
      expected: 1,
    },
    {
      // DidCommEnvelopeService: an inbound key the KMS does not hold (OOB invitation key).
      name: 'oob-by-recipient-key (OR2 of AND2)',
      recordClass: DidCommOutOfBandRecord,
      profile,
      single: true,
      query: (i) => {
        const { invitationKey } = pick(proofs, i)
        return {
          $or: [
            { role: 'sender', recipientKeyFingerprints: [invitationKey] },
            { role: 'receiver', recipientRoutingKeyFingerprint: invitationKey },
          ],
        }
      },
      expected: 1,
    },
    {
      // DidRepository.findCreatedDid: DID resolution of a DID this agent created.
      name: 'created-did (AND1 + OR2)',
      recordClass: DidRecord,
      profile,
      single: true,
      query: (i) => {
        const { invitationDid } = pick(proofs, i)
        return { $or: [{ alternativeDids: [invitationDid] }, { did: invitationDid }], role: 'created' }
      },
      expected: 1,
    },
    {
      // DidRepository.findAllByDid: peer DID (numalgo 1 / short-form 4) resolution.
      name: 'all-by-did (OR2)',
      recordClass: DidRecord,
      profile,
      single: false,
      query: (i) => {
        const { ourDid } = pick(connections, i)
        return { $or: [{ alternativeDids: [ourDid] }, { did: ourDid }] }
      },
      expected: 1,
    },
    {
      // DidRepository.findCreatedDidByRecipientKey: inbound message key -> our DID.
      name: 'created-did-by-key (AND2)',
      recordClass: DidRecord,
      profile,
      single: true,
      query: (i) => ({ recipientKeyFingerprints: [pick(connections, i).ourKey], role: 'created' }),
      expected: 1,
    },
    {
      // DidCommMessageRepository.findAgentMessage: proof/credential protocol steps.
      name: 'agent-message (AND5)',
      recordClass: DidCommMessageRecord,
      profile,
      single: true,
      query: (i) => ({
        associatedRecordId: pick(proofs, i).proofId,
        messageName: 'request-presentation',
        protocolName: 'present-proof',
        protocolMajorVersion: '2',
        role: 'sender',
      }),
      expected: 1,
    },
    {
      // DidCommMessageRepository.saveOrUpdateAgentMessage lookup (no role).
      name: 'agent-message-any-role (AND4)',
      recordClass: DidCommMessageRecord,
      profile,
      single: true,
      query: (i) => ({
        associatedRecordId: pick(proofs, i).proofId,
        messageName: 'request-presentation',
        protocolName: 'present-proof',
        protocolMajorVersion: '2',
      }),
      expected: 1,
    },
    {
      // DidCommOutOfBandService.findByCreatedInvitationId.
      name: 'oob-by-invitation (AND3)',
      recordClass: DidCommOutOfBandRecord,
      profile,
      single: true,
      query: (i) => {
        const { invitationId } = pick(proofs, i)
        return { invitationId, role: 'sender', threadId: invitationId }
      },
      expected: 1,
    },
    {
      // DidCommBaseProofProtocol.findByProperties for a connectionless exchange: every inbound
      // presentation. Askar emits object keys sorted, so `role` leads `threadId`.
      name: 'proof-by-thread-and-role (AND2)',
      recordClass: DidCommProofExchangeRecord,
      profile,
      single: true,
      query: (i) => ({ connectionId: undefined, threadId: pick(proofs, i).threadId, role: 'verifier' }),
      expected: 1,
    },
    {
      // DidCommProofExchangeRepository.getByThreadAndConnectionId, connectionless.
      name: 'proof-by-thread (AND1)',
      recordClass: DidCommProofExchangeRecord,
      profile,
      single: true,
      query: (i) => ({ threadId: pick(proofs, i).threadId, connectionId: undefined }),
      expected: 1,
    },
    {
      // TenantRoutingRepository.findByRecipientKey: every inbound message to a shared agent.
      name: 'tenant-routing-by-key (AND1, root)',
      recordClass: TenantRoutingRecord,
      profile: ROOT_PROFILE,
      single: true,
      query: (i) => ({ recipientKeyFingerprint: pick(proofs, i).invitationKey }),
      expected: 1,
    },
  ]
}
