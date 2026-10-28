import { jest } from '@jest/globals'

import { probeExportBucket } from '../exportBucketProbe'

const answering = (status: number) => (async () => new Response(null, { status })) as unknown as typeof fetch

const failing = (code: string) =>
  (async () => {
    throw Object.assign(new TypeError('fetch failed'), { cause: { code } })
  }) as unknown as typeof fetch

describe('probeExportBucket', () => {
  it.each([undefined, '', 'UPPER_CASE', 'a', 'has space', '../etc'])('is not configured for %j', async (bucket) => {
    const fetchFn = jest.fn()

    await expect(probeExportBucket(bucket, fetchFn as never)).resolves.toEqual({ configured: false })
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it.each([200, 301, 403, 404])('is reachable when the bucket answers %s, even with a refusal', async (status) => {
    await expect(probeExportBucket('org-exports', answering(status))).resolves.toEqual({
      configured: true,
      reachable: true,
    })
  })

  it('asks the bucket host with HEAD, follows no redirect and sends nothing else', async () => {
    const fetchFn = jest.fn(async () => new Response(null, { status: 403 }))

    await probeExportBucket('org-exports', fetchFn as never)

    expect(fetchFn).toHaveBeenCalledWith(
      'https://org-exports.s3.amazonaws.com/',
      expect.objectContaining({ method: 'HEAD', redirect: 'manual' }),
    )
  })

  it('probes a dotted bucket name path-style, since the virtual-hosted host cannot match the S3 certificate', async () => {
    const fetchFn = jest.fn(async () => new Response(null, { status: 403 }))

    await expect(probeExportBucket('wallet.exports.ngotag.bt', fetchFn as never)).resolves.toEqual({
      configured: true,
      reachable: true,
    })

    expect(fetchFn).toHaveBeenCalledWith(
      'https://s3.amazonaws.com/wallet.exports.ngotag.bt/',
      expect.objectContaining({ method: 'HEAD' }),
    )
  })

  it.each([
    ['ENOTFOUND', 'DNS'],
    ['EAI_AGAIN', 'DNS'],
    ['CERT_HAS_EXPIRED', 'TLS'],
    ['ERR_TLS_CERT_ALTNAME_INVALID', 'TLS'],
    ['ECONNREFUSED', 'UNREACHABLE'],
    ['ETIMEDOUT', 'UNREACHABLE'],
  ])('reports %s as %s', async (code, reason) => {
    await expect(probeExportBucket('org-exports', failing(code))).resolves.toEqual({
      configured: true,
      reachable: false,
      reason,
    })
  })

  it('reports a bucket that does not answer in time as a timeout', async () => {
    const hanging = ((_url: string, init: { signal: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new Error('aborted')))
      })) as unknown as typeof fetch

    await expect(probeExportBucket('org-exports', hanging, 20)).resolves.toEqual({
      configured: true,
      reachable: false,
      reason: 'TIMEOUT',
    })
  })

  it('reads the bucket from the environment by default', async () => {
    const original = process.env.AWS_WALLET_EXPORT_BUCKET
    process.env.AWS_WALLET_EXPORT_BUCKET = ''
    try {
      await expect(probeExportBucket()).resolves.toEqual({ configured: false })
    } finally {
      if (undefined === original) delete process.env.AWS_WALLET_EXPORT_BUCKET
      else process.env.AWS_WALLET_EXPORT_BUCKET = original
    }
  })
})
