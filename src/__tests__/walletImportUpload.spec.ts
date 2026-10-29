/**
 * The push upload route is a plain Express route (tsoa cannot stream a request body), so its authentication and
 * header handling are covered here at the HTTP level, with the service and authentication mocked.
 */
import { jest } from '@jest/globals'
import express from 'express'
import request from 'supertest'

const expressAuthentication = jest.fn<(req: unknown, name: string, scopes?: string[]) => Promise<boolean>>()
const importRootWalletFromUpload =
  jest.fn<(agent: unknown, body: NodeJS.ReadableStream, options: unknown) => Promise<unknown>>()

jest.unstable_mockModule('../authentication', () => ({ expressAuthentication }))
jest.unstable_mockModule('../services/wallet-portability/WalletPortabilityService', () => ({
  getWalletPortabilityService: () => ({ importRootWalletFromUpload }),
}))

const { mountWalletImportUpload } = await import('../walletImportUpload')
const { ConflictError, StatusException } = await import('../errors')
const { createErrorHandler } = await import('../errorHandler')

const CHECKSUM = 'A'.repeat(64)
const headers = {
  'content-type': 'application/octet-stream',
  'x-session-id': 'session-1',
  'x-checksum': CHECKSUM,
  'x-sealed-store-key': 'c2VhbGVk',
  'x-storage-version': '0.5',
}

const buildApp = () => {
  const app = express()
  mountWalletImportUpload(app)
  app.use(createErrorHandler({ warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() } as never))
  return app
}

describe('POST /agent/wallet/import/upload', () => {
  beforeEach(() => {
    expressAuthentication.mockReset().mockResolvedValue(true)
    importRootWalletFromUpload.mockReset()
  })

  it('authenticates as a dedicated agent and streams the raw body to the service with the parsed options', async () => {
    let received = ''
    importRootWalletFromUpload.mockImplementation(async (_agent, body) => {
      for await (const chunk of body) received += chunk.toString()
      return { jobId: 'job-1', status: 'pending' }
    })

    const response = await request(buildApp())
      .post('/agent/wallet/import/upload')
      .set({ ...headers, 'x-dry-run': 'true' })
      .send(Buffer.from('artifact-bytes'))

    expect(response.status).toBe(200)
    expect(response.body).toEqual({ jobId: 'job-1', status: 'pending' })
    expect(received).toBe('artifact-bytes')
    expect(expressAuthentication).toHaveBeenCalledWith(expect.anything(), 'jwt', ['dedicated'])
    expect(importRootWalletFromUpload.mock.calls[0][2]).toEqual({
      sessionId: 'session-1',
      checksum: CHECKSUM.toLowerCase(),
      sealedStoreKey: 'c2VhbGVk',
      storageVersion: '0.5',
      dryRun: true,
    })
  })

  it('rejects an unauthenticated caller before reading anything', async () => {
    expressAuthentication.mockRejectedValue(new StatusException('Unauthorized', 401))

    const response = await request(buildApp()).post('/agent/wallet/import/upload').set(headers).send(Buffer.from('x'))

    expect(response.status).toBe(401)
    expect(importRootWalletFromUpload).not.toHaveBeenCalled()
  })

  it.each([
    ['a wrong content type', { 'content-type': 'application/json' }],
    ['a missing session header', { 'x-session-id': '' }],
    ['a malformed checksum', { 'x-checksum': 'xyz' }],
    ['a non-base64 sealed key', { 'x-sealed-store-key': '***' }],
  ])('returns 400 for %s', async (_name, override) => {
    const response = await request(buildApp())
      .post('/agent/wallet/import/upload')
      .set({ ...headers, ...override })
      .send(Buffer.from('x'))

    expect(response.status).toBe(400)
    expect(importRootWalletFromUpload).not.toHaveBeenCalled()
  })

  it('maps service conflicts to their status', async () => {
    importRootWalletFromUpload.mockRejectedValue(new ConflictError('TARGET_NOT_PRISTINE'))

    const response = await request(buildApp()).post('/agent/wallet/import/upload').set(headers).send(Buffer.from('x'))

    expect(response.status).toBe(409)
  })
})
