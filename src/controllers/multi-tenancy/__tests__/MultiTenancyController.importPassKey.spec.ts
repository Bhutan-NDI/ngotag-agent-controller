/**
 * Regression test: importTenantWallet must enforce the same passKey minimum length as export (see
 * MultiTenancyController.exportPassKey.spec.ts). This is the same passKey the caller supplied at
 * export time, so accepting a weak one here would make export's own MIN_PASSKEY_LENGTH floor
 * bypassable by going straight to import instead.
 */
import { jest } from '@jest/globals'

import { MultiTenancyController } from '../MultiTenancyController'

describe('MultiTenancyController.importTenantWallet — passKey minimum length', () => {
  const makeRequest = () => ({}) as never
  const validBody = { exportUrl: 'https://example.com/export.db.gz', checksum: 'a'.repeat(64) }

  it('rejects a passKey shorter than the minimum with 400, before touching the agent', async () => {
    const controller = new MultiTenancyController()
    const badRequestError = jest.fn((status: number, body: unknown) => ({ status, body })) as never

    await controller.importTenantWallet(makeRequest(), 'tenant-1', { ...validBody, passKey: 'a' }, badRequestError)

    expect(badRequestError).toHaveBeenCalledWith(
      400,
      expect.objectContaining({ reason: expect.stringContaining('at least') }),
    )
  })

  it('rejects an empty passKey with 400 (pre-existing behavior, unchanged)', async () => {
    const controller = new MultiTenancyController()
    const badRequestError = jest.fn((status: number, body: unknown) => ({ status, body })) as never

    await controller.importTenantWallet(makeRequest(), 'tenant-1', { ...validBody, passKey: '' }, badRequestError)

    expect(badRequestError).toHaveBeenCalledWith(400, expect.objectContaining({ reason: expect.any(String) }))
  })

  it('does not reject a passKey at or above the minimum length on this check alone', async () => {
    const controller = new MultiTenancyController()
    const badRequestError = jest.fn((status: number, body: unknown) => ({ status, body })) as never

    await expect(
      controller.importTenantWallet(
        makeRequest(),
        'tenant-1',
        { ...validBody, passKey: 'a'.repeat(16) },
        badRequestError,
      ),
    ).rejects.toThrow()
    expect(badRequestError).not.toHaveBeenCalled()
  })
})
