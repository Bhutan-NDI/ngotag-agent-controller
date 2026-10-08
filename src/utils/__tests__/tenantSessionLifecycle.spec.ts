import 'reflect-metadata'
import type { AddressInfo } from 'node:net'

import { TenantAgent } from '@credo-ts/tenants'
import { jest } from '@jest/globals'
import express from 'express'
import { EventEmitter, once } from 'node:events'
import { request as httpRequest } from 'node:http'

import { tenantSessionLifecycle } from '../tenantSessionLifecycle'

function fixture(fail = false) {
  const endSession = jest.fn<() => Promise<void>>().mockImplementation(async () => {
    if (fail) throw new Error('sensitive upstream content')
  })
  const error = jest.fn()
  const agent = Object.assign(Object.create(TenantAgent.prototype), { endSession })
  Object.defineProperty(agent, 'config', { value: { logger: { error } } })
  const response = Object.assign(new EventEmitter(), {
    end() {
      return this
    },
  })
  tenantSessionLifecycle({ agent } as never, response as never, jest.fn())
  return { endSession, error, response, agent }
}

describe('HTTP tenant session cleanup', () => {
  it('releases only once on end and finish', () => {
    const f = fixture()
    f.response.end()
    f.response.emit('finish')
    f.response.end()
    expect(f.endSession).toHaveBeenCalledTimes(1)
  })
  it('does not release on disconnect while work is running, but releases when work ends', async () => {
    const f = fixture()
    f.response.emit('close')
    await Promise.resolve()
    expect(f.endSession).not.toHaveBeenCalled()
    // TSOA sends the result after awaiting the controller, even if the socket already closed.
    f.response.end()
    expect(f.endSession).toHaveBeenCalledTimes(1)
  })
  it('handles release failure without unhandled rejections or sensitive logs', async () => {
    const f = fixture(true)
    f.response.end()
    await Promise.resolve()
    expect(f.error).toHaveBeenCalledWith('Failed to release HTTP tenant session')
  })
})

it('releases a real disconnected HTTP request only after its controller work completes', async () => {
  const f = fixture()
  const app = express()
  let completeWork!: () => void
  let entered!: () => void
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  const work = new Promise<void>((resolve) => {
    completeWork = resolve
  })
  const released = new Promise<void>((resolve) => {
    f.endSession.mockImplementation(async () => resolve())
  })
  app.use((request, _response, next) => {
    request.agent = f.agent
    next()
  })
  app.use(tenantSessionLifecycle)
  let responseClosed!: Promise<unknown>
  app.get('/', async (_request, response) => {
    responseClosed = once(response, 'close')
    entered()
    await work
    response.json({ complete: true })
  })
  const server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const client = httpRequest({ host: '127.0.0.1', port: (server.address() as AddressInfo).port })
  client.on('error', () => {})
  try {
    client.end()
    await started
    client.destroy()
    await responseClosed
    expect(f.endSession).not.toHaveBeenCalled()
    completeWork()
    await released
    expect(f.endSession).toHaveBeenCalledTimes(1)
  } finally {
    completeWork()
    client.destroy()
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
