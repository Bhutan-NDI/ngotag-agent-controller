import { CryptoBox, Key, KeyAlgorithm } from '@openwallet-foundation/askar-shared'

const X25519_PUBLIC_KEY_BYTES = 32
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/

export class InvalidRecipientKeyError extends Error {
  public constructor() {
    super(`recipientPublicKey must be a base64-encoded ${X25519_PUBLIC_KEY_BYTES}-byte X25519 public key.`)
    this.name = 'InvalidRecipientKeyError'
  }
}

export const parseRecipientKey = (recipientPublicKey: string): Key => {
  if (!BASE64_PATTERN.test(recipientPublicKey)) {
    throw new InvalidRecipientKeyError()
  }
  const publicKey = Buffer.from(recipientPublicKey, 'base64')
  if (X25519_PUBLIC_KEY_BYTES !== publicKey.length) {
    throw new InvalidRecipientKeyError()
  }
  return Key.fromPublicBytes({ algorithm: KeyAlgorithm.X25519, publicKey })
}

export const sealStoreKey = (storeKey: string, recipientKey: Key): string =>
  Buffer.from(CryptoBox.seal({ recipientKey, message: Buffer.from(storeKey, 'utf8') })).toString('base64')

export const openSealedStoreKey = (sealedStoreKey: string, recipientKey: Key): string =>
  Buffer.from(CryptoBox.sealOpen({ recipientKey, ciphertext: Buffer.from(sealedStoreKey, 'base64') })).toString('utf8')
