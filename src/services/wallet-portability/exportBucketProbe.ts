const PROBE_TIMEOUT_MS = 5000
const BUCKET_NAME = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/

const TLS_CODES = new Set([
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'ERR_TLS_CERT_ALTNAME_INVALID',
])

export type ExportBucketProbeReason = 'DNS' | 'TLS' | 'TIMEOUT' | 'UNREACHABLE'

export interface ExportBucketProbe {
  /** Whether a usable export bucket name is set. Without one this agent cannot pull an export from S3 at all */
  configured: boolean
  /** Whether this agent can reach the bucket over HTTPS; absent when no bucket is configured */
  reachable?: boolean
  reason?: ExportBucketProbeReason
}

/**
 * Whether this agent could pull an export from its S3 bucket. Any HTTP answer, even a refusal, means the network path
 * works; only a failure to connect does not. Nothing is read from the bucket and no credentials are involved.
 */
export const probeExportBucket = async (
  bucket: string | undefined = process.env.AWS_WALLET_EXPORT_BUCKET,
  fetchFn: typeof fetch = fetch,
  timeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<ExportBucketProbe> => {
  if (!bucket || !BUCKET_NAME.test(bucket)) return { configured: false }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    // S3's certificate covers one label, so a dotted bucket is served path-style (as the SDK does for the real pull).
    const url = bucket.includes('.') ? `https://s3.amazonaws.com/${bucket}/` : `https://${bucket}.s3.amazonaws.com/`
    const response = await fetchFn(url, {
      method: 'HEAD',
      redirect: 'manual',
      signal: controller.signal,
    })
    await response.arrayBuffer().catch(() => undefined)
    return { configured: true, reachable: true }
  } catch (error) {
    const code = (error as { cause?: { code?: unknown } })?.cause?.code
    if (controller.signal.aborted) return { configured: true, reachable: false, reason: 'TIMEOUT' }
    if ('string' === typeof code && TLS_CODES.has(code)) return { configured: true, reachable: false, reason: 'TLS' }
    if ('ENOTFOUND' === code || 'EAI_AGAIN' === code) return { configured: true, reachable: false, reason: 'DNS' }
    return { configured: true, reachable: false, reason: 'UNREACHABLE' }
  } finally {
    clearTimeout(timer)
  }
}
