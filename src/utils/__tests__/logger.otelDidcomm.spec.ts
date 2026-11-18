/**
 * A decrypted DIDComm message is the plaintext of a credential or proof exchange. Credo logs every inbound
 * one at info with the whole message as the log data, so what is exported over OTLP (and kept in Loki) must
 * carry only its type and id -- wherever in the payload it sits. Everything else is exported as before.
 */
import { jest } from '@jest/globals'

import { tracerMock, type EmittedRecord } from './loggerTestUtils'

const emitted: EmittedRecord[] = []

jest.unstable_mockModule('../../tracer', () => tracerMock(emitted))

const { TsLogger, withoutDidcommBodies } = await import('../logger')
const { LogLevel } = await import('@credo-ts/core')

const offer = () => ({
  '@type': 'https://didcomm.org/issue-credential/2.0/offer-credential',
  '@id': 'msg-1',
  '~thread': { thid: 'thread-1' },
  credential_preview: { attributes: [{ name: 'idNumber', value: 'SECRET-ID-NUMBER' }] },
  'offers~attach': [{ data: { base64: 'SECRET-BASE64-ATTACHMENT' } }],
})

describe('DIDComm message bodies in exported logs', () => {
  const stdout = process.stdout.write.bind(process.stdout)
  const stderr = process.stderr.write.bind(process.stderr)

  beforeAll(() => {
    process.stdout.write = (() => true) as typeof process.stdout.write
    process.stderr.write = (() => true) as typeof process.stderr.write
  })

  afterAll(() => {
    process.stdout.write = stdout
    process.stderr.write = stderr
  })

  beforeEach(() => {
    emitted.length = 0
  })

  it("exports only the type and id when the log data is Credo's inbound plaintext message", () => {
    // DidCommMessageReceiver: logger.info(`Received message with type ...`, plaintextMessage)
    new TsLogger(LogLevel.info, 'didcomm-test').info("Received message with type 'offer-credential'", offer())

    expect(emitted).toHaveLength(1)
    expect(emitted[0].attributes).toEqual({
      '@type': 'https://didcomm.org/issue-credential/2.0/offer-credential',
      '@id': 'msg-1',
    })
    expect(JSON.stringify(emitted)).not.toMatch(/SECRET/)
  })

  it('also reduces a message nested in the payload, and one inside an array', () => {
    new TsLogger(LogLevel.info, 'didcomm-test').info('forwarding', {
      message: offer(),
      queued: [offer()],
      connectionId: 'conn-1',
    })

    expect(emitted[0].attributes).toEqual({
      message: { '@type': 'https://didcomm.org/issue-credential/2.0/offer-credential', '@id': 'msg-1' },
      queued: [{ '@type': 'https://didcomm.org/issue-credential/2.0/offer-credential', '@id': 'msg-1' }],
      connectionId: 'conn-1',
    })
    expect(JSON.stringify(emitted)).not.toMatch(/SECRET/)
  })

  it('recognises a DIDComm v2 message by its didcomm.org type and body', () => {
    expect(
      withoutDidcommBodies({
        id: 'v2-1',
        type: 'https://didcomm.org/present-proof/3.0/presentation',
        body: { secret: 'SECRET-V2-BODY' },
      }),
    ).toEqual({ '@type': 'https://didcomm.org/present-proof/3.0/presentation', '@id': 'v2-1' })
  })

  it('leaves payloads that are not DIDComm messages exactly as they were', () => {
    const data = { connectionId: 'conn-1', state: 'completed', counts: [1, 2], nested: { type: 'person', id: 'x' } }
    new TsLogger(LogLevel.info, 'didcomm-test').info('connection updated', data)

    expect(emitted[0].attributes).toEqual(data)
  })
})
