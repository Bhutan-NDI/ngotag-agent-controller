import { RelayMirror } from '../RelayMirror'

const entry = (tenantId: string, mode: 'HOLD' | 'FORWARD' = 'HOLD') => ({ tenantId, mode, updatedAt: 'now' })

describe('RelayMirror', () => {
  it('finds the relay that owns any of the given recipient keys', () => {
    const mirror = new RelayMirror()
    mirror.set(entry('t1'), ['fp-a', 'fp-b'])
    mirror.set(entry('t2', 'FORWARD'), ['fp-c'])

    expect(mirror.find(['nope', 'fp-b'])?.tenantId).toBe('t1')
    expect(mirror.find(['fp-c'])?.mode).toBe('FORWARD')
    expect(mirror.find(['nope'])).toBeUndefined()
  })

  it('adds a key to a tenant it knows, and ignores one it does not', () => {
    const mirror = new RelayMirror()
    mirror.set(entry('t1'), ['fp-a'])

    mirror.addFingerprint('t1', 'fp-new')
    mirror.addFingerprint('unknown', 'fp-x')

    expect(mirror.find(['fp-new'])?.tenantId).toBe('t1')
    expect(mirror.find(['fp-x'])).toBeUndefined()
  })

  it('forgets a tenant that was removed', () => {
    const mirror = new RelayMirror()
    mirror.set(entry('t1'), ['fp-a'])

    mirror.remove('t1')

    expect(mirror.has('t1')).toBe(false)
    expect(mirror.find(['fp-a'])).toBeUndefined()
  })

  describe('merging what a refresh read', () => {
    it('takes in new tenants, new keys and a changed mode', () => {
      const mirror = new RelayMirror()
      mirror.set(entry('t1'), ['fp-a'], 100)

      mirror.merge(
        [
          { entry: entry('t1', 'FORWARD'), fingerprints: ['fp-a', 'fp-b'] },
          { entry: entry('t2'), fingerprints: ['fp-c'] },
        ],
        200,
      )

      expect(mirror.find(['fp-b'])?.mode).toBe('FORWARD')
      expect(mirror.find(['fp-c'])?.tenantId).toBe('t2')
    })

    it('drops a tenant that is no longer in the base wallet', () => {
      const mirror = new RelayMirror()
      mirror.set(entry('t1'), ['fp-a'], 100)

      mirror.merge([], 200)

      expect(mirror.has('t1')).toBe(false)
    })

    it('leaves alone a change made after the refresh started reading', () => {
      const mirror = new RelayMirror()
      mirror.set(entry('t1', 'FORWARD'), ['fp-a'], 300)
      mirror.set(entry('t3'), ['fp-z'], 300)

      mirror.merge([{ entry: entry('t1', 'HOLD'), fingerprints: ['fp-a'] }], 200)

      expect(mirror.find(['fp-a'])?.mode).toBe('FORWARD')
      expect(mirror.has('t3')).toBe(true)
    })
  })
})
