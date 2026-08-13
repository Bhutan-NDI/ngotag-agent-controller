export enum WalletPortabilityJobStatus {
  Pending = 'pending',
  InProgress = 'in-progress',
  Completed = 'completed',
  Failed = 'failed',
}

export enum WalletPortabilityJobType {
  Export = 'export',
  Import = 'import',
}

export interface WalletPortabilityJobRecord {
  jobId: string
  tenantId: string
  type: WalletPortabilityJobType
  status: WalletPortabilityJobStatus
  createdAt: string
  updatedAt: string
  // Populated on Completed (export only): the S3 object key of the uploaded artifact, and its
  // SHA-256 checksum (computed over the *uploaded* .gz bytes, not the plaintext — see
  // gzipAndChecksum). s3Key is the persisted, stable reference; downloadUrl (below) is NOT
  // persisted from this field — it's minted fresh, short-lived, on every read of the job record
  // (see WalletPortabilityService#getJobStatus), so a job polled hours after completion still
  // gets a live URL instead of one that expired long before the 24h job TTL did.
  s3Key?: string
  checksum?: string
  // Computed on read, never persisted — see s3Key above.
  downloadUrl?: string
  // Populated on Completed (import only): the timestamped profile the tenant's pre-import data
  // was renamed to, in case it ever needs to be inspected/restored. Never deleted automatically.
  backupProfile?: string
  // Populated on Failed — a stable, sanitized code (e.g. EXPORT_FAILED, IMPORT_FAILED), never the
  // raw Askar/filesystem/AWS error text. The real error is logged server-side with the job id at
  // the point of failure; this field is externally readable via getJobStatus, so it must never
  // carry operational details (paths, bucket names, stack traces). See the #72 review.
  error?: string
}

export interface ExportWalletResult {
  jobId: string
  status: WalletPortabilityJobStatus
}

export interface ImportWalletResult {
  jobId: string
  status: WalletPortabilityJobStatus
}

/**
 * Thrown when a caller tries to start an export or import for a tenant that already has one
 * in flight (status Pending/InProgress). Export and import both rename the tenant's Askar
 * profile away for the duration of the copy, so two portability jobs racing on the same tenant
 * — either the same kind or a mix — can wedge the tenant with no working profile, or silently
 * drop one job's result. The controller layer maps this to HTTP 409.
 */
export class WalletPortabilityJobConflictError extends Error {
  public readonly tenantId: string
  public readonly activeJobId: string

  public constructor(tenantId: string, activeJobId: string) {
    super(`A wallet portability job (${activeJobId}) is already in progress for tenant '${tenantId}'`)
    this.name = 'WalletPortabilityJobConflictError'
    this.tenantId = tenantId
    this.activeJobId = activeJobId
  }
}
