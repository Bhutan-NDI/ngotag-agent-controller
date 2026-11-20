import { jest } from '@jest/globals'

import { BadRequestError, ConflictError, NotFoundError } from '../../../errors/errors'
import { RelayConflictError, RelayNotFoundError } from '../RelayService'
import { InvalidRelayTargetError } from '../relayTarget'

const service = {
  health: jest.fn<() => Promise<unknown>>(),
  put: jest.fn<(...args: unknown[]) => Promise<unknown>>(),
  get: jest.fn<(...args: unknown[]) => Promise<unknown>>(),
  remove: jest.fn<(...args: unknown[]) => Promise<unknown>>(),
  reinject: jest.fn<(...args: unknown[]) => Promise<unknown>>(),
  restore: jest.fn<(...args: unknown[]) => Promise<unknown>>(),
  probe: jest.fn<(...args: unknown[]) => Promise<unknown>>(),
}
let runtime: { service: typeof service } | undefined = { service }

jest.unstable_mockModule('../relayRuntime', () => ({ getRelayRuntime: () => runtime }))
process.env.MIGRATION_RELAY_ENABLED = 'true'
process.env.REDIS_URL = 'redis://relay-test'

const { RelayController } = await import('../../../controllers/multi-tenancy/RelayController')

const agent = { name: 'root-agent' }
const req = { agent } as never

describe('RelayController', () => {
  const controller = new RelayController()

  beforeEach(() => {
    runtime = { service }
    Object.values(service).forEach((fn) => fn.mockReset())
  })

  it('hands the root agent and the request to the service', async () => {
    service.put.mockResolvedValue({ mode: 'HOLD' })

    await expect(controller.putRelay(req, 'tenant-1', { mode: 'HOLD' })).resolves.toEqual({ mode: 'HOLD' })
    expect(service.put).toHaveBeenCalledWith(agent, 'tenant-1', { mode: 'HOLD' })

    service.get.mockResolvedValue({ mode: 'HOLD' })
    await controller.getRelay(req, 'tenant-1')
    expect(service.get).toHaveBeenCalledWith(agent, 'tenant-1')

    service.reinject.mockResolvedValue({ injected: 1, failed: 0 })
    await expect(controller.reinject(req, 'tenant-1')).resolves.toEqual({ injected: 1, failed: 0 })

    service.probe.mockResolvedValue({ reachable: true })
    await expect(controller.probe('tenant-1', { target: 'https://a.example.org' })).resolves.toEqual({
      reachable: true,
    })
    expect(service.probe).toHaveBeenCalledWith('https://a.example.org')
  })

  it('hands a restore to the service with the root agent', async () => {
    service.restore.mockResolvedValue({ injected: 2, failed: 0 })

    await expect(controller.restore(req, 'tenant-1')).resolves.toEqual({ injected: 2, failed: 0 })

    expect(service.restore).toHaveBeenCalledWith(agent, 'tenant-1')
  })

  it.each([
    ['a purged tenant', new RelayConflictError('TENANT_PURGED'), ConflictError, 409, 'TENANT_PURGED'],
    [
      'messages still held',
      new RelayConflictError('RELAY_BUFFER_NOT_EMPTY'),
      ConflictError,
      409,
      'RELAY_BUFFER_NOT_EMPTY',
    ],
    ['no relay', new RelayNotFoundError('tenant-1'), NotFoundError, 404, "No relay entry for tenant 'tenant-1'."],
  ])('maps %s on a restore to its HTTP status', async (_name, thrown, errorClass, statusCode, message) => {
    service.restore.mockRejectedValue(thrown)

    const error = await controller.restore(req, 'tenant-1').catch((e) => e)

    expect(error).toBeInstanceOf(errorClass)
    expect(error.statusCode).toBe(statusCode)
    expect(error.message).toBe(message)
  })

  it('answers delete with 204', async () => {
    service.remove.mockResolvedValue(undefined)

    await controller.deleteRelay(req, 'tenant-1')

    expect(service.remove).toHaveBeenCalledWith(agent, 'tenant-1')
    expect(controller.getStatus()).toBe(204)
  })

  it.each([
    ['a conflict', new RelayConflictError('RELAY_NOT_REMOVABLE'), ConflictError, 409],
    ['a missing relay', new RelayNotFoundError('tenant-1'), NotFoundError, 404],
    ['an invalid target', new InvalidRelayTargetError('must use https'), BadRequestError, 400],
  ])('maps %s to its HTTP status', async (_name, thrown, errorClass, statusCode) => {
    service.put.mockRejectedValue(thrown)

    const error = await controller.putRelay(req, 'tenant-1', { mode: 'HOLD' }).catch((e) => e)

    expect(error).toBeInstanceOf(errorClass)
    expect(error.statusCode).toBe(statusCode)
  })

  it('keeps the relay conflict code as the message so the platform can act on it', async () => {
    service.remove.mockRejectedValue(new RelayConflictError('RELAY_BUFFER_NOT_EMPTY'))

    const error = await controller.deleteRelay(req, 'tenant-1').catch((e) => e)

    expect(error.message).toBe('RELAY_BUFFER_NOT_EMPTY')
  })

  describe('when the relay is not enabled', () => {
    it('reports that on the health route, with 200', async () => {
      runtime = undefined

      await expect(controller.getHealth()).resolves.toEqual({ enabled: false, redisReady: false })
    })

    it.each([
      ['put', () => controller.putRelay(req, 't', { mode: 'HOLD' })],
      ['get', () => controller.getRelay(req, 't')],
      ['delete', () => controller.deleteRelay(req, 't')],
      ['probe', () => controller.probe('t', { target: 'https://a.example.org' })],
      ['reinject', () => controller.reinject(req, 't')],
      ['restore', () => controller.restore(req, 't')],
    ])('refuses %s with 409 RELAY_DISABLED', async (_name, call) => {
      runtime = undefined

      const error = await call().catch((e) => e)

      expect(error).toBeInstanceOf(ConflictError)
      expect(error.message).toBe('RELAY_DISABLED')
    })
  })

  it('reports the service health when enabled', async () => {
    service.health.mockResolvedValue({ enabled: true, redisReady: true })

    await expect(controller.getHealth()).resolves.toEqual({ enabled: true, redisReady: true })
  })
})
