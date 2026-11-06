import type { DependencyManager, Module } from '@credo-ts/core'

import { AskarStorageService } from '@credo-ts/askar'
import { CredoError, InjectionSymbols } from '@credo-ts/core'

import { PlanStableAskarStorageService } from './PlanStableAskarStorageService'

/**
 * Registers the agent's StorageService in place of AskarModule, which must be configured with
 * `enableStorage: false`. With planning off it registers the stock AskarStorageService, so the
 * switch restores Credo's own behaviour exactly.
 */
export class PlanStableAskarStorageModule implements Module {
  public constructor(public readonly planning: boolean) {}

  public register(dependencyManager: DependencyManager) {
    if (dependencyManager.isRegistered(InjectionSymbols.StorageService)) {
      throw new CredoError(
        'A StorageService is already registered. Configure AskarModule with enableStorage: false so that ' +
          'PlanStableAskarStorageModule registers the wallet storage.',
      )
    }
    dependencyManager.registerSingleton(
      InjectionSymbols.StorageService,
      this.planning ? PlanStableAskarStorageService : AskarStorageService,
    )
  }
}

/**
 * WALLET_QUERY_PLANNING: `on` (default) plans wallet tag queries, `off` runs every query as Credo
 * writes it. Any other value fails startup rather than silently choosing one.
 */
export function walletQueryPlanning(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.WALLET_QUERY_PLANNING
  if (raw === undefined || raw === '' || raw === 'on') return true
  if (raw === 'off') return false
  throw new Error('WALLET_QUERY_PLANNING must be "on" or "off"')
}
