/**
 * Regression test: exportTenantWallet must not silently treat an empty walletID as absent.
 * Without this, an empty string falls through to the native (gzipped, nested-credential)
 * artifact instead of the mobile-compat one the caller asked for, with no error pointing at why.
 */
import { jest } from '@jest/globals'

import { MultiTenancyController } from '../MultiTenancyController'

describe('MultiTenancyController.exportTenantWallet — walletID must not be empty', () => {
  const makeRequest = () => ({}) as never
  const PASS_KEY = 'a'.repeat(16)

  it('rejects an empty walletID with 400, before touching the agent', async () => {
    const controller = new MultiTenancyController()
    const badRequestError = jest.fn((status: number, body: unknown) => ({ status, body })) as never

    await controller.exportTenantWallet(makeRequest(), 'tenant-1', { passKey: PASS_KEY, walletID: '' }, badRequestError)

    expect(badRequestError).toHaveBeenCalledWith(
      400,
      expect.objectContaining({ reason: expect.stringContaining('walletID') }),
    )
  })

  it('rejects a whitespace-only walletID with 400', async () => {
    const controller = new MultiTenancyController()
    const badRequestError = jest.fn((status: number, body: unknown) => ({ status, body })) as never

    await controller.exportTenantWallet(
      makeRequest(),
      'tenant-1',
      { passKey: PASS_KEY, walletID: '   ' },
      badRequestError,
    )

    expect(badRequestError).toHaveBeenCalledWith(
      400,
      expect.objectContaining({ reason: expect.stringContaining('walletID') }),
    )
  })

  it('rejects a walletID with leading/trailing whitespace -- it becomes the literal Askar profile name, and padding would silently mismatch what mobile sends', async () => {
    const controller = new MultiTenancyController()
    const badRequestError = jest.fn((status: number, body: unknown) => ({ status, body })) as never

    await controller.exportTenantWallet(
      makeRequest(),
      'tenant-1',
      { passKey: PASS_KEY, walletID: ' JigmeDorji ' },
      badRequestError,
    )

    expect(badRequestError).toHaveBeenCalledWith(
      400,
      expect.objectContaining({ reason: expect.stringContaining('whitespace') }),
    )
  })

  it('does not reject a request with no walletID at all -- native export stays optional-field, not required', async () => {
    const controller = new MultiTenancyController()
    const badRequestError = jest.fn((status: number, body: unknown) => ({ status, body })) as never

    await expect(
      controller.exportTenantWallet(makeRequest(), 'tenant-1', { passKey: PASS_KEY }, badRequestError),
    ).rejects.toThrow()
    expect(badRequestError).not.toHaveBeenCalled()
  })

  it('does not reject a non-empty walletID on this check alone', async () => {
    const controller = new MultiTenancyController()
    const badRequestError = jest.fn((status: number, body: unknown) => ({ status, body })) as never

    await expect(
      controller.exportTenantWallet(
        makeRequest(),
        'tenant-1',
        { passKey: PASS_KEY, walletID: 'JigmeDorji' },
        badRequestError,
      ),
    ).rejects.toThrow()
    expect(badRequestError).not.toHaveBeenCalled()
  })
})
