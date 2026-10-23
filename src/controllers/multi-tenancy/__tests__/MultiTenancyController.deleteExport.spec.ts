import { jest } from '@jest/globals'

import { ConflictError } from '../../../errors/errors'
import { WalletPortabilityJobConflictError } from '../../../services/wallet-portability/WalletPortabilityTypes'

const deleteExport = jest.fn<(tenantId: string, jobId: string) => Promise<unknown>>()
jest.unstable_mockModule('../../../services/wallet-portability/WalletPortabilityService', () => ({
  getWalletPortabilityService: () => ({ deleteExport }),
}))

const { MultiTenancyController } = await import('../MultiTenancyController')

describe('MultiTenancyController.deleteExportedWallet', () => {
  const notFound = jest.fn((status: number, body: unknown) => ({ status, body })) as never

  beforeEach(() => {
    deleteExport.mockReset().mockResolvedValue({ jobId: 'j1', deleted: true })
  })

  it('returns the service result', async () => {
    await expect(new MultiTenancyController().deleteExportedWallet('t1', 'j1', notFound)).resolves.toEqual({
      jobId: 'j1',
      deleted: true,
    })
    expect(deleteExport).toHaveBeenCalledWith('t1', 'j1')
  })

  it('answers 404 when the job is not an export of that tenant', async () => {
    deleteExport.mockResolvedValue(undefined)

    await new MultiTenancyController().deleteExportedWallet('t1', 'j1', notFound)

    expect(notFound).toHaveBeenCalledWith(404, expect.objectContaining({ reason: expect.stringContaining('j1') }))
  })

  it('answers 409 while the export is still running', async () => {
    deleteExport.mockRejectedValue(new WalletPortabilityJobConflictError('t1', 'j1'))

    const error = await new MultiTenancyController().deleteExportedWallet('t1', 'j1', notFound).catch((e) => e)

    expect(error).toBeInstanceOf(ConflictError)
  })
})
