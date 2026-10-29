import type { WalletPortabilityJobRecord } from '../WalletPortabilityTypes'

import { LogLevel } from '@credo-ts/core'
import { jest } from '@jest/globals'

import { TsLogger } from '../../../utils/logger'
import { WalletPortabilityJobStore } from '../WalletPortabilityJobStore'
import { WalletPortabilityService } from '../WalletPortabilityService'
import {
  WalletPortabilityJobConflictError,
  WalletPortabilityJobStatus,
  WalletPortabilityJobType,
} from '../WalletPortabilityTypes'

const S3_KEY = 'wallet-exports/t1/job-1.db.gz'

describe('WalletPortabilityService.deleteExport', () => {
  const logger = new TsLogger(LogLevel.error, 'test')
  let jobStore: WalletPortabilityJobStore
  let service: WalletPortabilityService
  let deleteObject: jest.Mock<(params: { Bucket: string; Key: string }) => { promise(): Promise<unknown> }>
  let deleteResult: Promise<unknown>

  const saveJob = (overrides: Partial<WalletPortabilityJobRecord> = {}) =>
    jobStore.save({
      jobId: 'job-1',
      tenantId: 't1',
      type: WalletPortabilityJobType.Export,
      status: WalletPortabilityJobStatus.Completed,
      createdAt: '2026-10-19T00:00:00.000Z',
      updatedAt: '2026-10-19T00:00:00.000Z',
      s3Key: S3_KEY,
      checksum: 'abc',
      ...overrides,
    })

  beforeEach(() => {
    process.env.AWS_WALLET_EXPORT_BUCKET = 'export-bucket'
    deleteResult = Promise.resolve({})
    deleteObject = jest.fn(() => ({ promise: () => deleteResult }))
    jobStore = new WalletPortabilityJobStore(logger)
    service = Object.create(WalletPortabilityService.prototype) as WalletPortabilityService
    Object.assign(service, { logger, jobStore, s3: { deleteObject } })
  })

  afterEach(async () => {
    await jobStore.disconnect()
  })

  it('deletes the stored object, keeps the job record and stops advertising a download', async () => {
    await saveJob()

    await expect(service.deleteExport('t1', 'job-1')).resolves.toEqual({ jobId: 'job-1', deleted: true })

    expect(deleteObject).toHaveBeenCalledWith({ Bucket: 'export-bucket', Key: S3_KEY })
    expect(await jobStore.get('job-1')).toMatchObject({
      status: WalletPortabilityJobStatus.Completed,
      checksum: 'abc',
      artifactDeleted: true,
    })
    expect((await jobStore.get('job-1'))?.s3Key).toBeUndefined()
  })

  it('is safe to repeat and does not call S3 again', async () => {
    await saveJob()
    await service.deleteExport('t1', 'job-1')

    await expect(service.deleteExport('t1', 'job-1')).resolves.toEqual({ jobId: 'job-1', deleted: true })

    expect(deleteObject).toHaveBeenCalledTimes(1)
  })

  it('succeeds without touching S3 for a failed export that never uploaded', async () => {
    await saveJob({ status: WalletPortabilityJobStatus.Failed, s3Key: undefined, checksum: undefined })

    await expect(service.deleteExport('t1', 'job-1')).resolves.toEqual({ jobId: 'job-1', deleted: true })

    expect(deleteObject).not.toHaveBeenCalled()
  })

  it.each([WalletPortabilityJobStatus.Pending, WalletPortabilityJobStatus.InProgress])(
    'refuses with a conflict while the export is %s, and deletes nothing',
    async (status) => {
      await saveJob({ status })

      await expect(service.deleteExport('t1', 'job-1')).rejects.toBeInstanceOf(WalletPortabilityJobConflictError)

      expect(deleteObject).not.toHaveBeenCalled()
    },
  )

  it('returns undefined for an unknown job', async () => {
    await expect(service.deleteExport('t1', 'missing')).resolves.toBeUndefined()
  })

  it("returns undefined, and deletes nothing, for another tenant's job", async () => {
    await saveJob()

    await expect(service.deleteExport('t2', 'job-1')).resolves.toBeUndefined()

    expect(deleteObject).not.toHaveBeenCalled()
    expect((await jobStore.get('job-1'))?.s3Key).toBe(S3_KEY)
  })

  it('returns undefined for an import job', async () => {
    await saveJob({ type: WalletPortabilityJobType.Import })

    await expect(service.deleteExport('t1', 'job-1')).resolves.toBeUndefined()

    expect(deleteObject).not.toHaveBeenCalled()
  })

  it('keeps the object reference when S3 fails, so the delete can be retried', async () => {
    await saveJob()
    deleteResult = Promise.reject(new Error('S3 unavailable'))
    deleteResult.catch(() => undefined)

    await expect(service.deleteExport('t1', 'job-1')).rejects.toThrow('S3 unavailable')

    expect((await jobStore.get('job-1'))?.s3Key).toBe(S3_KEY)
    deleteResult = Promise.resolve({})
    await expect(service.deleteExport('t1', 'job-1')).resolves.toEqual({ jobId: 'job-1', deleted: true })
  })
})
