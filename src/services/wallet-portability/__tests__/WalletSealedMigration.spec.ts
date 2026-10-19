/**
 * End-to-end test of the sealed export -> root wallet import path against the real native Askar binding.
 * Only S3 is stubbed (the artifact is copied through the local filesystem); the tenant agent is a thin fake
 * that hands the export a real Askar store, and the import target is a real root agent.
 */
import '@openwallet-foundation/askar-nodejs'
import { AskarModule, AskarStoreManager } from '@credo-ts/askar'
import { Agent, LogLevel } from '@credo-ts/core'
import { agentDependencies } from '@credo-ts/node'
import { jest } from '@jest/globals'
import { askar } from '@openwallet-foundation/askar-nodejs'
import { Key, KeyAlgorithm, KdfMethod, Store, StoreKeyMethod } from '@openwallet-foundation/askar-shared'
import { randomUUID } from 'crypto'
import { createReadStream, promises as fs } from 'fs'
import * as os from 'os'
import * as path from 'path'

import { TsLogger } from '../../../utils/logger'
import { ImportSessionStore } from '../ImportSessionStore'
import { WalletPortabilityJobStore } from '../WalletPortabilityJobStore'
import { ROOT_IMPORT_SCOPE_ID, WalletPortabilityService } from '../WalletPortabilityService'
import {
  ArtifactChecksumMismatchError,
  ImportSessionNotFoundError,
  StorageVersionMismatchError,
  TargetNotPristineError,
  WalletPortabilityJobStatus,
} from '../WalletPortabilityTypes'
import { InvalidRecipientKeyError } from '../sealedStoreKey'

const TENANT_ID = 'abc'
const TENANT_PROFILE = `tenant-${TENANT_ID}`

type Internals = {
  uploadToS3: (filePath: string, key: string) => Promise<void>
  getPresignedUrl: (key: string) => string
  downloadAndChecksum: (url: string, destPath: string) => Promise<string>
}

