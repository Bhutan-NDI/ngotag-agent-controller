import { jest } from '@jest/globals'

import { withNetworkErrorCodes } from '../networkErrorCodes'

const failing = (error: unknown): typeof fetch => (async () => Promise.reject(error)) as typeof fetch

describe('withNetworkErrorCodes', () => {
  it('passes a successful response through untouched', async () => {
    const response = new Response('ok')
    const fetchMock = jest.fn(async () => response)

    await expect(withNetworkErrorCodes(fetchMock as unknown as typeof fetch)('https://a.example.org')).resolves.toBe(
      response,
    )
    expect(fetchMock).toHaveBeenCalledWith('https://a.example.org')
  })

  it('adds the cause code to the message and rethrows the very same error', async () => {
    const error = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } })

    const thrown = await withNetworkErrorCodes(failing(error))('https://a.example.org').catch((e) => e)

    expect(thrown).toBe(error)
    expect(thrown.message).toBe('fetch failed (ECONNREFUSED)')
    expect(thrown.cause).toEqual({ code: 'ECONNREFUSED' })
  })

  it('does not add the code twice', async () => {
    const error = Object.assign(new TypeError('fetch failed (ECONNREFUSED)'), { cause: { code: 'ECONNREFUSED' } })

    const thrown = await withNetworkErrorCodes(failing(error))('https://a.example.org').catch((e) => e)

    expect(thrown.message).toBe('fetch failed (ECONNREFUSED)')
  })

  it.each([
    ['an error with no cause', new TypeError('fetch failed')],
    ['an error whose cause has no code', Object.assign(new TypeError('fetch failed'), { cause: new Error('x') })],
    ['an abort', Object.assign(new Error('aborted'), { name: 'AbortError' })],
  ])('leaves %s as it was', async (_name, error) => {
    const before = (error as Error).message

    const thrown = await withNetworkErrorCodes(failing(error))('https://a.example.org').catch((e) => e)

    expect(thrown).toBe(error)
    expect(thrown.message).toBe(before)
  })

  it.each([
    ['a string', 'boom'],
    ['undefined', undefined],
    ['null', null],
  ])('rethrows %s unchanged', async (_name, value) => {
    await expect(withNetworkErrorCodes(failing(value))('https://a.example.org')).rejects.toBe(value)
  })
})
