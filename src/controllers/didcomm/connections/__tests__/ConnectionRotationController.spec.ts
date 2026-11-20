import { jest } from '@jest/globals'

import { ConflictError } from '../../../../errors/errors'

const runner = { start: jest.fn<(...args: unknown[]) => Promise<unknown>>(), status: jest.fn<() => Promise<unknown>>() }
const service = { rotateConnection: jest.fn<(...args: unknown[]) => Promise<unknown>>() }
let runtime: { runner: typeof runner; service: typeof service } | undefined = { runner, service }

jest.unstable_mockModule('../../../../services/did-rotation/rotationRuntime', () => ({
  getRotationRuntime: () => runtime,
}))

const { ConnectionRotationController } = await import('../ConnectionRotationController')

describe('ConnectionRotationController', () => {
  const controller = new ConnectionRotationController()

  beforeEach(() => {
    runtime = { runner, service }
    runner.start.mockReset().mockResolvedValue({ job: { status: 'running' } })
    runner.status.mockReset().mockResolvedValue({ counts: {} })
    service.rotateConnection.mockReset().mockResolvedValue({ outcome: 'sent' })
  })

  it('starts the job with the requested batch size and an interval converted to milliseconds', async () => {
    await controller.rotateAll({ batchSize: 20, intervalSeconds: 30 })

    expect(runner.start).toHaveBeenCalledWith({ batchSize: 20, intervalMs: 30_000 })
  })

  it('leaves the defaults to the runner when nothing is given', async () => {
    await controller.rotateAll({})

    expect(runner.start).toHaveBeenCalledWith({ batchSize: undefined, intervalMs: undefined })
  })

  it('reports the status', async () => {
    await expect(controller.getRotationStatus()).resolves.toEqual({ counts: {} })
  })

  it('rotates one connection and lets an explicit request retry one that gave up', async () => {
    await expect(controller.rotateConnection('c1')).resolves.toEqual({ outcome: 'sent' })

    expect(service.rotateConnection).toHaveBeenCalledWith('c1', { force: true })
  })

  it.each([
    ['rotate-all', () => controller.rotateAll({})],
    ['status', () => controller.getRotationStatus()],
    ['rotate one', () => controller.rotateConnection('c1')],
  ])('answers 409 ROTATION_UNAVAILABLE for %s when the agent has no rotation runtime', async (_name, call) => {
    runtime = undefined

    const error = await call().catch((e) => e)

    expect(error).toBeInstanceOf(ConflictError)
    expect(error.message).toBe('ROTATION_UNAVAILABLE')
  })
})
