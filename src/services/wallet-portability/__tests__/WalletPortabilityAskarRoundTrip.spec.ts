/**
 * Round-trip test against the *real* native Askar binding — deliberately NOT mocked, unlike
 * WalletPortabilityService.spec.ts. That file mocks @openwallet-foundation/askar-shared entirely,
 * which means it can only assert that a string was forwarded as `passKey`/`keyMethod` — it can't
 * catch Askar actually rejecting the value. That's exactly the class of bug this file exists to
 * catch: KdfMethod.Raw silently accepting any string in the mock while the real binding requires
 * a base58-encoded 32-byte key (Store.generateRawKey() output) and throws for a normal passphrase.
 *
 * Most of this file imports '@openwallet-foundation/askar-nodejs' + '@openwallet-foundation/
 * askar-shared' directly, NOT '@credo-ts/askar', to exercise the native binding without pulling in
 * Credo's own wrapper (which the mocked spec covers instead). The stampStorageVersion test below
 * is the one exception — it imports WalletPortabilityService (and so @credo-ts/askar) to call the
 * real method; confirmed this file stays small enough that it doesn't reintroduce the OOM crash
 * under Jest's --experimental-vm-modules mode that WalletPortabilityService.spec.ts's docblock
 * warns about.
 *
 * Uses real sqlite files under a temp dir — no Postgres, no agent, no network required.
 */
import '@openwallet-foundation/askar-nodejs'
import { JsonTransformer, StorageVersionRecord, TypedArrayEncoder } from '@credo-ts/core'
import { KdfMethod, Key, KeyAlgorithm, Store, StoreKeyMethod } from '@openwallet-foundation/askar-shared'
import { randomUUID } from 'crypto'
import { promises as fs } from 'fs'
import * as os from 'os'
import * as path from 'path'

import { WalletPortabilityService } from '../WalletPortabilityService'

const PASSPHRASE = 'MySecretPassphrase123'
const PROFILE = 'tenant-under-test'

type StampStorageVersion = (store: Store, profile: string) => Promise<void>
type AliasKeysByBase58 = (store: Store, profile: string) => Promise<number>

