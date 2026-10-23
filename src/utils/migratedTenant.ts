export const MIGRATED_TENANT_TAG = 'migrated'

export const isTenantMigrated = (tenant: { getTag?: (name: string) => unknown }): boolean =>
  tenant.getTag?.(MIGRATED_TENANT_TAG) === true
