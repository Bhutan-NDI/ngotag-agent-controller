import 'reflect-metadata'
import { DidCommOutOfBandRepository, DidCommProofExchangeRepository } from '@credo-ts/didcomm'
import { jest } from '@jest/globals'

import { recordPageOptions } from '../../../utils/recordPagination'
import { OutOfBandController } from '../outofband/OutOfBandController'
import { ProofController } from '../proofs/ProofController'

const rows = Array.from({ length: 4 }, (_, index) => ({ toJSON: () => ({ id: String(index) }) }))

describe.each([
  ['proofs', () => new ProofController(), 'getAllProofs', DidCommProofExchangeRepository, 'threadId'],
  ['oob', () => new OutOfBandController(), 'getAllOutOfBandRecords', DidCommOutOfBandRepository, 'invitationId'],
] as const)('%s list compatibility', (module, create, method, Repository, filter) => {
  function fixture() {
    const legacy = jest.fn<(...args: unknown[]) => Promise<typeof rows>>().mockResolvedValue(rows)
    const bounded = jest.fn<(...args: unknown[]) => Promise<typeof rows>>().mockResolvedValue(rows.slice(0, 3))
    const resolve = jest.fn().mockReturnValue({ findByQuery: bounded })
    const request = {
      agent: {
        context: { dependencyManager: { resolve } },
        modules: { didcomm: { [module]: { findAllByQuery: legacy } } },
      },
    }
    const controller = create()
    const call = (id?: string, limit?: number, offset?: number) =>
      (controller as any)[method](request, id, limit, offset)
    return { legacy, bounded, resolve, request, controller, call }
  }
  it('preserves the full legacy array and exact filter', async () => {
    const f = fixture()
    expect(await f.call('filter-value')).toEqual(rows.map((row) => row.toJSON()))
    expect(f.legacy).toHaveBeenCalledWith({ [filter]: 'filter-value' })
    expect(f.bounded).not.toHaveBeenCalled()
    expect(f.controller.getHeaders()).toEqual({})
  })
  it('loads complete results in one call even when they exceed the maximum page size', async () => {
    const f = fixture()
    const complete = Array.from({ length: 1105 }, (_, index) => ({ toJSON: () => ({ id: String(index) }) }))
    f.legacy.mockResolvedValue(complete)
    expect(await f.call()).toEqual(complete.map((row) => row.toJSON()))
    expect(f.legacy).toHaveBeenCalledTimes(1)
    expect(f.legacy).toHaveBeenCalledWith({})
    expect(f.bounded).not.toHaveBeenCalled()
  })

  it('bounds the storage query, preserves context and filter, and provides continuation', async () => {
    const f = fixture()
    expect(await f.call('filter-value', 2, 4)).toEqual([{ id: '0' }, { id: '1' }])
    expect(f.resolve).toHaveBeenCalledWith(Repository)
    expect(f.bounded).toHaveBeenCalledWith(
      f.request.agent.context,
      { [filter]: 'filter-value' },
      { limit: 3, offset: 4, orderBy: 'id' },
    )
    expect(f.legacy).not.toHaveBeenCalled()
    expect(f.controller.getHeaders()).toMatchObject({ 'X-Has-More': 'true', 'X-Next-Offset': '6' })
  })
  it('marks an empty final page and does not invent a next offset', async () => {
    const f = fixture()
    f.bounded.mockResolvedValue([])
    expect(await f.call(undefined, 2)).toEqual([])
    expect(f.controller.getHeaders()).toMatchObject({ 'X-Has-More': 'false' })
    expect(f.controller.getHeaders()).not.toHaveProperty('X-Next-Offset')
  })
  it('validates before touching the agent', async () => {
    const f = fixture()
    await expect(f.call(undefined, undefined, 3)).rejects.toMatchObject({ statusCode: 400 })
    expect(f.resolve).not.toHaveBeenCalled()
    expect(f.legacy).not.toHaveBeenCalled()
  })
})

describe('page bounds', () => {
  it.each([0, -1, 1.5, NaN, Infinity, 1001])('rejects invalid limit %s', (limit) => {
    expect(() => recordPageOptions(limit)).toThrow()
  })
  it.each([-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER])('rejects invalid offset %s', (offset) => {
    expect(() => recordPageOptions(10, offset)).toThrow()
  })
  it('supports the largest page and default offset', () => {
    expect(recordPageOptions(1000)).toEqual({ limit: 1001, offset: 0, orderBy: 'id' })
    expect(recordPageOptions()).toBeUndefined()
  })
})
