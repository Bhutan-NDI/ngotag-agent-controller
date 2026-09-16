import assert from 'node:assert/strict'
import { afterEach, beforeEach, test } from 'node:test'
import { RecordDuplicateError } from '@credo-ts/core'
import { DidCommMessageRepository, DidCommMessageRole } from '@credo-ts/didcomm'
import { fixture, protocol, baselineProtocol, kinds, message } from './proofFormat.helpers.mjs'

let f
beforeEach(async () => {
  f = await fixture()
})
afterEach(async () => {
  await f?.close()
})

test('all message subsets retain exact format data with one bounded search instead of three', async () => {
  for (let mask = 0; mask < 8; mask++) {
    const id = `proof-${mask}`
    for (let index = 0; index < kinds.length; index++)
      if (mask & (1 << index)) await f.save(kinds[index][0], { index }, id)
    f.queries.length = 0
    const expected = await baselineProtocol().getFormatData(f.context(), id)
    assert.equal(f.queries.length, 3)
    f.queries.length = 0
    assert.deepEqual(await protocol().getFormatData(f.context(), id), expected)
    assert.equal(f.queries.length, 1)
    assert.deepEqual(f.queries[0].options, { limit: 16 })
  }
})

test('duplicates of each message kind retain RecordDuplicateError and its query', async () => {
  for (const [kind] of kinds) {
    await f.save(kind, {}, kind)
    await f.save(kind, {}, kind, 'tenant-a', DidCommMessageRole.Sender)
    let baselineError
    await assert.rejects(baselineProtocol().getFormatData(f.context(), kind), (error) => {
      baselineError = error
      return error instanceof RecordDuplicateError
    })
    await assert.rejects(
      protocol().getFormatData(f.context(), kind),
      (error) => error instanceof RecordDuplicateError && error.message === baselineError.message,
    )
  }
})

test('overflow falls back to complete exact lookups rather than truncating data', async () => {
  for (let index = 0; index < 20; index++) {
    const record = await f.save('request', { index })
    record.message['@type'] = 'https://didcomm.org/present-proof/2.0/ack'
    await f.repository.update(f.context(), record)
  }
  await f.save('presentation', { expected: true })
  f.queries.length = 0
  assert.deepEqual(await protocol().getFormatData(f.context(), 'proof'), {
    presentation: { fixture: { expected: true } },
  })
  assert.equal(f.queries.length, 4)
  assert.equal(f.queries[0].returned, 16)
  await f.save('presentation', { duplicate: true })
  await assert.rejects(protocol().getFormatData(f.context(), 'proof'), RecordDuplicateError)
})

test('same proof id in different profiles never shares data, including concurrent reads', async () => {
  await f.save('request', { tenant: 'a' })
  await f.save('request', { tenant: 'b' }, 'proof', 'tenant-b')
  const p = protocol()
  const results = await Promise.all([
    p.getFormatData(f.context(), 'proof'),
    p.getFormatData(f.context('tenant-b'), 'proof'),
  ])
  assert.deepEqual(results, [{ request: { fixture: { tenant: 'a' } } }, { request: { fixture: { tenant: 'b' } } }])
})

test('updates and deletion are visible on the next read without cached results', async () => {
  const record = await f.save('presentation', { revision: 1 })
  const p = protocol()
  assert.deepEqual(await p.getFormatData(f.context(), 'proof'), { presentation: { fixture: { revision: 1 } } })
  record.message = message('presentation', { revision: 2 }).toJSON()
  await f.repository.update(f.context(), record)
  assert.deepEqual(await p.getFormatData(f.context(), 'proof'), { presentation: { fixture: { revision: 2 } } })
  await f.repository.delete(f.context(), record)
  assert.deepEqual(await p.getFormatData(f.context(), 'proof'), {})
})

test('unrelated proof ids, protocols, versions and message kinds do not contaminate results', async () => {
  const record = await f.save('request', { wrong: true })
  for (const type of [
    'https://didcomm.org/present-proof/1.0/request-presentation',
    'https://didcomm.org/other/2.0/request-presentation',
    'https://didcomm.org/present-proof/2.0/ack',
  ]) {
    record.message['@type'] = type
    await f.repository.update(f.context(), record)
    assert.deepEqual(await protocol().getFormatData(f.context(), 'proof'), {})
  }
  await f.save('request', { other: true }, 'different-proof')
  assert.deepEqual(await protocol().getFormatData(f.context(), 'proof'), {})
})

