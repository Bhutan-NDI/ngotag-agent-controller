/**
 * Regression tests for WalletPortabilityService's export and import flows. Export locks in:
 *
 *   1. Async job contract — exportWallet() returns immediately with a Pending job id; the actual
 *      Askar/S3 work happens in the background and is observed only via getJobStatus().
 *   2. The tenant session is never held outside withTenantAgent() — copyProfile happens fully
 *      inside the callback, matching the #65 tenant-session-release discipline elsewhere in this repo.
 *   3. On success: job status becomes Completed with a downloadUrl + checksum, and the temp
 *      export file + temp store are cleaned up (never left on disk).
 *   4. On failure (copyProfile throws): job status becomes Failed with the error message, and
 *      cleanup still runs (the finally block, not just the happy path).
 *   5. The temp store is provisioned with the *caller-supplied* passKey, not a generated one —
 *      an earlier version of this service generated a throwaway key and never exposed it, which
 *      would have made every exported artifact permanently undecryptable. See the export
 *      endpoint's docblock for the legacy-contract rationale.
 *
 * Import locks in the reversible-rename design (see project_phase_c_cloud_wallet memory):
 *   6. Checksum is verified BEFORE anything live is touched — a mismatch never reaches
 *      renameProfile/copyProfile.
 *   7. The tenant's current profile is renamed aside (never removed) before the imported profile
 *      takes its place, and the backup name is reported on the completed job.
 *   8. If copyProfile fails after the rename, the rollback renames the backup profile back to the
 *      real name — the tenant is never left without a working profile.
 *   9. A downloaded artifact missing the expected profile fails clearly, before any rename.
 *
 * Everything Askar-native is mocked here — that lets these tests focus on this service's own
 * control flow (job lifecycle, cleanup, session scoping) without depending on real file/native
 * I/O. The S3 client and node-fetch (used for downloading the export artifact) are mocked too.
 * Because it's mocked, though, these tests can only assert that a value was *forwarded* to Askar
 * (e.g. `passKey`, `keyMethod`) — not that Askar actually accepts it. See
 * WalletPortabilityAskarRoundTrip.spec.ts (same directory) for the un-mocked counterpart that
 * exercises the real native binding directly (bypassing @credo-ts/askar, which is what provokes
 * the OOM under Jest's experimental VM-modules mode — the lower-level askar-nodejs/askar-shared
 * packages don't).
 *
 * Runs under Jest ESM mode (see jest.config.base.ts).
 */
import { jest } from '@jest/globals'
import { createHash } from 'crypto'
import { readFileSync, writeFileSync } from 'fs'
import 'reflect-metadata'
import { Readable } from 'stream'
import { gzipSync } from 'zlib'

// AskarStoreManager is only ever used as a DI *token* (dependencyManager.resolve(AskarStoreManager))
// in the code under test — the mocked resolve() below ignores it entirely. Mocking it here avoids
// pulling in the real @credo-ts/askar → native-Askar-binding chain, which is both unnecessary for
// this unit test and, under Jest's experimental VM-modules mode, provokes an unrelated OOM crash.
jest.unstable_mockModule('@credo-ts/askar', () => ({
  AskarStoreManager: class {},
}))

const s3UploadPromise = jest.fn(async () => ({})) as jest.Mock
const getSignedUrl = jest.fn(() => 'https://example-bucket.s3.amazonaws.com/signed-url') as jest.Mock
// Body is a real fs.ReadStream (uploadToS3 streams the artifact rather than buffering it into
// memory — see the review that caught the OOM risk). Capture its bytes synchronously via its own
// .path at call time, since the underlying temp file is deleted by the time assertions run.
let uploadedBytes: Buffer | undefined
// s3.upload(), not putObject() — see uploadToS3's own comment on why putObject + a raw ReadStream
// isn't retry-safe in aws-sdk v2.
const s3Upload = jest.fn((params: { Body: { path: string } }) => {
  uploadedBytes = readFileSync(params.Body.path)
  return { promise: s3UploadPromise }
}) as jest.Mock