describe('Askar native binding — export/import key-derivation and copyProfile', () => {
  let workDir: string

  beforeEach(async () => {
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'askar-roundtrip-'))
  })

  afterEach(async () => {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => undefined)
  })

  it('regression guard: KdfMethod.Raw rejects a normal caller passphrase', async () => {
    const dbPath = path.join(workDir, 'raw-rejects.db')
    await expect(
      Store.provision({
        uri: `sqlite://${dbPath}`,
        keyMethod: new StoreKeyMethod(KdfMethod.Raw),
        passKey: PASSPHRASE,
        recreate: true,
        profile: PROFILE,
      }),
    ).rejects.toThrow()
  })

  it('KdfMethod.Argon2IMod accepts a normal passphrase, and copyProfile carries records over to a reopened store', async () => {
    const sourcePath = path.join(workDir, 'source.db')
    const destPath = path.join(workDir, 'dest.db')
    const keyMethod = new StoreKeyMethod(KdfMethod.Argon2IMod)

    const sourceStore = await Store.provision({
      uri: `sqlite://${sourcePath}`,
      keyMethod,
      passKey: PASSPHRASE,
      recreate: true,
      profile: PROFILE,
    })

    const session = await sourceStore.openSession()
    await session.insert({ category: 'test-category', name: 'test-record', value: 'hello-world' })
    await session.close()

    const destStore = await Store.provision({
      uri: `sqlite://${destPath}`,
      keyMethod,
      passKey: PASSPHRASE,
      recreate: true,
      profile: PROFILE,
    })

    await sourceStore.copyProfile({ toStore: destStore, fromProfile: PROFILE, toProfile: PROFILE })

    await sourceStore.close()
    await destStore.close()

    // Reopen the destination artifact exactly as an import flow would — fresh Store handle,
    // same passKey — and confirm the record survived the copy.
    const reopened = await Store.open({ uri: `sqlite://${destPath}`, keyMethod, passKey: PASSPHRASE })
    const reopenedSession = await reopened.openSession()
    const fetched = await reopenedSession.fetch({ category: 'test-category', name: 'test-record' })
    await reopenedSession.close()
    await reopened.close()

    expect(fetched?.value).toBe('hello-world')
  })

  // The test above copies into a `toProfile` that already exists in destStore -- that's the
  // *export* shape (temp store provisioned with the tenant's own profile up front). runImport's
  // copyProfile call is the opposite shape: by the time it runs, the tenant's real profile has
  // already been renamed aside, so `toProfile: profile` does NOT yet exist in baseStore. Never
  // pinned down against the real binding before -- only checked manually via the CLI.
  it('copyProfile also carries records over when toProfile does not yet exist in the destination store', async () => {
    const sourcePath = path.join(workDir, 'import-source.db')
    const destPath = path.join(workDir, 'import-dest.db')
    const keyMethod = new StoreKeyMethod(KdfMethod.Argon2IMod)
    const NEW_PROFILE = 'freshly-created-profile'

    const sourceStore = await Store.provision({
      uri: `sqlite://${sourcePath}`,
      keyMethod,
      passKey: PASSPHRASE,
      recreate: true,
      profile: NEW_PROFILE,
    })
    const session = await sourceStore.openSession()
    await session.insert({ category: 'test-category', name: 'test-record', value: 'hello-import' })
    await session.close()

    // Provisioned with an unrelated profile only -- NEW_PROFILE does not exist here yet, matching
    // the state of a tenant's baseStore right after its own profile was renamed aside.
    const destStore = await Store.provision({
      uri: `sqlite://${destPath}`,
      keyMethod,
      passKey: PASSPHRASE,
      recreate: true,
      profile: 'unrelated-existing-profile',
    })

    await sourceStore.copyProfile({ toStore: destStore, fromProfile: NEW_PROFILE, toProfile: NEW_PROFILE })

    await sourceStore.close()
    await destStore.close()

    const reopened = await Store.open({
      uri: `sqlite://${destPath}`,
      keyMethod,
      passKey: PASSPHRASE,
      profile: NEW_PROFILE,
    })
    const reopenedSession = await reopened.openSession()
    const fetched = await reopenedSession.fetch({ category: 'test-category', name: 'test-record' })
    await reopenedSession.close()
    await reopened.close()

    expect(fetched?.value).toBe('hello-import')
  })

  it('regression guard: Store.open rejects a KdfMethod that does not match how the file was provisioned', async () => {
    // Guards against runImport's Store.open call using a KdfMethod that doesn't match how export
    // provisions the file (Argon2IMod) — Askar rejects the mismatch outright, before ever
    // reaching a wrong-passphrase check.
    const dbPath = path.join(workDir, 'kdf-mismatch.db')
    const store = await Store.provision({
      uri: `sqlite://${dbPath}`,
      keyMethod: new StoreKeyMethod(KdfMethod.Argon2IMod),
      passKey: PASSPHRASE,
      recreate: true,
      profile: PROFILE,
    })
    await store.close()

    await expect(
      Store.open({ uri: `sqlite://${dbPath}`, keyMethod: new StoreKeyMethod(KdfMethod.Raw), passKey: PASSPHRASE }),
    ).rejects.toThrow()

    // The fix: open with the matching method.
    const reopened = await Store.open({
      uri: `sqlite://${dbPath}`,
      keyMethod: new StoreKeyMethod(KdfMethod.Argon2IMod),
      passKey: PASSPHRASE,
    })
    await reopened.close()
  })

  it("stampStorageVersion writes a record that parses back through Credo's own class as version 0.5", async () => {
    const dbPath = path.join(workDir, 'stamped.db')
    const keyMethod = new StoreKeyMethod(KdfMethod.Argon2IMod)
    const store = await Store.provision({
      uri: `sqlite://${dbPath}`,
      keyMethod,
      passKey: PASSPHRASE,
      recreate: true,
      profile: PROFILE,
    })

    // Object.create skips the constructor (aws-sdk ESM interop breaks it unmocked); the method never uses this.
    const service = Object.create(WalletPortabilityService.prototype) as { stampStorageVersion: StampStorageVersion }
    await service.stampStorageVersion(store, PROFILE)
    await store.close()

    const reopened = await Store.open({ uri: `sqlite://${dbPath}`, keyMethod, passKey: PASSPHRASE, profile: PROFILE })
    const readSession = await reopened.session(PROFILE).open()
    const entry = await readSession.fetch({
      category: 'StorageVersionRecord',
      name: 'STORAGE_VERSION_RECORD_ID',
      isJson: true,
    })
    await readSession.close()
    await reopened.close()

    const record = JsonTransformer.fromJSON(entry?.value, StorageVersionRecord)
    expect(record.storageVersion).toBe('0.5')
    expect(record.id).toBe('STORAGE_VERSION_RECORD_ID')
  })

  it('aliasKeysByBase58 adds a base58-named twin for every asymmetric UUID-named key, skips the rest, and is idempotent', async () => {
    const dbPath = path.join(workDir, 'aliased.db')
    const keyMethod = new StoreKeyMethod(KdfMethod.Argon2IMod)
    const store = await Store.provision({
      uri: `sqlite://${dbPath}`,
      keyMethod,
      passKey: PASSPHRASE,
      recreate: true,
      profile: PROFILE,
    })

    const uuidNamed = new Map<string, { publicBytes: Uint8Array; name: string }>()
    const seed = await store.transaction(PROFILE).open()
    for (const [label, algorithm] of [
      ['ed25519', KeyAlgorithm.Ed25519],
      ['p256', KeyAlgorithm.EcSecp256r1],
      ['k256', KeyAlgorithm.EcSecp256k1],
    ] as const) {
      const key = Key.generate(algorithm)
      const name = randomUUID()
      await seed.insertKey({ name, key })
      uuidNamed.set(label, { publicBytes: key.publicBytes, name })
      key.handle.free()
    }
    const alreadyBase58 = Key.generate(KeyAlgorithm.Ed25519)
    await seed.insertKey({ name: TypedArrayEncoder.toBase58(alreadyBase58.publicBytes), key: alreadyBase58 })
    alreadyBase58.handle.free()
    const symmetric = Key.generate(KeyAlgorithm.AesA256Gcm)
    await seed.insertKey({ name: randomUUID(), key: symmetric })
    symmetric.handle.free()
    await seed.commit()

    const service = Object.create(WalletPortabilityService.prototype) as { aliasKeysByBase58: AliasKeysByBase58 }
    expect(await service.aliasKeysByBase58(store, PROFILE)).toBe(3)
    expect(await service.aliasKeysByBase58(store, PROFILE)).toBe(0)
    await store.close()

    const reopened = await Store.open({ uri: `sqlite://${dbPath}`, keyMethod, passKey: PASSPHRASE, profile: PROFILE })
    const readSession = await reopened.session(PROFILE).open()
    for (const { publicBytes, name } of uuidNamed.values()) {
      const twin = await readSession.fetchKey({ name: TypedArrayEncoder.toBase58(publicBytes) })
      expect(twin && Buffer.from(twin.key.publicBytes).equals(Buffer.from(publicBytes))).toBe(true)
      twin?.key.handle.free()
      const original = await readSession.fetchKey({ name })
      expect(original).not.toBeNull()
      original?.key.handle.free()
    }
    const all = await readSession.fetchAllKeys({})
    all.forEach((entry) => entry.key.handle.free())
    await readSession.close()
    await reopened.close()

    // 3 originals + 3 twins + 1 already-base58 + 1 symmetric
    expect(all).toHaveLength(8)
  })
})
