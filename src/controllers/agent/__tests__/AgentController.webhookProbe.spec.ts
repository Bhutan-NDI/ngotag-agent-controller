import { jest } from '@jest/globals'

import { BadRequestError } from '../../../errors'

const probeWebhook = jest.fn<(probeId: string) => Promise<unknown>>()

jest.unstable_mockModule('../../../utils/webhookProbe', () => ({
  probeWebhook,
  isProbeId: (value: unknown) => 'string' === typeof value && /^[0-9a-f-]{36}$/.test(value),
}))

const { AgentController } = await import('../AgentController')

const PROBE_ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6'

describe('AgentController.probeWebhook', () => {
  beforeEach(() => {
    probeWebhook.mockReset().mockResolvedValue({ configured: true, delivered: true, status: 200 })
  })

  it('sends the probe and returns what the agent saw', async () => {
    const result = await new AgentController().probeWebhook({ probeId: PROBE_ID })

    expect(probeWebhook).toHaveBeenCalledWith(PROBE_ID)
    expect(result).toEqual({ configured: true, delivered: true, status: 200 })
  })

  it.each([undefined, { probeId: 'nope' }, { probeId: 5 }])('refuses %j and sends nothing', async (body) => {
    const error = await new AgentController().probeWebhook(body as never).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(BadRequestError)
    expect(probeWebhook).not.toHaveBeenCalled()
  })
})