jest.unstable_mockModule('aws-sdk', () => ({
  S3: jest.fn(() => ({
    upload: s3Upload,
    getSignedUrl,
  })),
}))

const storeClose = jest.fn(async () => undefined) as jest.Mock
// Store.provision must actually create a file at the given sqlite:// path — gzipAndChecksum
// reads it afterwards. Content is arbitrary; only its presence/bytes matter for this test.
const storeProvision = jest.fn(async (options: { uri: string }) => {
  const path = options.uri.replace('sqlite://', '')
  writeFileSync(path, 'fake-wallet-export-content')
  return { close: storeClose }
}) as jest.Mock

// Import-side Store mock. importedStoreClose/importedStoreListProfiles/importedStoreCopyProfile
// are reassigned per-test (via a mutable holder) so different tests can simulate different
// artifact contents without redeclaring the whole askar-shared mock.
const importedStoreClose = jest.fn(async () => undefined) as jest.Mock
// Default is a placeholder — every test that uses it overwrites `.impl` in beforeEach, since
// PROFILE isn't declared until further down this file.
const importedStoreListProfilesHolder = { impl: jest.fn(async () => [] as string[]) as jest.Mock }
const importedStoreCopyProfile = jest.fn(async () => undefined) as jest.Mock
const storeOpen = jest.fn(async () => ({
  close: importedStoreClose,
  listProfiles: importedStoreListProfilesHolder.impl,
  copyProfile: importedStoreCopyProfile,
})) as jest.Mock

jest.unstable_mockModule('@openwallet-foundation/askar-shared', () => ({
  Store: { provision: storeProvision, open: storeOpen },
  StoreKeyMethod: jest.fn(),
  KdfMethod: { Raw: 'raw', Argon2IMod: 'argon2i-mod' },
}))

const fetchMock = jest.fn() as jest.Mock
jest.unstable_mockModule('node-fetch', () => ({
  default: fetchMock,
}))

const { WalletPortabilityService } = await import('../WalletPortabilityService')
const { WalletPortabilityJobStatus } = await import('../WalletPortabilityTypes')

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TENANT_ID = 'tenant-under-test'
const PROFILE = `tenant-${TENANT_ID}`
const PASS_KEY = 'caller-supplied-pass-key'

const makeLogger = () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
})

// copyProfileImpl lets each test control success/failure without re-declaring the whole agent mock.
function makeAgent(copyProfileImpl: jest.Mock, renameProfileImpl?: jest.Mock) {
  const baseStore = {
    copyProfile: copyProfileImpl,
    renameProfile: renameProfileImpl ?? (jest.fn(async () => undefined) as jest.Mock),
  }
  const askarStoreManager = {
    getInitializedStoreWithProfile: jest.fn(async () => ({ store: baseStore, profile: PROFILE })),
  }

  return {
    baseStore,
    agent: {
      modules: {
        tenants: {
          withTenantAgent: jest.fn(async (_options: { tenantId: string }, cb: (a: unknown) => Promise<void>) => {
            const tenantAgent = {
              context: {
                dependencyManager: {
                  resolve: jest.fn(() => askarStoreManager),
                },
              },
            }
            await cb(tenantAgent)
          }),
        },
      },
    },
  }
}

// Builds a fake node-fetch Response carrying `content` as a real Node stream, for downloadAndChecksum.
function makeFetchResponse(content: Buffer, options: { ok?: boolean; status?: number } = {}) {
  return {
    ok: options.ok ?? true,
    status: options.status ?? 200,
    body: Readable.from(content),
  }
}

function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex')
}

