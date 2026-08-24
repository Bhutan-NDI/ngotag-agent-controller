/**
 * Regression test — #73 review: importTenantWallet only checked `checksum` for truthiness. A
 * malformed digest (wrong length, non-hex) still reserved the tenant's active-job slot and
 * downloaded up to MAX_DOWNLOAD_BYTES (2 GiB) before runImport's own comparison inevitably
 * failed. Also, SHA-256 hex is conceptually case-insensitive, but WalletPortabilityService's own
 * comparison (`hash.digest('hex')`, always lowercase, compared with `!==`) is case-sensitive, so
 * an uppercase-but-arithmetically-correct checksum would still fail downstream unless normalized
 * first -- matches the platform-side DTO's own identical fix.
 *
 * The lowercasing tests mock getWalletPortabilityService (a module-level function, deliberately
 * substitutable via jest.mock -- see its own docblock) to observe the exact value passed through
 * to importWallet; the rejection tests don't need that, following the same pattern as the sibling
 * MultiTenancyController.importPassKey.spec.ts.
 */
import { jest } from '@jest/globals'

const VALID_LOWERCASE_CHECKSUM = 'a1'.repeat(32) // 64 hex characters

describe('MultiTenancyController.importTenantWallet — checksum validation', () => {
  const makeRequest = () => ({}) as never
  const validBody = { exportUrl: 'https://example.com/export.db.gz', passKey: 'a'.repeat(16) }

  it('rejects a checksum that is not 64 characters long', async () => {
    const { MultiTenancyController } = await import('../MultiTenancyController')
    const controller = new MultiTenancyController()
    const badRequestError = jest.fn((status: number, body: unknown) => ({ status, body })) as never

    await controller.importTenantWallet(
      makeRequest(),
      'tenant-1',
      { ...validBody, checksum: VALID_LOWERCASE_CHECKSUM.slice(0, 63) },
      badRequestError,
    )

    expect(badRequestError).toHaveBeenCalledWith(
      400,
      expect.objectContaining({ reason: expect.stringContaining('checksum') }),
    )
  })

  it('rejects a 64-character checksum containing a non-hex character', async () => {
    const { MultiTenancyController } = await import('../MultiTenancyController')
    const controller = new MultiTenancyController()
    const badRequestError = jest.fn((status: number, body: unknown) => ({ status, body })) as never
    const notHex = `g${VALID_LOWERCASE_CHECKSUM.slice(1)}`

    await controller.importTenantWallet(makeRequest(), 'tenant-1', { ...validBody, checksum: notHex }, badRequestError)

    expect(badRequestError).toHaveBeenCalledWith(
      400,
      expect.objectContaining({ reason: expect.stringContaining('checksum') }),
    )
  })

  it('does not reject a valid lowercase 64-character hex checksum on this check alone', async () => {
    const { MultiTenancyController } = await import('../MultiTenancyController')
    const controller = new MultiTenancyController()
    const badRequestError = jest.fn((status: number, body: unknown) => ({ status, body })) as never

    await expect(
      controller.importTenantWallet(
        makeRequest(),
        'tenant-1',
        { ...validBody, checksum: VALID_LOWERCASE_CHECKSUM },
        badRequestError,
      ),
    ).rejects.toThrow()
    expect(badRequestError).not.toHaveBeenCalled()
  })

  it('does not reject an uppercase 64-character hex checksum -- SHA-256 hex is case-insensitive', async () => {
    const { MultiTenancyController } = await import('../MultiTenancyController')
    const controller = new MultiTenancyController()
    const badRequestError = jest.fn((status: number, body: unknown) => ({ status, body })) as never

    await expect(
      controller.importTenantWallet(
        makeRequest(),
        'tenant-1',
        { ...validBody, checksum: VALID_LOWERCASE_CHECKSUM.toUpperCase() },
        badRequestError,
      ),
    ).rejects.toThrow()
    expect(badRequestError).not.toHaveBeenCalled()
  })
})

describe('MultiTenancyController.importTenantWallet — checksum normalization', () => {
  const importWalletMock = jest.fn(async () => ({ jobId: 'job-1', status: 'pending' })) as never

  jest.unstable_mockModule('../../../services/wallet-portability/WalletPortabilityService', () => ({
    getWalletPortabilityService: jest.fn(() => ({ importWallet: importWalletMock })),
  }))

  const makeRequest = () =>
    ({
      agent: {
        modules: { tenants: { getTenantById: jest.fn(async () => ({ id: 'tenant-1' })) } },
      },
    }) as never

  it('lowercases an uppercase checksum before it reaches importWallet, not just before the length/shape check', async () => {
    const { MultiTenancyController } = await import('../MultiTenancyController')
    const controller = new MultiTenancyController()
    const badRequestError = jest.fn() as never
    const uppercase = VALID_LOWERCASE_CHECKSUM.toUpperCase()

    await controller.importTenantWallet(
      makeRequest(),
      'tenant-1',
      { exportUrl: 'https://example.com/export.db.gz', passKey: 'a'.repeat(16), checksum: uppercase },
      badRequestError,
    )

    expect(importWalletMock).toHaveBeenCalledWith(
      expect.anything(),
      'tenant-1',
      'https://example.com/export.db.gz',
      'a'.repeat(16),
      VALID_LOWERCASE_CHECKSUM,
    )
  })
})
