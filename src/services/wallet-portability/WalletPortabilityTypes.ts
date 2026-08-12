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
  // Populated on Completed (export only): a short-lived pre-signed download URL and the artifact checksum
  downloadUrl?: string
  checksum?: string
  // Populated on Failed
  error?: string
}

export interface ExportWalletResult {
  jobId: string
  status: WalletPortabilityJobStatus
}
