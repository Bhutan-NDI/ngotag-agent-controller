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
 */
import '@openwallet-foundation/askar-nodejs'
import { KdfMethod, Store, StoreKeyMethod } from '@openwallet-foundation/askar-shared'
import { promises as fs } from 'fs'
import * as os from 'os'
import * as path from 'path'

const PASSPHRASE = 'MySecretPassphrase123'
const PROFILE = 'tenant-under-test'

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

  it('regression guard: Store.open rejects a KdfMethod that does not match how the file was provisioned', async () => {
    // A real bug found during the #73 rebase, not caught by any mocked spec: runImport's
    // Store.open call was still using KdfMethod.Raw after export switched to provisioning with
    // Argon2IMod. Askar rejects the mismatch outright — every real import would have failed here
    // before ever reaching a wrong-passphrase check.
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
})
