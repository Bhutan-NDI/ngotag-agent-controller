/**
 * Spike: expiry on the connection-based proof request, without patching @credo-ts/didcomm.
 *
 * Two real Askar-backed agents (verifier, holder) connected over HTTP on localhost. The verifier
 * sends a request through `requestProofWithExpiry`, which reproduces `proofs.requestProof()` from
 * Credo's public exports with `~timing.expires_time` stamped before the send. Asserts the expiry
 * arrives at the holder and is also on the verifier's stored copy, and that the stock
 * `requestProof()` path (no expiry) is unchanged.
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
  DidCommModule,
  DidCommProofEventTypes,
  DidCommProofState,
  DidCommProofV2Protocol,
} from '@credo-ts/didcomm'
import { agentDependencies, DidCommHttpInboundTransport } from '@credo-ts/node'
import { askar } from '@openwallet-foundation/askar-nodejs'
import { randomUUID } from 'node:crypto'

import { BadRequestError } from '../../errors'
import { parseExpiresTime, requestProofWithExpiry } from '../proofRequestExpiry'

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

const waitFor = <T extends BaseEvent>(
  agent: Agent,
  eventType: string,
  predicate: (e: T) => boolean,
  timeoutMs = 20000,
) =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${eventType}`)), timeoutMs)
    const listener = (event: BaseEvent) => {
      const e = event as T
      if (!predicate(e)) return
      clearTimeout(timer)
      agent.events.off(eventType, listener)
      resolve(e)
    }
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

  afterAll(async () => {
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

describe('parseExpiresTime', () => {
  it('returns undefined when absent', () => {
    expect(parseExpiresTime(undefined)).toBeUndefined()
    expect(parseExpiresTime('')).toBeUndefined()
  })

  it('rejects an unparseable value', () => {
    expect(() => parseExpiresTime('not-a-date')).toThrow(BadRequestError)
  })

  it('rejects a time that is not in the future', () => {
    expect(() => parseExpiresTime(new Date(Date.now() - 1000).toISOString())).toThrow(BadRequestError)
  })

  it('parses a future ISO-8601 time', () => {
    const iso = new Date(Date.now() + 60000).toISOString()
    expect(parseExpiresTime(iso)?.toISOString()).toBe(iso)
  })

  // Regression for @kinxa0's review on PR #100: new Date(value) alone accepts non-ISO formats and
  // reads an offset-less date-time as server-local time, making the wire value depend on the pod's
  // timezone instead of rejecting it with a 400.
  it('rejects non-ISO-8601 formats that Date() would otherwise accept', () => {
    const future = new Date(Date.now() + 60 * 60 * 1000)
    expect(() => parseExpiresTime(`${future.getMonth() + 1}/${future.getDate()}/${future.getFullYear()}`)).toThrow(
      BadRequestError,
    )
    expect(() => parseExpiresTime(String(future.getFullYear() + 10))).toThrow(BadRequestError)
  })

  it('rejects a date-time with no UTC offset', () => {
    const future = new Date(Date.now() + 60 * 60 * 1000)
    const offsetLess = future.toISOString().replace('Z', '')
    expect(() => parseExpiresTime(offsetLess)).toThrow(BadRequestError)
  })

  it('accepts a future ISO-8601 time with a non-Z numeric offset', () => {
    const future = new Date(Date.now() + 60 * 60 * 1000)
    const withOffset = `${future.toISOString().replace('Z', '')}+00:00`
    expect(parseExpiresTime(withOffset)?.getTime()).toBe(future.getTime())
  })
})
