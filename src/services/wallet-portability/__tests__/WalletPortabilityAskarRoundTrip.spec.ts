/**
 * Round-trip test against the *real* native Askar binding — deliberately NOT mocked, unlike
 * WalletPortabilityService.spec.ts. That file mocks @openwallet-foundation/askar-shared entirely,
 * which means it can only assert that a string was forwarded as `passKey`/`keyMethod` — it can't
 * catch Askar actually rejecting the value. That's exactly the class of bug this file exists to
 * catch: KdfMethod.Raw silently accepting any string in the mock while the real binding requires
 * a base58-encoded 32-byte key (Store.generateRawKey() output) and throws for a normal passphrase.
 *
 * This intentionally imports '@openwallet-foundation/askar-nodejs' + '@openwallet-foundation/
 * askar-shared' directly, NOT '@credo-ts/askar'. @credo-ts/askar is what provokes the (unrelated)
 * OOM crash under Jest's --experimental-vm-modules mode noted in WalletPortabilityService.spec.ts
 * — importing the lower-level native binding packages directly avoids that entirely, at the cost
 * of not exercising AskarStoreManager/Credo's own wrapper (which the mocked spec covers instead).
 *
 * Uses real sqlite files under a temp dir — no Postgres, no agent, no network required.
 *
 * The stampStorageVersion test below does import WalletPortabilityService (and so
 * @credo-ts/askar) — confirmed this file stays small enough that it doesn't reintroduce the OOM.
 */
import '@openwallet-foundation/askar-nodejs'
import { JsonTransformer, StorageVersionRecord } from '@credo-ts/core'
import { KdfMethod, Store, StoreKeyMethod } from '@openwallet-foundation/askar-shared'
import { promises as fs } from 'fs'
import * as os from 'os'
import * as path from 'path'

import { WalletPortabilityService } from '../WalletPortabilityService'

const PASSPHRASE = 'MySecretPassphrase123'
const PROFILE = 'tenant-under-test'

type StampStorageVersion = (store: Store, profile: string) => Promise<void>

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

  // Calls the real stampStorageVersion, not a hand-written copy -- catches implementation drift too.
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

    // Real method, but skips the constructor (Object.create, not `new`) -- stampStorageVersion
    // never touches `this`, and the constructor drags in aws-sdk/@credo-ts/askar for no benefit here.
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
})
