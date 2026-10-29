import { jest } from '@jest/globals'

import { probeExportBucket } from '../exportBucketProbe'

const answering = (status: number) => (async () => new Response(null, { status })) as unknown as typeof fetch

const failing = (code: string) =>
  (async () => {
    throw Object.assign(new TypeError('fetch failed'), { cause: { code } })
  }) as unknown as typeof fetch

describe('probeExportBucket', () => {
  const originalRegion = process.env.AWS_REGION
  beforeEach(() => {
    delete process.env.AWS_REGION
  })
  afterAll(() => {
    if (undefined === originalRegion) delete process.env.AWS_REGION
    else process.env.AWS_REGION = originalRegion
  })

  it.each([undefined, '', 'UPPER_CASE', 'a', 'has space', '../etc'])('is not configured for %j', async (bucket) => {
    const fetchFn = jest.fn()

    await expect(probeExportBucket(bucket, fetchFn as never)).resolves.toEqual({ configured: false })
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it.each([200, 301, 403])('is reachable when the bucket answers %s, even with a refusal', async (status) => {
    await expect(probeExportBucket('org-exports', answering(status))).resolves.toEqual({
      configured: true,
      reachable: true,
    })
  })

  it('reports a 404 on the bucket root as a bucket that does not exist, not as reachable', async () => {
    await expect(probeExportBucket('org-exports', answering(404))).resolves.toEqual({
      configured: true,
      reachable: false,
      reason: 'NO_SUCH_BUCKET',
    })
  })

  it('asks the regional host the SDK presigns for the pull when a region is set', async () => {
    const fetchFn = jest.fn(async () => new Response(null, { status: 403 }))

    await probeExportBucket('org-exports', fetchFn as never, undefined, 'ap-southeast-1')
    await probeExportBucket('wallet.exports.ngotag.bt', fetchFn as never, undefined, 'ap-southeast-1')

    expect(fetchFn).toHaveBeenNthCalledWith(
      1,
      'https://org-exports.s3.ap-southeast-1.amazonaws.com/',
      expect.objectContaining({ method: 'HEAD' }),
    )
    expect(fetchFn).toHaveBeenNthCalledWith(
      2,
      'https://s3.ap-southeast-1.amazonaws.com/wallet.exports.ngotag.bt/',
      expect.objectContaining({ method: 'HEAD' }),
    )
  })

  it('takes the region from AWS_REGION by default', async () => {
    process.env.AWS_REGION = 'eu-west-1'
    const fetchFn = jest.fn(async () => new Response(null, { status: 403 }))

    await probeExportBucket('org-exports', fetchFn as never)

    expect(fetchFn).toHaveBeenCalledWith('https://org-exports.s3.eu-west-1.amazonaws.com/', expect.anything())
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
    ['UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'TLS'],
    ['UNABLE_TO_GET_ISSUER_CERT', 'TLS'],
    ['CERT_NOT_YET_VALID', 'TLS'],
    ['ECONNREFUSED', 'UNREACHABLE'],
    ['ETIMEDOUT', 'TIMEOUT'],
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
