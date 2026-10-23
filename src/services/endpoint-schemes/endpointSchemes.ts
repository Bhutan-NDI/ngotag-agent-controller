import type { Agent } from '@credo-ts/core'

type TenantScopedAgent = Pick<Agent, 'dependencyManager' | 'context' | 'dids'>

import { DidDocumentRole, DidRepository } from '@credo-ts/core'

const PAGE_SIZE = 200
const MAX_EXAMPLE_DIDS = 3

export interface EndpointSchemeSummary {
  tenantId: string
  didsScanned: number
  unresolvedDids: number
  schemes: Array<{ scheme: string; count: number; exampleDids: string[] }>
}

export const schemeOf = (endpoint: string): string =>
  /^([a-z][a-z0-9+.-]*):/i.exec(endpoint)?.[1].toLowerCase() ?? 'unknown'

const endpointsOf = (serviceEndpoint: unknown): string[] => {
  if (typeof serviceEndpoint === 'string') return [serviceEndpoint]
  if (Array.isArray(serviceEndpoint)) return serviceEndpoint.flatMap(endpointsOf)
  const uri = (serviceEndpoint as { uri?: unknown } | undefined)?.uri
  return typeof uri === 'string' ? [uri] : []
}

/** Counts, per URL scheme, how many of the tenant's own DIDs advertise a service endpoint with that scheme. */
export const collectEndpointSchemes = async (
  agent: TenantScopedAgent,
  tenantId: string,
  pageSize = PAGE_SIZE,
): Promise<EndpointSchemeSummary> => {
  const repository = agent.dependencyManager.resolve(DidRepository)
  const found = new Map<string, { count: number; exampleDids: string[] }>()
  let didsScanned = 0
  let unresolvedDids = 0

  for (let offset = 0; ; offset += pageSize) {
    const page = { limit: pageSize, offset, orderBy: 'id' as const }
    const records = await repository.findByQuery(agent.context, { role: DidDocumentRole.Created }, page)

    for (const record of records) {
      didsScanned++
      const document =
        record.didDocument ??
        (await agent.dids.resolveDidDocument(record.did).catch(() => {
          unresolvedDids++
          return undefined
        }))

      const schemes = new Set(
        (document?.service ?? []).flatMap((service) => endpointsOf(service.serviceEndpoint)).map(schemeOf),
      )
      for (const scheme of schemes) {
        const entry = found.get(scheme) ?? { count: 0, exampleDids: [] }
        entry.count++
        if (entry.exampleDids.length < MAX_EXAMPLE_DIDS) entry.exampleDids.push(record.did)
        found.set(scheme, entry)
      }
    }

    if (records.length < pageSize) break
  }

  return {
    tenantId,
    didsScanned,
    unresolvedDids,
    schemes: [...found]
      .map(([scheme, entry]) => ({ scheme, ...entry }))
      .sort((a, b) => a.scheme.localeCompare(b.scheme)),
  }
}
