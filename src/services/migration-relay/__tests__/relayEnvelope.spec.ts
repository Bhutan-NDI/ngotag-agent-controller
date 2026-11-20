import { extractRecipientFingerprints } from '../relayEnvelope'

import { buildEnvelope, newRecipient } from './testSupport'

describe('extractRecipientFingerprints', () => {
  it('returns the fingerprint Credo would store for the recipient key', () => {
    const recipient = newRecipient()

    expect(extractRecipientFingerprints(buildEnvelope([recipient.kid]))).toEqual([recipient.fingerprint])
  })

  it('returns one fingerprint per distinct recipient', () => {
    const [first, second] = [newRecipient(), newRecipient()]

    expect(extractRecipientFingerprints(buildEnvelope([first.kid, second.kid, first.kid])).sort()).toEqual(
      [first.fingerprint, second.fingerprint].sort(),
    )
  })

  it('finds the protected header wherever it sits in the JSON', () => {
    const recipient = newRecipient()
    const envelope = JSON.parse(buildEnvelope([recipient.kid]))
    const reordered = JSON.stringify({
      tag: envelope.tag,
      ciphertext: envelope.ciphertext,
      protected: envelope.protected,
    })

    expect(extractRecipientFingerprints(reordered)).toEqual([recipient.fingerprint])
  })

  it.each([
    ['a non-string body', { protected: 'x' }],
    ['an empty body', ''],
    ['plain text', 'hello'],
    ['JSON without a protected header', '{"a":1}'],
    ['a protected header that is not base64url JSON', '{"protected":"!!!"}'],
    [
      'a protected header that is JSON without recipients',
      `{"protected":"${Buffer.from('{"a":1}').toString('base64url')}"}`,
    ],
    [
      'a recipient with no kid',
      `{"protected":"${Buffer.from('{"recipients":[{"header":{}}]}').toString('base64url')}"}`,
    ],
    ['a kid that is not base58', buildEnvelope(['0OIl-not-base58'])],
  ])('returns nothing for %s', (_name, body) => {
    expect(extractRecipientFingerprints(body)).toEqual([])
  })

  it('mirrors Credo for a short key: it does not throw, and the fingerprint simply matches no tenant', () => {
    const fingerprints = extractRecipientFingerprints(buildEnvelope(['abc']))

    expect(fingerprints).toHaveLength(1)
    expect(fingerprints[0]).not.toEqual(newRecipient().fingerprint)
  })

  it('skips a bad recipient but keeps the good ones', () => {
    const good = newRecipient()

    expect(extractRecipientFingerprints(buildEnvelope(['0OIl-not-base58', good.kid]))).toEqual([good.fingerprint])
  })

  it('looks at no more than a bounded number of recipients', () => {
    const recipients = Array.from({ length: 40 }, () => newRecipient())

    expect(extractRecipientFingerprints(buildEnvelope(recipients.map((r) => r.kid)))).toHaveLength(16)
  })
})
