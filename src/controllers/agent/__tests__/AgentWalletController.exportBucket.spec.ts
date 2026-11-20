import { jest } from '@jest/globals'

const probeExportBucket = jest.fn<() => Promise<unknown>>()

jest.unstable_mockModule('../../../services/wallet-portability/exportBucketProbe', () => ({ probeExportBucket }))

const { AgentWalletController } = await import('../AgentWalletController')

describe('AgentWalletController.getExportBucket', () => {
  it('returns what the probe found', async () => {
    probeExportBucket.mockResolvedValue({ configured: true, reachable: false, reason: 'DNS' })

    await expect(new AgentWalletController().getExportBucket()).resolves.toEqual({
      configured: true,
      reachable: false,
      reason: 'DNS',
    })
  })
})
