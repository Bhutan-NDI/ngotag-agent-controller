/**
 * Regression test — #72 review: exportTenantWallet accepted any non-empty passKey, including
 * one-character passphrases like "a". Argon2i derives a real encryption key from whatever string
 * is supplied (see WalletPortabilityService#runExport), so a weak passKey is practical to
 * brute-force offline against an artifact that otherwise sits in S3. Fixed with a minimum-length
 * floor, checked before the tenant/agent is ever touched.
 */
import { jest } from '@jest/globals'

import { MultiTenancyController } from '../MultiTenancyController'

describe('MultiTenancyController.exportTenantWallet — passKey minimum length', () => {
  const makeRequest = () => ({}) as never

  it('rejects a passKey shorter than the minimum with 400, before touching the agent', async () => {
    const controller = new MultiTenancyController()
    const badRequestError = jest.fn((status: number, body: unknown) => ({ status, body })) as never

    await controller.exportTenantWallet(makeRequest(), 'tenant-1', { passKey: 'a' }, badRequestError)

    expect(badRequestError).toHaveBeenCalledWith(
      400,
      expect.objectContaining({ reason: expect.stringContaining('at least') }),
    )
  })

  it('rejects an empty passKey with 400 (pre-existing behavior, unchanged)', async () => {
    const controller = new MultiTenancyController()
    const badRequestError = jest.fn((status: number, body: unknown) => ({ status, body })) as never

    await controller.exportTenantWallet(makeRequest(), 'tenant-1', { passKey: '' }, badRequestError)

    expect(badRequestError).toHaveBeenCalledWith(400, expect.objectContaining({ reason: expect.any(String) }))
  })

  it('does not reject a passKey at or above the minimum length on this check alone', async () => {
    // Confirms the guard is a length check, not an accidental over-broad rejection — a
    // long-enough passKey must sail past this specific validation (the request will still fail
    // downstream via request.agent, which is intentionally not mocked here; asserting it
    // is NOT the length-rejection error is enough to prove the boundary is correct).
    const controller = new MultiTenancyController()
    const badRequestError = jest.fn((status: number, body: unknown) => ({ status, body })) as never

    await expect(
      controller.exportTenantWallet(makeRequest(), 'tenant-1', { passKey: 'a'.repeat(16) }, badRequestError),
    ).rejects.toThrow()
    expect(badRequestError).not.toHaveBeenCalled()
  })
})
