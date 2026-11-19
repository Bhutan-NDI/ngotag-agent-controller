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
const { DidCommIssueCredentialV2Message, DidCommCredentialFormatSpec, DidCommAttachment } =
  await import('@credo-ts/didcomm')

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

  it('reduces a Credo message instance, as logged when a message is undeliverable', () => {
    // DidCommMessageSender: logger.error('Message is undeliverable to connection ...', { message, errors, connection })
    const message = new DidCommIssueCredentialV2Message({
      credentialAttachments: [new DidCommAttachment({ id: 'att-1', data: { base64: 'SECRET-BASE64-ATTACHMENT' } })],
      formats: [new DidCommCredentialFormatSpec({ attachmentId: 'att-1', format: 'anoncreds/credential@v1.0' })],
      comment: 'SECRET-COMMENT',
    })
    new TsLogger(LogLevel.error, 'didcomm-test').error('Message is undeliverable to connection c-1', {
      message,
      errors: [new Error('no transport')],
      connection: { id: 'c-1', state: 'completed' },
    })

    expect(emitted).toHaveLength(1)
    expect(emitted[0].attributes.message).toEqual({
      '@type': 'https://didcomm.org/issue-credential/2.0/issue-credential',
      '@id': message.id,
    })
    expect(emitted[0].attributes.connection).toEqual({ id: 'c-1', state: 'completed' })
    expect(JSON.stringify(emitted)).not.toMatch(/SECRET/)
  })

  it('reduces a message logged as JSON text, as on a parse failure', () => {
    // DidCommMessageReceiver: logger.error('Error validating message ...', { errors, message: JSON.stringify(message) })
    new TsLogger(LogLevel.error, 'didcomm-test').error('Error validating message', {
      errors: new Error('bad'),
      message: JSON.stringify(offer()),
    })

    expect(emitted[0].attributes.message).toEqual({
      '@type': 'https://didcomm.org/issue-credential/2.0/offer-credential',
      '@id': 'msg-1',
    })
    expect(JSON.stringify(emitted)).not.toMatch(/SECRET/)
  })

  it('drops DIDComm-looking JSON text it cannot parse rather than exporting it whole', () => {
    const truncated = JSON.stringify(offer()).slice(0, -10)

    expect(withoutDidcommBodies({ message: truncated })).toEqual({
      message: '[omitted: unparseable DIDComm-like JSON]',
    })
  })

  it('leaves JSON text that is not a DIDComm message alone', () => {
    const text = JSON.stringify({ connectionId: 'conn-1', state: 'completed' })

    expect(withoutDidcommBodies({ text })).toEqual({ text })
  })
})
