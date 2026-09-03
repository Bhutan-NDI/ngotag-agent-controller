// setupServer's apiKey parameter is optional, so dropping the argument would still compile.
import { jest } from '@jest/globals'

const listen = jest.fn(() => ({ on: jest.fn() }))
// Typed parameters so the call assertions below index a known tuple.
const setupServer = jest.fn(async (_agent: unknown, _config: Record<string, unknown>, _apiKey?: string) => ({
  listen,
}))

jest.unstable_mockModule('../server', () => ({ setupServer }))

const { startServer } = await import('../index')

const API_KEY = 'x'.repeat(16)

describe('startServer', () => {
  beforeEach(() => {
    setupServer.mockClear()
  })

  const start = async (): Promise<void> => {
    await startServer(
      {} as never,
      {
        port: 3000,
        apiKey: API_KEY,
        webhookUrl: 'http://localhost:5000/agent-events',
      } as never,
    )
  }

  it('forwards apiKey as the third argument to setupServer', async () => {
    await start()

    expect(setupServer).toHaveBeenCalledTimes(1)
    expect(setupServer.mock.calls[0][2]).toBe(API_KEY)
  })

  it('does not leave apiKey in the config setupServer serialises', async () => {
    await start()

    const forwardedConfig = setupServer.mock.calls[0][1]
    expect(forwardedConfig).not.toHaveProperty('apiKey')
    expect(JSON.stringify(forwardedConfig)).not.toContain(API_KEY)
  })

  it('still forwards the rest of the config', async () => {
    await start()

    const forwardedConfig = setupServer.mock.calls[0][1]
    expect(forwardedConfig).toMatchObject({ port: 3000, webhookUrl: 'http://localhost:5000/agent-events' })
    expect(forwardedConfig.socketServer).toBeDefined()
  })
})
