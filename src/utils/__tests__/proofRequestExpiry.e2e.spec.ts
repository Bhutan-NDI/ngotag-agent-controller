/**
 * Proof request expiry end to end, without patching @credo-ts/didcomm.
 *
 * Two real Askar-backed agents (verifier, holder) connected over HTTP on localhost.
 * - Connection path: `requestProofWithExpiry` reproduces `proofs.requestProof()` from Credo's public
 *   exports with `~timing.expires_time` stamped before the send.
 * - OOB path: `applyProofRequestExpiry` stamps the message returned by `proofs.createRequest()`
 *   before it is embedded in an out-of-band invitation.
 * Both assert the expiry reaches the holder, the verifier keeps exactly one stored request message
 * carrying it, and `expiresAt` is in the proof record metadata. The stock `requestProof()` sends no
 * timing, which is why the helper exists.
 */
import type { BaseEvent } from '@credo-ts/core'
import type { DidCommProofStateChangedEvent, DidCommRequestPresentationV2Message } from '@credo-ts/didcomm'

import { AskarModule } from '@credo-ts/askar'
import { Agent } from '@credo-ts/core'
import {
  DidCommAutoAcceptProof,
  DidCommConnectionEventTypes,
  DidCommDidExchangeState,
  DidCommDifPresentationExchangeProofFormatService,
  DidCommHttpOutboundTransport,
  DidCommMessageRepository,
  DidCommModule,
  DidCommProofExchangeRepository,
  DidCommProofEventTypes,
  DidCommProofState,
  DidCommProofV2Protocol,
} from '@credo-ts/didcomm'
import { agentDependencies, DidCommHttpInboundTransport } from '@credo-ts/node'
import { askar } from '@openwallet-foundation/askar-nodejs'
import { randomUUID } from 'node:crypto'

import {
  PROOF_REQUEST_EXPIRY_METADATA_KEY,
  applyProofRequestExpiry,
  requestProofWithExpiry,
} from '../proofRequestExpiry'

const makeAgent = (name: string, port: number) => {
  const agent = new Agent({
    config: { autoUpdateStorageOnStartup: true },
    dependencies: agentDependencies,
    modules: {
      askar: new AskarModule({
        askar,
        store: {
          id: `${name}-${randomUUID()}`,
          key: `${name}-key-00000000000000000000000`,
          database: { type: 'sqlite', config: { inMemory: true } },
        },
      }),
      didcomm: new DidCommModule({
        endpoints: [`http://localhost:${port}`],
        connections: { autoAcceptConnections: true },
        proofs: {
          autoAcceptProofs: DidCommAutoAcceptProof.Never,
          proofProtocols: [
            new DidCommProofV2Protocol({ proofFormats: [new DidCommDifPresentationExchangeProofFormatService()] }),
          ],
        },
      }),
    },
  })
  agent.modules.didcomm.registerInboundTransport(new DidCommHttpInboundTransport({ port }))
  agent.modules.didcomm.registerOutboundTransport(new DidCommHttpOutboundTransport())
  return agent
}

const presentationDefinition = {
  id: 'spike-pd',
  input_descriptors: [
    {
      id: 'input_0',
      schema: [{ uri: 'https://schema.example/foundational-id' }],
      constraints: { fields: [{ path: ["$.credentialSubject['ID Number']"] }] },
    },
  ],
}

// Cleanups for waits that have not settled yet. A wait is often started before the action that
// should satisfy it; if that action throws, nothing awaits the wait any more, and its pending timer
// would keep Jest from exiting and later surface as a stray rejection. cancelPendingWaits() runs
// after every test and after the suite.
const pendingWaits = new Set<() => void>()
const cancelPendingWaits = () => {
  for (const cancel of pendingWaits) cancel()
}

const waitFor = <T extends BaseEvent>(
  agent: Agent,
  eventType: string,
  predicate: (e: T) => boolean,
  timeoutMs = 20000,
) =>
  new Promise<T>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    let listener: ((event: BaseEvent) => void) | undefined
    const cleanup = () => {
      clearTimeout(timer)
      if (listener) agent.events.off(eventType, listener)
      pendingWaits.delete(cleanup)
    }
    listener = (event: BaseEvent) => {
      const e = event as T
      if (!predicate(e)) return
      cleanup()
      resolve(e)
    }
    timer = setTimeout(() => {
      cleanup()
      reject(new Error(`timed out waiting for ${eventType}`))
    }, timeoutMs)
    pendingWaits.add(cleanup)
    agent.events.on(eventType, listener)
  })

