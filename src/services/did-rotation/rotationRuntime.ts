import type { TsLogger } from '../../utils/logger'
import type { Agent } from '@credo-ts/core'

import { PendingRotationCommitter } from './PendingRotationCommitter'
import { RotationRunner } from './RotationRunner'
import { RotationService } from './RotationService'

export interface RotationRuntime {
  service: RotationService
  runner: RotationRunner
  stop: () => void
}

let runtime: RotationRuntime | undefined

/**
 * Starts what the migration rotation needs on a dedicated agent: the listener that finishes a rotation, and the job
 * runner, which carries on a job that was running when the agent last stopped.
 */
export const initRotationRuntime = async (agent: Agent, logger: TsLogger): Promise<RotationRuntime> => {
  if (runtime) return runtime

  const service = new RotationService(agent, logger)
  const runner = new RotationRunner(agent, service, logger)
  const detach = new PendingRotationCommitter(agent, logger).attach()

  runtime = {
    service,
    runner,
    stop: () => {
      runner.stop()
      detach()
    },
  }
  await runner.resume().catch((error) => logger.error(`[Rotation] could not resume the rotation job: ${error}`))
  return runtime
}

export const getRotationRuntime = (): RotationRuntime | undefined => runtime

export const shutdownRotationRuntime = (): void => {
  runtime?.stop()
  runtime = undefined
}