async function waitForJobStatus(
  service: InstanceType<typeof WalletPortabilityService>,
  jobId: string,
  status: string,
  timeoutMs = 5000,
) {
  const start = Date.now()

  while (true) {
    const job = await service.getJobStatus(jobId)
    if (job?.status === status) return job
    if (Date.now() - start > timeoutMs) {
      throw new Error(
        `Timed out waiting for job ${jobId} to reach status '${status}', last seen: ${job?.status}, error: ${job?.error}`,
      )
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  process.env.AWS_WALLET_EXPORT_BUCKET = 'test-wallet-export-bucket'
  uploadedBytes = undefined
})

describe('WalletPortabilityService — exportWallet', () => {
  it('returns a Pending job id immediately, without waiting for the export to finish', async () => {
    const copyProfile = jest.fn(async () => undefined)
    const { agent } = makeAgent(copyProfile)
    const service = new WalletPortabilityService(makeLogger() as never)

    const result = await service.exportWallet(agent as never, TENANT_ID, PASS_KEY)

    expect(result.status).toBe(WalletPortabilityJobStatus.Pending)
    expect(typeof result.jobId).toBe('string')
    // Drain the fire-and-forget background work before the test ends, so it can't complete
    // during a *later* test and pollute that test's assertions on the shared S3/Store mocks.
    await waitForJobStatus(service, result.jobId, WalletPortabilityJobStatus.Completed)
    expect(result.jobId.length).toBeGreaterThan(0)
  })

  it('on success: reaches Completed with a downloadUrl + checksum, uploads to S3, and closes the temp store', async () => {
    const copyProfile = jest.fn(async () => undefined)
    const { agent } = makeAgent(copyProfile)
    const service = new WalletPortabilityService(makeLogger() as never)

    const { jobId } = await service.exportWallet(agent as never, TENANT_ID, PASS_KEY)
    const job = await waitForJobStatus(service, jobId, WalletPortabilityJobStatus.Completed)

    expect(copyProfile).toHaveBeenCalledWith(expect.objectContaining({ fromProfile: PROFILE, toProfile: PROFILE }))
    // Locks in the passKey fix: the temp store must be provisioned with the caller's passKey,
    // not an internally generated one that would never be exposed back to the caller.
    expect(storeProvision).toHaveBeenCalledWith(expect.objectContaining({ passKey: PASS_KEY }))
    expect(job.downloadUrl).toBe('https://example-bucket.s3.amazonaws.com/signed-url')
    expect(job.checksum).toMatch(/^[0-9a-f]{64}$/) // sha256 hex digest
    expect(s3Upload).toHaveBeenCalledTimes(1)
    expect(s3UploadPromise).toHaveBeenCalledTimes(1)
    expect(getSignedUrl).toHaveBeenCalledTimes(1)
    expect(storeClose).toHaveBeenCalledTimes(1) // temp store closed, never left open

    const uploadedKey = (s3Upload.mock.calls[0][0] as { Key: string }).Key
    expect(uploadedKey).toContain(TENANT_ID)
    expect(uploadedKey).toContain(jobId)

    // The checksum must match the *uploaded* bytes (the gzip artifact), not the plaintext
    // source — otherwise a downstream verify-on-download (e.g. the import flow) never matches.
    expect(uploadedBytes).toBeDefined()
    expect(job.checksum).toBe(
      createHash('sha256')
        .update(uploadedBytes as Buffer)
        .digest('hex'),
    )
  })

  it('preserves s3Key/checksum when setJobStatus re-saves an already-Completed job from a different call site', async () => {
    const copyProfile = jest.fn(async () => undefined)
    const agent = makeAgent(copyProfile)
    const service = new WalletPortabilityService(makeLogger() as never)

    const { jobId } = await service.exportWallet(agent as never, TENANT_ID, PASS_KEY)
    await waitForJobStatus(service, jobId, WalletPortabilityJobStatus.Completed)

    // setJobStatus is private -- this models a call site outside runExport (e.g. a future
    // job-level timeout) re-saving the job's status after it has already completed. See the
    // #72 review: this used to rebuild the whole record from scratch and silently drop
    // s3Key/checksum, which getJobStatus's downloadUrl requires (job.status === Completed &&
    // job.s3Key) -- so a completed export becomes unreachable through the API after any such
    // re-save.
    await (
      service as unknown as {
        setJobStatus: (jobId: string, tenantId: string, status: string, error?: string) => Promise<void>
      }
    ).setJobStatus(jobId, TENANT_ID, WalletPortabilityJobStatus.Completed)

    const job = await service.getJobStatus(jobId)
    expect(job?.downloadUrl).toBe('https://example-bucket.s3.amazonaws.com/signed-url')
    expect(job?.checksum).toMatch(/^[0-9a-f]{64}$/)
  })

  it('on failure: reaches Failed with a sanitized error code (not the raw exception), logs the real error server-side, and never uploads a partial artifact', async () => {
    // #72 review: the job record is externally readable via getJobStatus, so it must never carry
    // raw Askar/filesystem/AWS error text (paths, bucket names, stack traces) — only a stable
    // sanitized code. The real error must still reach the server-side log, just not the caller.
    const copyProfile = jest.fn(async () => {
      throw new Error('simulated Askar failure')
    })
    const { agent } = makeAgent(copyProfile)
    const logger = makeLogger()
    const service = new WalletPortabilityService(logger as never)

    const { jobId } = await service.exportWallet(agent as never, TENANT_ID, PASS_KEY)
    const job = await waitForJobStatus(service, jobId, WalletPortabilityJobStatus.Failed)

    expect(job.error).toBe('EXPORT_FAILED')
    expect(job.error).not.toContain('simulated Askar failure')
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('simulated Askar failure'))
    expect(job.downloadUrl).toBeUndefined()
    expect(s3Upload).not.toHaveBeenCalled()
  })

  it('never holds the tenant session open outside withTenantAgent — copyProfile happens inside the callback', async () => {
    const callOrder: string[] = []
    const copyProfile = jest.fn(async () => {
      callOrder.push('copyProfile')
    })
    const { agent } = makeAgent(copyProfile)
    const originalWithTenantAgent = agent.modules.tenants.withTenantAgent
    agent.modules.tenants.withTenantAgent = jest.fn(async (options, cb) => {
      callOrder.push('withTenantAgent:start')
      const result = await (originalWithTenantAgent as unknown as (o: unknown, c: unknown) => Promise<unknown>)(
        options,
        cb,
      )
      callOrder.push('withTenantAgent:end')
      return result
    }) as never

    const service = new WalletPortabilityService(makeLogger() as never)
    const { jobId } = await service.exportWallet(agent as never, TENANT_ID, PASS_KEY)
    await waitForJobStatus(service, jobId, WalletPortabilityJobStatus.Completed)

    expect(callOrder).toEqual(['withTenantAgent:start', 'copyProfile', 'withTenantAgent:end'])
  })
})