test('missing attachments still fail rather than silently omitting malformed data', async () => {
  const record = await f.save('request', {})
  record.message['request_presentations~attach'] = []
  await f.repository.update(f.context(), record)
  await assert.rejects(protocol().getFormatData(f.context(), 'proof'), /not found in attachments/)
  await assert.rejects(baselineProtocol().getFormatData(f.context(), 'proof'), /not found in attachments/)
})

test('unsupported formats preserve the existing empty format object', async () => {
  const record = await f.save('request', {})
  record.message.formats[0].format = 'unsupported/test'
  await f.repository.update(f.context(), record)
  assert.deepEqual(await protocol().getFormatData(f.context(), 'proof'), { request: {} })
})

test('custom protocol lookups retain their original dispatch behavior', async () => {
  const p = protocol()
  let calls = 0
  p.findRequestMessage = async () => {
    calls++
    return message('request', { custom: true })
  }
  assert.deepEqual(await p.getFormatData(f.context(), 'proof'), { request: { fixture: { custom: true } } })
  assert.equal(calls, 1)
})

test('custom repository lookups retain their original dispatch behavior', async () => {
  let calls = 0
  f.repository.findAgentMessage = async () => {
    calls++
    return null
  }
  assert.deepEqual(await protocol().getFormatData(f.context(), 'proof'), {})
  assert.equal(calls, 3)
})

test('storage errors propagate and do not become missing data', async () => {
  f.storage.findByQuery = async () => {
    throw new Error('synthetic storage failure')
  }
  await assert.rejects(protocol().getFormatData(f.context(), 'proof'), /synthetic storage failure/)
})

test('the boundary is conservative at exactly 16 associated records', async () => {
  await f.save('request', { expected: true })
  for (let index = 0; index < 14; index++) {
    const record = await f.save('request', { index })
    record.message['@type'] = 'https://didcomm.org/present-proof/2.0/ack'
    await f.repository.update(f.context(), record)
  }
  f.queries.length = 0
  assert.deepEqual(await protocol().getFormatData(f.context(), 'proof'), { request: { fixture: { expected: true } } })
  assert.equal(f.queries.length, 1)
  const last = await f.save('request', {})
  last.message['@type'] = 'https://didcomm.org/present-proof/2.0/ack'
  await f.repository.update(f.context(), last)
  f.queries.length = 0
  assert.deepEqual(await protocol().getFormatData(f.context(), 'proof'), { request: { fixture: { expected: true } } })
  assert.equal(f.queries.length, 4)
})

for (const method of ['findSingleByQuery', 'findByQuery']) {
  for (const targetName of ['instance', 'prototype']) {
    test(`custom ${targetName} ${method} retains exact lookup queries`, async () => {
      await f.save('request', { custom: true })
      const target = targetName === 'instance' ? f.repository : DidCommMessageRepository.prototype
      const descriptor = Object.getOwnPropertyDescriptor(target, method)
      const original = target[method]
      const calls = []
      target[method] = async function (context, query, options) {
        calls.push({ query, options })
        return original.call(this, context, query, options)
      }
      try {
        assert.deepEqual(await protocol().getFormatData(f.context(), 'proof'), {
          request: { fixture: { custom: true } },
        })
        assert.equal(calls.length, 3)
        assert.deepEqual(
          calls.map(({ query }) => query.messageName).sort(),
          kinds.map(([, Message]) => Message.type.messageName).sort(),
        )
        assert.ok(calls.every(({ options }) => options === undefined))
      } finally {
        if (descriptor) Object.defineProperty(target, method, descriptor)
        else delete target[method]
      }
    })
  }
}

test('simultaneous duplicate kinds reject without promising baseline error ordering', async () => {
  for (const [kind] of kinds) {
    await f.save(kind, {})
    await f.save(kind, {}, 'proof', 'tenant-a', DidCommMessageRole.Sender)
  }
  await assert.rejects(baselineProtocol().getFormatData(f.context(), 'proof'), RecordDuplicateError)
  await assert.rejects(protocol().getFormatData(f.context(), 'proof'), (error) => {
    assert.ok(error instanceof RecordDuplicateError)
    assert.match(error.message, /propose-presentation/)
    return true
  })
})
