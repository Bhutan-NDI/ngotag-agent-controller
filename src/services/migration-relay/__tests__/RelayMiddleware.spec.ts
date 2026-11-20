import { DidCommHttpInboundTransport } from '@credo-ts/node'
import express from 'express'
import request from 'supertest'

import { RelayDrainer } from '../RelayDrainer'
import { createRelayMiddleware } from '../RelayMiddleware'
import { RelayMirror } from '../RelayMirror'
import { RelayStore } from '../RelayStore'
import { HOLD_BUFFER_CAP } from '../relayConfig'
import { createForwarder } from '../relayForwarder'

import { freePort, startTarget } from './targetServer'
import { DIDCOMM_MIME, FakeRedis, buildEnvelope, eventually, newRecipient, silentLogger } from './testSupport'

const TENANT = 'tenant-1'

describe('relay middleware', () => {
  let redis: FakeRedis
  let store: RelayStore
  let drainer: RelayDrainer
  let handled: string[]
  let app: express.Express
  const recipient = newRecipient()
  const other = newRecipient()
  const cleanups: (() => Promise<void> | void)[] = []

  const buildApp = (target: express.Express = express(), mirror?: RelayMirror): express.Express => {
    // The same order cliAgent has: the transport's text parser first, then the relay, then Credo's POST handler.
    target.use(express.text({ type: [DIDCOMM_MIME], limit: '5mb' }))
    target.use(createRelayMiddleware({ store, forward: createForwarder(300), drainer, logger: silentLogger(), mirror }))
    target.post('/', (req, res) => {
      handled.push(req.body)
      res.status(200).end()
    })
    return target
  }

  const send = (envelope: string, contentType = DIDCOMM_MIME) =>
    request(app).post('/').set('content-type', contentType).send(envelope)

  const setRelay = async (mode: 'HOLD' | 'FORWARD', target?: string) => {
    await store.indexKeys(TENANT, [recipient.fingerprint])
    await store.setEntry({ tenantId: TENANT, mode, target, updatedAt: 'now' })
  }

  beforeEach(() => {
    redis = new FakeRedis()
    store = new RelayStore(redis)
    drainer = new RelayDrainer(store, createForwarder(300), silentLogger(), { backoffBaseMs: 10, backoffMaxMs: 40 })
    handled = []
    app = buildApp()
  })

  afterEach(async () => {
    drainer.stop()
    for (const cleanup of cleanups.splice(0)) await cleanup()
  })

  describe('passes straight through to Credo', () => {
    it('for a message addressed to a tenant with no relay', async () => {
      await setRelay('HOLD')
      const envelope = buildEnvelope([other.kid])

      expect((await send(envelope)).status).toBe(200)
      expect(handled).toEqual([envelope])
    })

    it('for a body that is not a DIDComm envelope', async () => {
      await setRelay('HOLD')

      expect((await send('plain text')).status).toBe(200)
      expect(handled).toEqual(['plain text'])
    })

    it('for a content type the transport does not parse', async () => {
      await setRelay('HOLD')

      const response = await request(app).post('/').set('content-type', 'application/json').send({ a: 1 })

      expect(response.status).toBe(200)
      expect(handled).toHaveLength(1)
    })

    it('for anything that is not a POST', async () => {
      await setRelay('HOLD')
      const getApp = buildApp()
      getApp.get('/invitation', (_req, res) => res.status(200).send('ok'))

      expect((await request(getApp).get('/invitation')).text).toBe('ok')
    })

    it('when Redis is down and no relay is known for the key, instead of taking the agent down', async () => {
      await setRelay('HOLD')
      redis.failing = true
      const envelope = buildEnvelope([recipient.kid])

      expect((await send(envelope)).status).toBe(200)
      expect(handled).toEqual([envelope])
    })
  })

  describe('when Redis is down or has lost the relay, and the mirror knows it', () => {
    const mirrorOf = (mode: 'HOLD' | 'FORWARD', target?: string): RelayMirror => {
      const mirror = new RelayMirror()
      mirror.set({ tenantId: TENANT, mode, target, updatedAt: 'now' }, [recipient.fingerprint])
      return mirror
    }

    it('refuses a message for a tenant that is held, and never hands it to Credo', async () => {
      app = buildApp(express(), mirrorOf('HOLD'))
      await setRelay('HOLD')
      redis.failing = true

      const response = await send(buildEnvelope([recipient.kid]))

      expect(response.status).toBe(503)
      expect(response.headers['retry-after']).toBe('30')
      expect(handled).toEqual([])
    })

    it('still forwards a message for a tenant that has moved, without Redis', async () => {
      const target = await startTarget((_request, res) => res.writeHead(200).end())
      cleanups.push(() => target.close())
      app = buildApp(express(), mirrorOf('FORWARD', target.url))
      redis.failing = true
      const envelope = buildEnvelope([recipient.kid])

      const response = await send(envelope)

      expect(response.status).toBe(200)
      await eventually(() => 1 === target.received.length)
      expect(target.received[0].body).toBe(envelope)
      expect(handled).toEqual([])
    })

    it('relays a message after a Redis flush has removed the entry and the index', async () => {
      const target = await startTarget((_request, res) => res.writeHead(200).end())
      cleanups.push(() => target.close())
      app = buildApp(express(), mirrorOf('FORWARD', target.url))
      const envelope = buildEnvelope([recipient.kid])

      const response = await send(envelope)

      expect(response.status).toBe(200)
      await eventually(() => 1 === target.received.length)
      expect(handled).toEqual([])
    })

    it('holds a message after a flush, for a tenant whose relay is still holding', async () => {
      app = buildApp(express(), mirrorOf('HOLD'))
      const envelope = buildEnvelope([recipient.kid])

      const response = await send(envelope)

      expect(response.status).toBe(202)
      expect(await store.holdLength(TENANT)).toBe(1)
      expect(handled).toEqual([])
    })

    it('lets a message through once the relay was removed, although this process still has it in the mirror', async () => {
      app = buildApp(express(), mirrorOf('HOLD'))
      await store.markRemoved(TENANT)
      const envelope = buildEnvelope([recipient.kid])

      expect((await send(envelope)).status).toBe(200)
      expect(handled).toEqual([envelope])
    })

    it('keeps relaying from the mirror when Redis is down and the removal cannot be checked', async () => {
      app = buildApp(express(), mirrorOf('HOLD'))
      await store.markRemoved(TENANT)
      redis.failing = true

      expect((await send(buildEnvelope([recipient.kid]))).status).toBe(503)
      expect(handled).toEqual([])
    })

    it('lets through a message for a key the mirror does not know', async () => {
      app = buildApp(express(), mirrorOf('HOLD'))
      redis.failing = true
      const envelope = buildEnvelope([other.kid])

      expect((await send(envelope)).status).toBe(200)
      expect(handled).toEqual([envelope])
    })
  })

  describe('HOLD', () => {
    it('buffers the message, answers 202 and never hands it to Credo', async () => {
      await setRelay('HOLD')
      const envelope = buildEnvelope([recipient.kid])

      const response = await send(envelope)

      expect(response.status).toBe(202)
      expect(handled).toEqual([])
      expect(await store.holdLength(TENANT)).toBe(1)
      expect(await store.holdPeek(TENANT)).toMatchObject({ contentType: DIDCOMM_MIME, body: envelope })
    })

    it('counts what it holds', async () => {
      await setRelay('HOLD')

      await send(buildEnvelope([recipient.kid]))

      await eventually(async () => 1 === (await store.messagesInLastDays(TENANT, 1)))
    })

    it('refuses with 503 and Retry-After when the buffer is full', async () => {
      await setRelay('HOLD')
      redis.lists.set(
        `relay:hold:${TENANT}`,
        Array.from({ length: HOLD_BUFFER_CAP }, () => '{"receivedAt":"x","contentType":"x","body":"x"}'),
      )

      const response = await send(buildEnvelope([recipient.kid]))

      expect(response.status).toBe(503)
      expect(response.headers['retry-after']).toBe('30')
      expect(handled).toEqual([])
    })

    it('hands the message to Credo, and takes it back out of the buffer, when the relay was removed while it was being held', async () => {
      await setRelay('HOLD')
      const rpush = redis.rpush.bind(redis)
      redis.rpush = async (key: string, ...values: string[]) => {
        const length = await rpush(key, ...values)
        await store.markRemoved(TENANT)
        await store.deleteEntry(TENANT)
        return length
      }
      const envelope = buildEnvelope([recipient.kid])

      const response = await send(envelope)

      expect(response.status).toBe(200)
      expect(handled).toEqual([envelope])
      expect(await store.holdLength(TENANT)).toBe(0)
    })

    it('keeps holding when the entry vanished without a removal, since Redis may just have been flushed', async () => {
      await setRelay('HOLD')
      const rpush = redis.rpush.bind(redis)
      redis.rpush = async (key: string, ...values: string[]) => {
        const length = await rpush(key, ...values)
        await store.deleteEntry(TENANT)
        return length
      }

      const response = await send(buildEnvelope([recipient.kid]))

      expect(response.status).toBe(202)
      expect(handled).toEqual([])
      expect(await store.holdLength(TENANT)).toBe(1)
    })

    it('does not fall through to Credo when it cannot store a message it was holding', async () => {
      await setRelay('HOLD')
      redis.rpush = async () => {
        throw new Error('write failed')
      }

      const response = await send(buildEnvelope([recipient.kid]))

      expect(response.status).toBe(503)
      expect(response.headers['retry-after']).toBe('30')
      expect(handled).toEqual([])
    })
  })

  describe('FORWARD', () => {
    it('relays the envelope to the target and returns its answer unchanged', async () => {
      const target = await startTarget((_request, res) => {
        res.writeHead(201, { 'content-type': DIDCOMM_MIME }).end('{"return":"route"}')
      })
      cleanups.push(() => target.close())
      await setRelay('FORWARD', target.url)
      const envelope = buildEnvelope([recipient.kid])

      const response = await send(envelope)

      expect(response.status).toBe(201)
      expect(response.headers['content-type']).toContain(DIDCOMM_MIME)
      expect(response.text).toBe('{"return":"route"}')
      expect(target.received).toEqual([{ method: 'POST', contentType: DIDCOMM_MIME, body: envelope }])
      expect(handled).toEqual([])
    })

    it('passes a target error status straight back, without retrying it', async () => {
      const target = await startTarget((_request, res) => res.writeHead(500).end())
      cleanups.push(() => target.close())
      await setRelay('FORWARD', target.url)

      expect((await send(buildEnvelope([recipient.kid]))).status).toBe(500)
      expect(target.received).toHaveLength(1)
      expect(await store.holdLength(TENANT)).toBe(0)
    })

    it('answers 504 and does not retry when the target may have received it', async () => {
      const target = await startTarget(() => undefined)
      cleanups.push(() => target.close())
      await setRelay('FORWARD', target.url)

      expect((await send(buildEnvelope([recipient.kid]))).status).toBe(504)
      expect(target.received).toHaveLength(1)
      expect(await store.holdLength(TENANT)).toBe(0)
    })

    it('keeps the message and delivers it once an unreachable target comes back', async () => {
      const port = await freePort()
      await setRelay('FORWARD', `http://127.0.0.1:${port}/`)
      const envelope = buildEnvelope([recipient.kid])

      const response = await send(envelope)

      expect(response.status).toBe(202)
      expect(await store.holdLength(TENANT)).toBe(1)

      const target = await startTarget((_request, res) => res.writeHead(200).end(), port)
      cleanups.push(() => target.close())
      await eventually(async () => 0 === (await store.holdLength(TENANT)))
      expect(target.received).toEqual([{ method: 'POST', contentType: DIDCOMM_MIME, body: envelope }])
      expect(handled).toEqual([])
    })

    it('counts what it forwards', async () => {
      const target = await startTarget()
      cleanups.push(() => target.close())
      await setRelay('FORWARD', target.url)

      await send(buildEnvelope([recipient.kid]))

      await eventually(async () => 1 === (await store.messagesInLastDays(TENANT, 1)))
    })
  })

  describe('mounted behind the real Credo HTTP inbound transport', () => {
    it('reads the raw envelope the transport has already parsed, and leaves it intact for pass-through', async () => {
      const transport = new DidCommHttpInboundTransport({ port: 0 })
      transport.app.use(
        createRelayMiddleware({ store, forward: createForwarder(300), drainer, logger: silentLogger() }),
      )
      transport.app.post('/', (req, res) => {
        handled.push(req.body)
        expect(() => JSON.parse(req.body)).not.toThrow()
        res.status(200).end()
      })
      await setRelay('HOLD')

      const held = await request(transport.app)
        .post('/')
        .set('content-type', DIDCOMM_MIME)
        .send(buildEnvelope([recipient.kid]))
      const passed = await request(transport.app)
        .post('/')
        .set('content-type', DIDCOMM_MIME)
        .send(buildEnvelope([other.kid]))

      expect(held.status).toBe(202)
      expect(passed.status).toBe(200)
      expect(handled).toHaveLength(1)
    })
  })
})
