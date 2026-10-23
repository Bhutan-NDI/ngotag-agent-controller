/**
 * How create-offer-oob and create-request-oob use additionalInvitationDids: validated before anything is created, and
 * added to the invitation once it exists. The helpers themselves run against real agents in
 * src/utils/__tests__/additionalInvitationDids.spec.ts.
 */
import { jest } from '@jest/globals'

import { BadRequestError } from '../../../errors/errors'

const validate = jest.fn<(...args: unknown[]) => Promise<string[]>>()
const add = jest.fn<(...args: unknown[]) => Promise<void>>()
jest.unstable_mockModule('../../../utils/additionalInvitationDids', () => ({
  validateAdditionalInvitationDids: validate,
  addAdditionalInvitationDids: add,
}))

const { CredentialController } = await import('../credentials/CredentialController')
const { ProofController } = await import('../proofs/ProofController')

const outOfBandRecord = {
  id: 'oob-1',
  outOfBandInvitation: { toUrl: () => 'https://agent/oob', toJSON: () => ({ services: [] }) },
  toJSON: () => ({ id: 'oob-1' }),
}

const buildAgent = () => {
  const calls: string[] = []
  const agent = {
    modules: {
      didcomm: {
        config: { endpoints: ['https://agent'], useDidSovPrefixWhereAllowed: false },
        credentials: {
          createOffer: jest.fn(async () => {
            calls.push('createOffer')
            return {
              message: { threadId: 't1', setThread: jest.fn() },
              credentialExchangeRecord: { id: 'cx-1', threadId: 't1', parentThreadId: undefined },
            }
          }),
        },
        proofs: {
          createRequest: jest.fn(async () => {
            calls.push('createRequest')
            return { message: { threadId: 't1', id: 'm1' }, proofRecord: { id: 'p-1', threadId: 't1' } }
          }),
        },
        oob: {
          createInvitation: jest.fn(async () => {
            calls.push('createInvitation')
            return outOfBandRecord
          }),
        },
      },
    },
  }
  return { agent, calls }
}

const offerRequest = (extra: object = {}) =>
  ({
    protocolVersion: 'v2',
    credentialFormats: { jsonld: {} },
    invitationDid: 'did:peer:primary',
    label: 'Org',
    ...extra,
  }) as never

const proofRequest = (extra: object = {}) =>
  ({ protocolVersion: 'v2', proofFormats: {}, invitationDid: 'did:peer:primary', label: 'Org', ...extra }) as never

describe('additionalInvitationDids in create-offer-oob', () => {
  const controller = new CredentialController({} as never)

  beforeEach(() => {
    validate.mockReset().mockResolvedValue(['did:peer:legacy'])
    add.mockReset().mockResolvedValue(undefined)
    jest
      .spyOn(controller as unknown as { ensureLinkSecretExists: () => Promise<void> }, 'ensureLinkSecretExists')
      .mockResolvedValue(undefined)
  })

  it('validates first, creates the offer and invitation, then adds the extra DIDs to the invitation', async () => {
    const { agent, calls } = buildAgent()
    validate.mockImplementation(async () => {
      calls.push('validate')
      return ['did:peer:legacy']
    })
    add.mockImplementation(async () => {
      calls.push('add')
    })

    await controller.createOfferOob({ agent } as never, offerRequest({ additionalInvitationDids: ['did:peer:legacy'] }))

    expect(calls).toEqual(['validate', 'createOffer', 'createInvitation', 'add'])
    expect(validate).toHaveBeenCalledWith(agent, ['did:peer:legacy'], 'did:peer:primary')
    expect(add).toHaveBeenCalledWith(agent, outOfBandRecord, ['did:peer:legacy'])
  })

  it('creates nothing when the extra DIDs are rejected', async () => {
    const { agent, calls } = buildAgent()
    validate.mockRejectedValue(new BadRequestError('bad'))

    const error = await controller
      .createOfferOob({ agent } as never, offerRequest({ additionalInvitationDids: ['x'] }))
      .catch((e: unknown) => e)

    expect(error).toBeInstanceOf(BadRequestError)
    expect(calls).toEqual([])
    expect(add).not.toHaveBeenCalled()
  })

  it('does not pass the extra DIDs on to Credo as an invitation option', async () => {
    const { agent } = buildAgent()

    await controller.createOfferOob({ agent } as never, offerRequest({ additionalInvitationDids: ['did:peer:legacy'] }))

    const [options] = agent.modules.didcomm.oob.createInvitation.mock.calls[0] as unknown as [Record<string, unknown>]
    expect(options).not.toHaveProperty('additionalInvitationDids')
    expect(options).toMatchObject({ invitationDid: 'did:peer:primary' })
  })
})

describe('additionalInvitationDids in create-request-oob', () => {
  const controller = new ProofController()

  beforeEach(() => {
    validate.mockReset().mockResolvedValue(['did:peer:legacy'])
    add.mockReset().mockResolvedValue(undefined)
  })

  it('validates first, creates the request and invitation, then adds the extra DIDs to the invitation', async () => {
    const { agent, calls } = buildAgent()
    validate.mockImplementation(async () => {
      calls.push('validate')
      return ['did:peer:legacy']
    })
    add.mockImplementation(async () => {
      calls.push('add')
    })

    await controller.createRequest({ agent } as never, proofRequest({ additionalInvitationDids: ['did:peer:legacy'] }))

    expect(calls).toEqual(['validate', 'createRequest', 'createInvitation', 'add'])
    expect(validate).toHaveBeenCalledWith(agent, ['did:peer:legacy'], 'did:peer:primary')
    expect(add).toHaveBeenCalledWith(agent, outOfBandRecord, ['did:peer:legacy'])
  })

  it('creates nothing when the extra DIDs are rejected', async () => {
    const { agent, calls } = buildAgent()
    validate.mockRejectedValue(new BadRequestError('bad'))

    const error = await controller
      .createRequest({ agent } as never, proofRequest({ additionalInvitationDids: ['x'] }))
      .catch((e: unknown) => e)

    expect(error).toBeInstanceOf(BadRequestError)
    expect(calls).toEqual([])
  })

  it('works unchanged when no extra DIDs are given', async () => {
    const { agent } = buildAgent()
    validate.mockResolvedValue([])

    const result = await controller.createRequest({ agent } as never, proofRequest())

    expect(add).toHaveBeenCalledWith(agent, outOfBandRecord, [])
    expect(result).toMatchObject({ invitationUrl: 'https://agent/oob', invitationDid: 'did:peer:primary' })
  })
})
