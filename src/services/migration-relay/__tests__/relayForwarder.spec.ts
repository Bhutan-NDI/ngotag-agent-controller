import { jest } from '@jest/globals'

import { createForwarder } from '../relayForwarder'

import { freePort, startTarget } from './targetServer'

const MIME = 'application/didcomm-envelope-enc'

describe('forwardEnvelope', () => {
  const forward = createForwarder(300)

  it('sends the envelope byte for byte and returns the answer, whatever its status', async () => {
    const body = '{"protected":"abc","ciphertext":"é✓"}'
    const target = await startTarget((_request, res) => {
      res.writeHead(202, { 'content-type': MIME }).end('{"reply":true}')
    })

    const result = await forward(target.url, { contentType: MIME, body })

    expect(result).toMatchObject({ kind: 'response', status: 202, contentType: MIME })
    expect((result as { body: Buffer }).body.toString()).toBe('{"reply":true}')
    expect(target.received).toEqual([{ method: 'POST', contentType: MIME, body }])
    await target.close()
  })

  it.each([404, 500, 503])('treats a %i from the target as an answer, not a failure', async (status) => {
    const target = await startTarget((_request, res) => res.writeHead(status).end())

    await expect(forward(target.url, { contentType: MIME, body: '{}' })).resolves.toMatchObject({
      kind: 'response',
      status,
    })
    await target.close()
  })

  it('reports a refused connection as never having left', async () => {
    const port = await freePort()

    await expect(forward(`http://127.0.0.1:${port}/`, { contentType: MIME, body: '{}' })).resolves.toEqual({
      kind: 'neverLeft',
      code: 'ECONNREFUSED',
    })
  })

  it('reports an unresolvable host as never having left', async () => {
    await expect(forward('http://relay-target.invalid/', { contentType: MIME, body: '{}' })).resolves.toMatchObject({
      kind: 'neverLeft',
    })
  })

  it.each([
    'CERT_HAS_EXPIRED',
    'ERR_TLS_CERT_ALTNAME_INVALID',
    'EHOSTUNREACH',
    'ENETUNREACH',
    'UND_ERR_CONNECT_TIMEOUT',
  ])('reports %s, which happens before anything is sent, as never having left', async (code) => {
    const fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(Object.assign(new TypeError('fetch failed'), { cause: { code } }))

    await expect(forward('https://agent.example.org/', { contentType: MIME, body: '{}' })).resolves.toEqual({
      kind: 'neverLeft',
      code,
    })
    fetchSpy.mockRestore()
  })

  it('treats a timeout as possibly delivered', async () => {
    const target = await startTarget(() => undefined)

    await expect(forward(target.url, { contentType: MIME, body: '{}' })).resolves.toEqual({
      kind: 'ambiguous',
      reason: 'TIMEOUT',
    })
    expect(target.received).toHaveLength(1)
    await target.close()
  })

  it('treats a dropped connection as possibly delivered', async () => {
    const target = await startTarget((_request, res) => res.destroy())

    await expect(forward(target.url, { contentType: MIME, body: '{}' })).resolves.toMatchObject({ kind: 'ambiguous' })
    await target.close()
  })

  it('does not follow a redirect', async () => {
    const target = await startTarget((_request, res) => res.writeHead(302, { location: 'http://127.0.0.1:1/' }).end())

    await expect(forward(target.url, { contentType: MIME, body: '{}' })).resolves.toMatchObject({ kind: 'ambiguous' })
    await target.close()
  })
})
