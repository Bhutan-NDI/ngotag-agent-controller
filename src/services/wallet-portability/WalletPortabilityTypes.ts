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
