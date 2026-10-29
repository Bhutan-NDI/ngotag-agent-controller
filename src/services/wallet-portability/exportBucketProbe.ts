const PROBE_TIMEOUT_MS = 5000
const BUCKET_NAME = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/

const TLS_CODES = new Set([
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_GET_ISSUER_CERT',
  'CERT_NOT_YET_VALID',
])

export type ExportBucketProbeReason = 'DNS' | 'TLS' | 'TIMEOUT' | 'UNREACHABLE' | 'NO_SUCH_BUCKET'

export interface ExportBucketProbe {
  /** Whether a usable export bucket name is set. Without one this agent cannot pull an export from S3 at all */
  configured: boolean
  /** Whether this agent can reach the bucket over HTTPS; absent when no bucket is configured */
  reachable?: boolean
  reason?: ExportBucketProbeReason
}

/**
 * Whether this agent could pull an export from its S3 bucket. Any HTTP answer, even a refusal, means the network path
 * works; only a failure to connect does not, and a 404 on the bucket root means the bucket does not exist. Nothing is
 * read from the bucket and no credentials are involved. It asks the host the SDK presigns for the real pull, so the
 * dedicated agent's AWS_REGION must match the shared agent's.
 */
export const probeExportBucket = async (
  bucket: string | undefined = process.env.AWS_WALLET_EXPORT_BUCKET,
  fetchFn: typeof fetch = fetch,
  timeoutMs: number = PROBE_TIMEOUT_MS,
  region: string | undefined = process.env.AWS_REGION,
): Promise<ExportBucketProbe> => {
  if (!bucket || !BUCKET_NAME.test(bucket)) return { configured: false }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    // The host aws-sdk v2 presigns for the real pull: regional when AWS_REGION is set, and path-style for a dotted bucket
    // (S3's certificate covers one label).
    const endpoint = region ? `s3.${region}.amazonaws.com` : 's3.amazonaws.com'
    const url = bucket.includes('.') ? `https://${endpoint}/${bucket}/` : `https://${bucket}.${endpoint}/`
    const response = await fetchFn(url, {
      method: 'HEAD',
      redirect: 'manual',
      signal: controller.signal,
    })
    await response.body?.cancel().catch(() => undefined)
    // S3's NoSuchBucket: the configured bucket does not exist, so the shared agent's export URL cannot be for it.
    if (404 === response.status) return { configured: true, reachable: false, reason: 'NO_SUCH_BUCKET' }
    return { configured: true, reachable: true }
  } catch (error) {
    const code = (error as { cause?: { code?: unknown } })?.cause?.code
    if (controller.signal.aborted || 'ETIMEDOUT' === code) {
      return { configured: true, reachable: false, reason: 'TIMEOUT' }
    }
    if ('string' === typeof code && TLS_CODES.has(code)) return { configured: true, reachable: false, reason: 'TLS' }
    if ('ENOTFOUND' === code || 'EAI_AGAIN' === code) return { configured: true, reachable: false, reason: 'DNS' }
    return { configured: true, reachable: false, reason: 'UNREACHABLE' }
  } finally {
    clearTimeout(timer)
  }
}
