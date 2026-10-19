import '@openwallet-foundation/askar-nodejs'
import { jest } from '@jest/globals'
import { Key, KeyAlgorithm } from '@openwallet-foundation/askar-shared'

import { IMPORT_SESSION_TTL_MS, ImportSessionStore } from '../ImportSessionStore'
import { InvalidRecipientKeyError, openSealedStoreKey, parseRecipientKey, sealStoreKey } from '../sealedStoreKey'

describe('sealedStoreKey', () => {
  it('seals a store key that only the matching private key opens', () => {
    const recipient = Key.generate(KeyAlgorithm.X25519)
    const other = Key.generate(KeyAlgorithm.X25519)
    const publicKey = parseRecipientKey(Buffer.from(recipient.publicBytes).toString('base64'))

    const sealed = sealStoreKey('raw-store-key', publicKey)

    expect(sealed).not.toContain('raw-store-key')
    expect(openSealedStoreKey(sealed, recipient)).toBe('raw-store-key')
    expect(() => openSealedStoreKey(sealed, other)).toThrow()
  })

  it.each([
    ['empty', ''],
    ['not base64', '***not-base64***'],
    ['wrong length', Buffer.alloc(31).toString('base64')],
  ])('rejects a recipient key that is %s', (_name, value) => {
    expect(() => parseRecipientKey(value)).toThrow(InvalidRecipientKeyError)
  })
})

describe('ImportSessionStore', () => {
  afterEach(() => {
    jest.restoreAllMocks()
  })

  it('hands out a public key and keeps the private half until destroyed', () => {
    const store = new ImportSessionStore()
    const { sessionId, importPublicKey } = store.create()

    expect(Buffer.from(importPublicKey, 'base64')).toHaveLength(32)
    expect(Buffer.from(store.get(sessionId)?.publicBytes ?? []).toString('base64')).toBe(importPublicKey)

    store.destroy(sessionId)
    expect(store.get(sessionId)).toBeUndefined()
    store.clear()
  })

  it('treats a session as gone once its lifetime has passed', () => {
    const store = new ImportSessionStore()
    const { sessionId } = store.create()
    const now = Date.now()

    jest.spyOn(Date, 'now').mockReturnValue(now + IMPORT_SESSION_TTL_MS + 1)

    expect(store.get(sessionId)).toBeUndefined()
    store.clear()
  })

  it('evicts the oldest session when too many are open', () => {
    const store = new ImportSessionStore()
    const sessions = Array.from({ length: 11 }, () => store.create())

    expect(store.get(sessions[0].sessionId)).toBeUndefined()
    expect(store.get(sessions[10].sessionId)).toBeDefined()
    store.clear()
  })
})