describe('WalletPortabilityService — importWallet', () => {
  const artifact = Buffer.from('fake-wallet-import-content')
  const gzippedArtifact = gzipSync(artifact)
  const CHECKSUM = sha256(gzippedArtifact)
  const EXPORT_URL = 'https://example-bucket.s3.amazonaws.com/some-export.db.gz'

  beforeEach(() => {
    importedStoreListProfilesHolder.impl = jest.fn(async () => [PROFILE]) as jest.Mock
    fetchMock.mockImplementation(async () => makeFetchResponse(gzippedArtifact))
  })

  it('returns a Pending job id immediately, without waiting for the import to finish', async () => {
    const copyProfile = jest.fn(async () => undefined)
    const { agent } = makeAgent(copyProfile)
    const service = new WalletPortabilityService(makeLogger() as never)

    const result = await service.importWallet(agent as never, TENANT_ID, EXPORT_URL, PASS_KEY, CHECKSUM)

    expect(result.status).toBe(WalletPortabilityJobStatus.Pending)
    expect(typeof result.jobId).toBe('string')
    await waitForJobStatus(service, result.jobId, WalletPortabilityJobStatus.Completed)
  })

  it('on success: renames the current profile aside, copies the imported profile in, and reports backupProfile', async () => {
    const copyProfile = jest.fn(async () => undefined)
    const renameProfile = jest.fn(async () => undefined)
    const { agent } = makeAgent(copyProfile, renameProfile)
    const service = new WalletPortabilityService(makeLogger() as never)

    const { jobId } = await service.importWallet(agent as never, TENANT_ID, EXPORT_URL, PASS_KEY, CHECKSUM)
    const job = await waitForJobStatus(service, jobId, WalletPortabilityJobStatus.Completed)

    expect(fetchMock).toHaveBeenCalledWith(EXPORT_URL)
    expect(storeOpen).toHaveBeenCalledWith(expect.objectContaining({ passKey: PASS_KEY }))
    expect(renameProfile).toHaveBeenCalledWith({ fromProfile: PROFILE, toProfile: job.backupProfile })
    expect(importedStoreCopyProfile).toHaveBeenCalledWith(
      expect.objectContaining({ fromProfile: PROFILE, toProfile: PROFILE }),
    )
    expect(job.backupProfile).toContain(PROFILE)
    expect(job.backupProfile).toContain(jobId)
    expect(importedStoreClose).toHaveBeenCalledTimes(1) // downloaded store closed, never left open
  })

  it('checksum mismatch: fails before touching the base store at all (no rename, no copy)', async () => {
    const copyProfile = jest.fn(async () => undefined)
    const renameProfile = jest.fn(async () => undefined)
    const { agent } = makeAgent(copyProfile, renameProfile)
    const service = new WalletPortabilityService(makeLogger() as never)

    const { jobId } = await service.importWallet(
      agent as never,
      TENANT_ID,
      EXPORT_URL,
      PASS_KEY,
      'deliberately-wrong-checksum',
    )
    const job = await waitForJobStatus(service, jobId, WalletPortabilityJobStatus.Failed)

    expect(job.error).toContain('Checksum mismatch')
    expect(renameProfile).not.toHaveBeenCalled()
    expect(importedStoreCopyProfile).not.toHaveBeenCalled()
    expect(storeOpen).not.toHaveBeenCalled()
  })

  it('artifact missing the expected profile: fails clearly, before any rename', async () => {
    importedStoreListProfilesHolder.impl = jest.fn(async () => ['some-other-profile']) as jest.Mock
    const copyProfile = jest.fn(async () => undefined)
    const renameProfile = jest.fn(async () => undefined)
    const { agent } = makeAgent(copyProfile, renameProfile)
    const service = new WalletPortabilityService(makeLogger() as never)

    const { jobId } = await service.importWallet(agent as never, TENANT_ID, EXPORT_URL, PASS_KEY, CHECKSUM)
    const job = await waitForJobStatus(service, jobId, WalletPortabilityJobStatus.Failed)

    expect(job.error).toContain('does not contain expected profile')
    expect(renameProfile).not.toHaveBeenCalled()
    expect(importedStoreCopyProfile).not.toHaveBeenCalled()
  })

  it('copyProfile failure after the rename: rolls back — renames the backup profile back to the real name', async () => {
    // Import's copyProfile is called on the *downloaded* store (importedStoreCopyProfile),
    // not baseStore.copyProfile — that one is only ever used by export.
    importedStoreCopyProfile.mockImplementation(async () => {
      throw new Error('simulated copy failure')
    })
    const copyProfile = jest.fn(async () => undefined)
    const renameProfile = jest.fn(async () => undefined)
    const { agent } = makeAgent(copyProfile, renameProfile)
    const service = new WalletPortabilityService(makeLogger() as never)

    const { jobId } = await service.importWallet(agent as never, TENANT_ID, EXPORT_URL, PASS_KEY, CHECKSUM)
    const job = await waitForJobStatus(service, jobId, WalletPortabilityJobStatus.Failed)

    expect(job.error).toContain('simulated copy failure')
    // Two renameProfile calls: the initial rename-aside, then the rollback renaming it back.
    expect(renameProfile).toHaveBeenCalledTimes(2)
    const [firstCall, secondCall] = renameProfile.mock.calls as unknown as {
      fromProfile: string
      toProfile: string
    }[][]
    expect(firstCall[0]).toEqual({ fromProfile: PROFILE, toProfile: expect.stringContaining(PROFILE) })
    // The rollback call reverses the first: the backup name becomes fromProfile, the real
    // profile name becomes toProfile again.
    expect(secondCall[0]).toEqual({ fromProfile: firstCall[0].toProfile, toProfile: PROFILE })
  })
})
