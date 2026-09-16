import type { Controller } from 'tsoa'

import { BadRequestError } from '../errors'

/** No options means the legacy complete-list contract. Pages are live, not snapshots. */
export function recordPageOptions(limit?: number, offset?: number) {
  if (limit === undefined && offset === undefined) return undefined
  if (limit === undefined || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
    throw new BadRequestError('limit must be an integer between 1 and 1000')
  }
  const start = offset ?? 0
  if (!Number.isSafeInteger(start) || start < 0 || start > Number.MAX_SAFE_INTEGER - limit - 1) {
    throw new BadRequestError('offset must be a non-negative safe integer within the pagination range')
  }
  return { limit: limit + 1, offset: start, orderBy: 'id' as const }
}

export function recordPage<T>(
  controller: Controller,
  records: T[],
  options: NonNullable<ReturnType<typeof recordPageOptions>>,
) {
  const limit = options.limit - 1
  const hasMore = records.length > limit
  controller.setHeader('X-Has-More', String(hasMore))
  controller.setHeader('X-Page-Limit', String(limit))
  controller.setHeader('X-Page-Offset', String(options.offset))
  if (hasMore) controller.setHeader('X-Next-Offset', String(options.offset + limit))
  return records.slice(0, limit)
}

export async function fetchRecordPage<T>(
  controller: Controller,
  options: ReturnType<typeof recordPageOptions>,
  fetchPage: (options: NonNullable<ReturnType<typeof recordPageOptions>>) => Promise<T[]>,
  fetchAll: () => Promise<T[]>,
): Promise<T[]> {
  if (!options) return fetchAll()
  return recordPage(controller, await fetchPage(options), options)
}