describe('sealed export -> root wallet import (real Askar)', () => {
  let workDir: string
  let artifactPath: string
  let service: WalletPortabilityService
  let sourceStore: Store
  const agents: Agent[] = []

  const fakeTenantAgent = () => ({
    modules: {
      tenants: {
        getTenantById: async () => ({ storageVersion: '0.5' }),
        withTenantAgent: async (_options: unknown, callback: (tenantAgent: unknown) => Promise<void>) =>
          callback({
            context: {
              dependencyManager: {
                resolve: () => ({
                  getInitializedStoreWithProfile: async () => ({ store: sourceStore, profile: TENANT_PROFILE }),
                }),
              },
            },
          }),
      },
    },
  })

  const buildRootAgent = async (withExtraRecord = false): Promise<Agent> => {
    const agent = new Agent({
      config: {},
      dependencies: agentDependencies,
      modules: {
        askar: new AskarModule({
          askar,
          store: { id: `root-${randomUUID()}`, key: 'root-store-key-0000000000000000' },
        }),
      },
    })
    await agent.initialize()
    await agent.genericRecords.save({ content: { secretKey: 'original-jwt-secret' }, tags: { hasSecretKey: 'true' } })
    if (withExtraRecord) {
      await agent.genericRecords.save({ content: { note: 'existing data' }, tags: { other: 'x' } })
    }
    agents.push(agent)
    return agent
  }

  const rootEntries = async (agent: Agent) => {
    const { store, profile } = await agent.context.dependencyManager
      .resolve(AskarStoreManager)
      .getInitializedStoreWithProfile(agent.context)
    const session = await store.session(profile).open()
    try {
      return await session.fetchAll({})
    } finally {
      await session.close()
    }
  }

  const waitForJob = async (jobId: string) => {
    for (let attempt = 0; attempt < 300; attempt += 1) {
      const job = await service.getJobStatus(jobId)
      if (job && [WalletPortabilityJobStatus.Completed, WalletPortabilityJobStatus.Failed].includes(job.status)) {
        return job
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    throw new Error(`job ${jobId} did not finish`)
  }

  // Runs the sealed export against a fresh recipient session and returns what the platform would relay.
  const exportFor = async (importPublicKey: string) => {
    const exported = await service.exportWallet(
      fakeTenantAgent() as never,
      TENANT_ID,
      undefined,
      undefined,
      importPublicKey,
    )
    const job = await waitForJob(exported.jobId)
    expect(job.status).toBe(WalletPortabilityJobStatus.Completed)
    return job
  }

  beforeAll(async () => {
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sealed-migration-'))
    artifactPath = path.join(workDir, 'artifact.db.gz')

    sourceStore = await Store.provision({
      uri: `sqlite://${path.join(workDir, 'source.db')}`,
      keyMethod: new StoreKeyMethod(KdfMethod.Raw),
      passKey: Store.generateRawKey(),
      recreate: true,
      profile: TENANT_PROFILE,
    })
    const session = await sourceStore.transaction(TENANT_PROFILE).open()
    await session.insert({
      category: 'ConnectionRecord',
      name: 'c1',
      value: JSON.stringify({ a: 1 }),
      tags: { t: 'v' },
    })
    await session.insert({ category: 'ConnectionRecord', name: 'c2', value: JSON.stringify({ a: 2 }), tags: {} })
    await session.insert({ category: 'DidRecord', name: 'd1', value: JSON.stringify({ did: 'did:peer:1' }), tags: {} })
    await session.insert({
      category: 'GenericRecord',
      name: 'g1',
      value: JSON.stringify({ content: { secretKey: 'tenant' } }),
      tags: { hasSecretKey: 'true' },
    })
    const key = Key.generate(KeyAlgorithm.Ed25519)
    await session.insertKey({ name: 'key-1', key, tags: { purpose: 'test' } })
    await session.commit()

    // The constructor builds an AWS client, which the ESM test runtime cannot load; S3 is stubbed below anyway.
    const logger = new TsLogger(LogLevel.error, 'test')
    service = Object.assign(Object.create(WalletPortabilityService.prototype), {
      logger,
      jobStore: new WalletPortabilityJobStore(logger, undefined),
      importSessions: new ImportSessionStore(),
    }) as WalletPortabilityService
    const internals = service as unknown as Internals
    internals.uploadToS3 = async (filePath) => {
      await fs.copyFile(filePath, artifactPath)
    }
    internals.getPresignedUrl = () => 'https://export-bucket.s3.amazonaws.com/artifact'
  }, 60000)

  afterAll(async () => {
    await sourceStore.close().catch(() => undefined)
    for (const agent of agents) await agent.shutdown().catch(() => undefined)
    await service.disconnect()
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => undefined)
  })

  const serveArtifact = (checksum: string) => {
    ;(service as unknown as Internals).downloadAndChecksum = async (_url, destPath) => {
      await fs.copyFile(artifactPath, destPath)
      return checksum
    }
  }

  it('moves every record and key into a pristine root wallet and keeps the target secret', async () => {
    const root = await buildRootAgent()
    const session = await service.createImportSession(root)

    const exportJob = await exportFor(session.importPublicKey)
    expect(exportJob.sealedStoreKey).toBeTruthy()
    expect(exportJob.storageVersion).toBe('0.5')
    serveArtifact(exportJob.checksum as string)

    const imported = await service.importRootWallet(root, {
      sessionId: session.sessionId,
      exportUrl: 'https://export-bucket.s3.amazonaws.com/artifact',
      checksum: exportJob.checksum as string,
      sealedStoreKey: exportJob.sealedStoreKey as string,
      storageVersion: exportJob.storageVersion as string,
      dryRun: false,
    })
    const job = await waitForJob(imported.jobId)

    expect(job).toMatchObject({ status: WalletPortabilityJobStatus.Completed, tenantId: ROOT_IMPORT_SCOPE_ID })
    expect(job.counts).toEqual({ entries: 3, keys: 1, skipped: 1 })

    const entries = await rootEntries(root)
    expect(
      entries
        .filter((entry) => 'ConnectionRecord' === entry.category)
        .map((entry) => entry.name)
        .sort(),
    ).toEqual(['c1', 'c2'])
    expect(entries.some((entry) => 'DidRecord' === entry.category && 'd1' === entry.name)).toBe(true)
    const secrets = entries.filter(
      (entry) => 'GenericRecord' === entry.category && undefined !== entry.tags.hasSecretKey,
    )
    expect(secrets.map((entry) => JSON.parse(entry.value as string).content.secretKey)).toEqual(['original-jwt-secret'])
    expect(entries.filter((entry) => 'StorageVersionRecord' === entry.category)).toHaveLength(1)

    const { store, profile } = await root.context.dependencyManager
      .resolve(AskarStoreManager)
      .getInitializedStoreWithProfile(root.context)
    const keySession = await store.session(profile).open()
    const keys = await keySession.fetchAllKeys({})
    expect(keys.map((entry) => entry.name)).toEqual(['key-1'])
    keys.forEach((entry) => entry.key.handle.free())
    await keySession.close()

    await expect(service.createImportSession(root)).rejects.toThrow(TargetNotPristineError)
  }, 60000)

  it('dry run reports the counts and leaves the root wallet untouched', async () => {
    const root = await buildRootAgent()
    const session = await service.createImportSession(root)
    const exportJob = await exportFor(session.importPublicKey)
    serveArtifact(exportJob.checksum as string)
    const before = (await rootEntries(root)).length

    const imported = await service.importRootWallet(root, {
      sessionId: session.sessionId,
      exportUrl: 'https://export-bucket.s3.amazonaws.com/artifact',
      checksum: exportJob.checksum as string,
      sealedStoreKey: exportJob.sealedStoreKey as string,
      storageVersion: '0.5',
      dryRun: true,
    })
    const job = await waitForJob(imported.jobId)

    expect(job).toMatchObject({ status: WalletPortabilityJobStatus.Completed, dryRun: true })
    expect(job.counts).toEqual({ entries: 3, keys: 1, skipped: 1 })
    expect(await rootEntries(root)).toHaveLength(before)
    await expect(service.createImportSession(root)).resolves.toBeDefined()
  }, 60000)

  it('fails the job and writes nothing when the store key was sealed to a different recipient', async () => {
    const root = await buildRootAgent()
    const session = await service.createImportSession(root)
    const otherSession = await service.createImportSession(await buildRootAgent())
    const exportJob = await exportFor(otherSession.importPublicKey)
    serveArtifact(exportJob.checksum as string)
    const before = (await rootEntries(root)).length

    const imported = await service.importRootWallet(root, {
      sessionId: session.sessionId,
      exportUrl: 'https://export-bucket.s3.amazonaws.com/artifact',
      checksum: exportJob.checksum as string,
      sealedStoreKey: exportJob.sealedStoreKey as string,
      storageVersion: '0.5',
      dryRun: false,
    })
    const job = await waitForJob(imported.jobId)

    expect(job).toMatchObject({ status: WalletPortabilityJobStatus.Failed, error: 'IMPORT_FAILED' })
    expect(await rootEntries(root)).toHaveLength(before)
  }, 60000)

  it('imports an artifact pushed as a stream, without touching S3', async () => {
    const root = await buildRootAgent()
    const session = await service.createImportSession(root)
    const exportJob = await exportFor(session.importPublicKey)

    const pushed = await service.importRootWalletFromUpload(root, createReadStream(artifactPath), {
      sessionId: session.sessionId,
      checksum: exportJob.checksum as string,
      sealedStoreKey: exportJob.sealedStoreKey as string,
      storageVersion: '0.5',
      dryRun: false,
    })
    const job = await waitForJob(pushed.jobId)

    expect(job).toMatchObject({ status: WalletPortabilityJobStatus.Completed })
    expect(job.counts).toEqual({ entries: 3, keys: 1, skipped: 1 })
    expect((await rootEntries(root)).some((entry) => 'DidRecord' === entry.category)).toBe(true)
  }, 60000)

  it('rejects a pushed artifact whose checksum does not match and keeps the session usable', async () => {
    const root = await buildRootAgent()
    const session = await service.createImportSession(root)
    const exportJob = await exportFor(session.importPublicKey)
    const options = {
      sessionId: session.sessionId,
      sealedStoreKey: exportJob.sealedStoreKey as string,
      storageVersion: '0.5',
      dryRun: false,
    }

    await expect(
      service.importRootWalletFromUpload(root, createReadStream(artifactPath), {
        ...options,
        checksum: 'b'.repeat(64),
      }),
    ).rejects.toThrow(ArtifactChecksumMismatchError)

    const retry = await service.importRootWalletFromUpload(root, createReadStream(artifactPath), {
      ...options,
      checksum: exportJob.checksum as string,
    })
    expect((await waitForJob(retry.jobId)).status).toBe(WalletPortabilityJobStatus.Completed)
  }, 60000)

  it('refuses a root wallet that already holds data', async () => {
    const root = await buildRootAgent(true)
    await expect(service.createImportSession(root)).rejects.toThrow(TargetNotPristineError)
  }, 60000)

  it('refuses an unknown session and a storage version it does not run', async () => {
    const root = await buildRootAgent()
    const params = {
      exportUrl: 'https://export-bucket.s3.amazonaws.com/artifact',
      checksum: 'a'.repeat(64),
      sealedStoreKey: 'AAAA',
      dryRun: false,
    }
    await expect(
      service.importRootWallet(root, { ...params, sessionId: randomUUID(), storageVersion: '0.5' }),
    ).rejects.toThrow(ImportSessionNotFoundError)

    const session = await service.createImportSession(root)
    await expect(
      service.importRootWallet(root, { ...params, sessionId: session.sessionId, storageVersion: '0.1' }),
    ).rejects.toThrow(StorageVersionMismatchError)
  }, 60000)

  it('rejects a malformed recipient key before starting an export', async () => {
    await expect(
      service.exportWallet(fakeTenantAgent() as never, TENANT_ID, undefined, undefined, 'not-a-key'),
    ).rejects.toThrow(InvalidRecipientKeyError)
  })
})
