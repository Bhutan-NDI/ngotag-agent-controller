import '@openwallet-foundation/askar-nodejs'
import type { DidCommOutboundPackage } from '@credo-ts/didcomm'

import { AskarModule } from '@credo-ts/askar'
import { Agent, LogLevel, PeerDidNumAlgo } from '@credo-ts/core'
import { DidCommHttpOutboundTransport, DidCommModule } from '@credo-ts/didcomm'
import { DidCommHttpInboundTransport, agentDependencies } from '@credo-ts/node'
import { askar } from '@openwallet-foundation/askar-nodejs'
import { randomUUID } from 'crypto'
import { createServer } from 'net'

import { TsLogger } from '../../../utils/logger'
import { withNetworkErrorCodes } from '../../../utils/networkErrorCodes'

export const logger = new TsLogger(LogLevel.error, 'test')

export const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number }
      server.close(() => resolve(port))
    })
  })

// An outbound transport that can swallow the next message, to stand in for an acknowledgement that never arrives.
export class DroppableOutboundTransport extends DidCommHttpOutboundTransport {
  public dropNext = 0
  public sent = 0

  public override async sendMessage(outboundPackage: DidCommOutboundPackage): Promise<void> {
    if (0 < this.dropNext) {
      this.dropNext -= 1
      return
    }
    this.sent += 1
    return super.sendMessage(outboundPackage)
  }
}

export interface TestAgent {
  agent: Agent
  port: number
  outbound: DroppableOutboundTransport
}

/** A real agent with an HTTP endpoint of its own, configured like cliAgent for did:peer:4 rotation. */
export const buildAgent = async (name: string): Promise<TestAgent> => {
  const port = await freePort()
  const agent = new Agent({
    config: {
      allowInsecureHttpUrls: true,
      ...(process.env.ROT_DEBUG ? { logger: new TsLogger(LogLevel.debug, name) } : {}),
    },
    dependencies: { ...agentDependencies, fetch: withNetworkErrorCodes(agentDependencies.fetch) },
    modules: {
      askar: new AskarModule({
        askar,
        store: { id: `${name}-${randomUUID()}`, key: `${name}-store-key-0000000000000000`.slice(0, 32) },
      }),
      didcomm: new DidCommModule({
        endpoints: [`http://127.0.0.1:${port}`],
        connections: {
          autoAcceptConnections: true,
          peerNumAlgoForDidRotation: PeerDidNumAlgo.ShortFormAndLongForm,
        },
      }),
    },
  })
  const outbound = new DroppableOutboundTransport()
  ;(agent.modules as any).didcomm.registerOutboundTransport(outbound)
  ;(agent.modules as any).didcomm.registerInboundTransport(new DidCommHttpInboundTransport({ port }))
  return { agent, port, outbound }
}

export const eventually = async (check: () => boolean | Promise<boolean>, timeoutMs = 15000): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('condition not met in time')
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

// Credo errors carry their agent context, which Jest cannot serialise when a test fails: report only the text.
export const plain = async <T>(run: () => Promise<T>): Promise<T> => {
  try {
    return await run()
  } catch (error) {
    throw new Error(`${(error as Error)?.name}: ${(error as Error)?.message}\n${(error as Error)?.stack}`)
  }
}

/** Connects two agents through an out-of-band invitation from `inviter` and returns each side's connection id. */
export const connect = async (inviter: Agent, invitee: Agent): Promise<{ inviterId: string; inviteeId: string }> => {
  // createInvitation returns the out-of-band record itself, which carries the invitation.
  const outOfBandRecord = await (inviter.modules as any).didcomm.oob.createInvitation()
  const { outOfBandInvitation } = outOfBandRecord
  const { connectionRecord } = await (invitee.modules as any).didcomm.oob.receiveInvitation(outOfBandInvitation, {
    label: 'holder',
  })

  // This invitation's own connection on each side, not just any completed one.
  const inviterConnection = async () =>
    (await (inviter.modules as any).didcomm.connections.getAll()).find((c: any) => c.outOfBandId === outOfBandRecord.id)
  await eventually(async () => 'completed' === (await inviterConnection())?.state)
  await eventually(
    async () => 'completed' === (await (invitee.modules as any).didcomm.connections.getById(connectionRecord.id)).state,
  )
  return { inviterId: (await inviterConnection()).id, inviteeId: connectionRecord.id }
}
