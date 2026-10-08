/**
 * connectionType was dropped from this endpoint's contract at some point after it forked from
 * develop's own lineage -- restored here, matching the old multi-tenancy endpoint's behavior:
 * pulled out of the config sent to Credo's own receiveInvitationFromUrl (not a recognized option
 * there), used only to tag the resulting connection afterward via addConnectionType.
 */
import { jest } from '@jest/globals'

import { OutOfBandController } from '../OutOfBandController'

function makeRequest(receiveInvitationFromUrl: jest.Mock, addConnectionType: jest.Mock) {
  return {
    agent: {
      modules: {
        didcomm: {
          oob: { receiveInvitationFromUrl },
          connections: { addConnectionType },
        },
      },
    },
  } as never
}

describe('OutOfBandController.receiveInvitationFromUrl — connectionType', () => {
  it('tags the connection when connectionType is given and not already present', async () => {
    const outOfBandRecord = { toJSON: () => ({ id: 'oob-1' }) }
    const connectionRecord = { id: 'conn-1', connectionTypes: [], toJSON: () => ({ id: 'conn-1' }) }
    const tagged = {
      id: 'conn-1',
      connectionTypes: ['REVOCATION_CREDENTIAL'],
      toJSON: () => ({ id: 'conn-1', connectionTypes: ['REVOCATION_CREDENTIAL'] }),
    }
    const receiveInvitationFromUrl = jest.fn(async () => ({ outOfBandRecord, connectionRecord }))
    const addConnectionType = jest.fn(async () => tagged)
    const controller = new OutOfBandController()

    const result = await controller.receiveInvitationFromUrl(makeRequest(receiveInvitationFromUrl, addConnectionType), {
      invitationUrl: 'https://example.com?oob=abc',
      connectionType: 'REVOCATION_CREDENTIAL',
    } as never)

    expect(addConnectionType).toHaveBeenCalledWith('conn-1', 'REVOCATION_CREDENTIAL')
    expect(result.connectionRecord).toEqual({ id: 'conn-1', connectionTypes: ['REVOCATION_CREDENTIAL'] })
    // connectionType must not reach Credo's own call -- it isn't a recognized option there.
    expect(receiveInvitationFromUrl).toHaveBeenCalledWith('https://example.com?oob=abc', {})
  })

  it('does not re-tag a connection that already has this connectionType', async () => {
    const outOfBandRecord = { toJSON: () => ({ id: 'oob-1' }) }
    const connectionRecord = {
      id: 'conn-1',
      connectionTypes: ['REVOCATION_CREDENTIAL'],
      toJSON: () => ({ id: 'conn-1' }),
    }
    const receiveInvitationFromUrl = jest.fn(async () => ({ outOfBandRecord, connectionRecord }))
    const addConnectionType = jest.fn()
    const controller = new OutOfBandController()

    await controller.receiveInvitationFromUrl(makeRequest(receiveInvitationFromUrl, addConnectionType), {
      invitationUrl: 'https://example.com?oob=abc',
      connectionType: 'REVOCATION_CREDENTIAL',
    } as never)

    expect(addConnectionType).not.toHaveBeenCalled()
  })

  it('does nothing extra when connectionType is not given (existing behavior unchanged)', async () => {
    const outOfBandRecord = { toJSON: () => ({ id: 'oob-1' }) }
    const connectionRecord = { id: 'conn-1', connectionTypes: [], toJSON: () => ({ id: 'conn-1' }) }
    const receiveInvitationFromUrl = jest.fn(async () => ({ outOfBandRecord, connectionRecord }))
    const addConnectionType = jest.fn()
    const controller = new OutOfBandController()

    await controller.receiveInvitationFromUrl(makeRequest(receiveInvitationFromUrl, addConnectionType), {
      invitationUrl: 'https://example.com?oob=abc',
    } as never)

    expect(addConnectionType).not.toHaveBeenCalled()
    expect(receiveInvitationFromUrl).toHaveBeenCalledWith('https://example.com?oob=abc', {})
  })

  it('does not throw when no connection record is returned', async () => {
    const outOfBandRecord = { toJSON: () => ({ id: 'oob-1' }) }
    const receiveInvitationFromUrl = jest.fn(async () => ({ outOfBandRecord, connectionRecord: undefined }))
    const addConnectionType = jest.fn()
    const controller = new OutOfBandController()

    const result = await controller.receiveInvitationFromUrl(makeRequest(receiveInvitationFromUrl, addConnectionType), {
      invitationUrl: 'https://example.com?oob=abc',
      connectionType: 'REVOCATION_CREDENTIAL',
    } as never)

    expect(addConnectionType).not.toHaveBeenCalled()
    expect(result.connectionRecord).toBeUndefined()
  })
})