describe('proof request expiry on the connection-based path (no Credo patch)', () => {
  const verifier = makeAgent('verifier', 47201)
  const holder = makeAgent('holder', 47202)
  let verifierConnectionId: string

  beforeAll(async () => {
    await verifier.initialize()
    await holder.initialize()

    const verifierConnected = waitFor<any>(
      verifier,
      DidCommConnectionEventTypes.DidCommConnectionStateChanged,
      (e) => e.payload.connectionRecord.state === DidCommDidExchangeState.Completed,
    )
    const { outOfBandInvitation } = await verifier.modules.didcomm.oob.createInvitation({ label: 'verifier' })
    await holder.modules.didcomm.oob.receiveInvitation(outOfBandInvitation, { label: 'holder' })
    verifierConnectionId = (await verifierConnected).payload.connectionRecord.id
  }, 60000)

  afterEach(cancelPendingWaits)

  afterAll(async () => {
    cancelPendingWaits()
    await holder.shutdown()
    await verifier.shutdown()
  })

  const holderReceivesRequest = () =>
    waitFor<DidCommProofStateChangedEvent>(
      holder,
      DidCommProofEventTypes.ProofStateChanged,
      (e) => e.payload.proofRecord.state === DidCommProofState.RequestReceived,
    )

  it('delivers ~timing.expires_time to the holder and keeps it on the verifier stored copy', async () => {
    const expiresTime = new Date(Date.now() + 10 * 60 * 1000)
    const received = holderReceivesRequest()

    const verifierRecord = await requestProofWithExpiry(
      verifier as any,
      {
        connectionId: verifierConnectionId,
        protocolVersion: 'v2',
        proofFormats: { presentationExchange: { presentationDefinition } },
      },
      expiresTime,
    )

    expect(verifierRecord.state).toBe(DidCommProofState.RequestSent)
    expect(verifierRecord.connectionId).toBe(verifierConnectionId)

    const holderRecord = (await received).payload.proofRecord
    expect(holderRecord.threadId).toBe(verifierRecord.threadId)

    const holderMessage = (await holder.modules.didcomm.proofs.findRequestMessage(
      holderRecord.id,
    )) as DidCommRequestPresentationV2Message
    expect(holderMessage.timing?.expiresTime?.toISOString()).toBe(expiresTime.toISOString())

    const verifierMessage = (await verifier.modules.didcomm.proofs.findRequestMessage(
      verifierRecord.id,
    )) as DidCommRequestPresentationV2Message
    expect(verifierMessage.timing?.expiresTime?.toISOString()).toBe(expiresTime.toISOString())

    // The re-save must update Credo's stored request message, not add a second record for it.
    const storedMessages = await verifier.dependencyManager
      .resolve(DidCommMessageRepository)
      .findByQuery(verifier.context, { associatedRecordId: verifierRecord.id })
    expect(storedMessages).toHaveLength(1)

    const storedRecord = await verifier.dependencyManager
      .resolve(DidCommProofExchangeRepository)
      .getById(verifier.context, verifierRecord.id)
    expect(storedRecord.metadata.get(PROOF_REQUEST_EXPIRY_METADATA_KEY)).toEqual({
      expiresAt: expiresTime.toISOString(),
    })
  }, 60000)

  it('OOB: the request inside the invitation carries ~timing.expires_time and expiresAt is stored', async () => {
    // Mirrors ProofController.createRequest: createRequest returns the message before sending,
    // the expiry is applied, then the message is embedded in an out-of-band invitation.
    const expiresTime = new Date(Date.now() + 30 * 60 * 1000)
    const received = holderReceivesRequest()

    const { message, proofRecord } = await verifier.modules.didcomm.proofs.createRequest({
      protocolVersion: 'v2',
      proofFormats: { presentationExchange: { presentationDefinition } },
    })
    await applyProofRequestExpiry(verifier.context, message, proofRecord, expiresTime)
    const { outOfBandInvitation } = await verifier.modules.didcomm.oob.createInvitation({
      label: 'verifier',
      messages: [message],
      autoAcceptConnection: true,
    })
    await holder.modules.didcomm.oob.receiveInvitation(outOfBandInvitation, { label: 'holder' })

    const holderRecord = (await received).payload.proofRecord
    expect(holderRecord.threadId).toBe(proofRecord.threadId)
    const holderMessage = (await holder.modules.didcomm.proofs.findRequestMessage(
      holderRecord.id,
    )) as DidCommRequestPresentationV2Message
    expect(holderMessage.timing?.expiresTime?.toISOString()).toBe(expiresTime.toISOString())

    const verifierMessage = (await verifier.modules.didcomm.proofs.findRequestMessage(
      proofRecord.id,
    )) as DidCommRequestPresentationV2Message
    expect(verifierMessage.timing?.expiresTime?.toISOString()).toBe(expiresTime.toISOString())

    const storedMessages = await verifier.dependencyManager
      .resolve(DidCommMessageRepository)
      .findByQuery(verifier.context, { associatedRecordId: proofRecord.id })
    expect(storedMessages).toHaveLength(1)

    const storedRecord = await verifier.dependencyManager
      .resolve(DidCommProofExchangeRepository)
      .getById(verifier.context, proofRecord.id)
    expect(storedRecord.metadata.get(PROOF_REQUEST_EXPIRY_METADATA_KEY)).toEqual({
      expiresAt: expiresTime.toISOString(),
    })
  }, 60000)

  it('stock requestProof (no expiresTime) still sends no timing', async () => {
    const received = holderReceivesRequest()

    await verifier.modules.didcomm.proofs.requestProof({
      connectionId: verifierConnectionId,
      protocolVersion: 'v2',
      proofFormats: { presentationExchange: { presentationDefinition } },
    })

    const holderRecord = (await received).payload.proofRecord
    const holderMessage = (await holder.modules.didcomm.proofs.findRequestMessage(
      holderRecord.id,
    )) as DidCommRequestPresentationV2Message
    expect(holderMessage.timing?.expiresTime).toBeUndefined()
  }, 60000)
})
