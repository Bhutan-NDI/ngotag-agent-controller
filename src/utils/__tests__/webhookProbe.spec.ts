import { jest } from '@jest/globals'
import { createServer } from 'http'
import { Response as FetchResponse } from 'node-fetch'

import { isProbeId, probeWebhook, setWebhookUrl } from '../webhookProbe'

const PROBE_ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6'

const listen = async (handler?: Parameters<typeof createServer>[1]) => {
  const requests: Array<{ url?: string; method?: string; body: string }> = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => {
      requests.push({ url: req.url, method: req.method, body })
      handler?.(req, res)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as { port: number }
  return {
    url: `http://127.0.0.1:${port}/wh/org-1`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

describe('probeWebhook', () => {
  afterEach(() => setWebhookUrl(undefined))

  it('says so when the agent has no webhook URL', async () => {
    setWebhookUrl(undefined)

    await expect(probeWebhook(PROBE_ID)).resolves.toEqual({ configured: false, delivered: false })
  })

  it('posts the probe id to <webhookUrl>/probe, as the real events are posted, and reports the status', async () => {
    const target = await listen((_req, res) => res.writeHead(200).end())
    setWebhookUrl(target.url)

    const result = await probeWebhook(PROBE_ID)
    await target.close()

    expect(result).toEqual({ configured: true, delivered: true, status: 200 })
    expect(target.requests).toHaveLength(1)
    expect(target.requests[0]).toMatchObject({ url: '/wh/org-1/probe', method: 'POST' })
    expect(JSON.parse(target.requests[0].body)).toEqual({ type: 'WebhookProbe', probeId: PROBE_ID })
  })

  it('reports a rejection as delivered with its status', async () => {
    const target = await listen((_req, res) => res.writeHead(404).end())
    setWebhookUrl(target.url)

    const result = await probeWebhook(PROBE_ID)
    await target.close()

    expect(result).toEqual({ configured: true, delivered: true, status: 404 })
  })

  it('reads the answer body, so the connection can be reused', async () => {
    const target = await listen((_req, res) => res.writeHead(200).end('ok'))
    setWebhookUrl(target.url)
    const consumed = jest.spyOn(FetchResponse.prototype, 'arrayBuffer')

    await probeWebhook(PROBE_ID)
    await target.close()

    expect(consumed).toHaveBeenCalled()
    consumed.mockRestore()
  })

  it('does not follow a redirect to somewhere else', async () => {
    const elsewhere = await listen((_req, res) => res.writeHead(200).end())
    const target = await listen((_req, res) => res.writeHead(302, { location: elsewhere.url }).end())
    setWebhookUrl(target.url)

    const result = await probeWebhook(PROBE_ID)
    await target.close()
    await elsewhere.close()

    expect(result).toEqual({ configured: true, delivered: true, status: 302 })
    expect(elsewhere.requests).toHaveLength(0)
  })

  it('reports not delivered when nothing is listening', async () => {
    const target = await listen()
    setWebhookUrl(target.url)
    await target.close()

    await expect(probeWebhook(PROBE_ID)).resolves.toEqual({ configured: true, delivered: false })
  })

  it('reports not delivered when the receiver is too slow', async () => {
    const target = await listen(() => undefined)
    setWebhookUrl(target.url)

    const result = await probeWebhook(PROBE_ID, 50)
    await target.close()

    expect(result).toEqual({ configured: true, delivered: false })
  })
})

describe('isProbeId', () => {
  it.each([PROBE_ID, PROBE_ID.toUpperCase()])('accepts the UUID %s', (value) => {
    expect(isProbeId(value)).toBe(true)
  })

  it.each([undefined, null, 5, '', 'not-a-uuid', `${PROBE_ID}x`, '../../etc'])('rejects %j', (value) => {
    expect(isProbeId(value)).toBe(false)
  })
})
