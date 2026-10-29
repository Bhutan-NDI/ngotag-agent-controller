import { adminRequestTimeoutMs } from '../adminRequestTimeout'

describe('adminRequestTimeoutMs', () => {
  it('outlasts the platform’s 30 minute push by default', () => {
    expect(adminRequestTimeoutMs({})).toBeGreaterThan(30 * 60 * 1000)
  })

  it('reads the limit from ADMIN_REQUEST_TIMEOUT_MS', () => {
    expect(adminRequestTimeoutMs({ ADMIN_REQUEST_TIMEOUT_MS: '120000' })).toBe(120000)
  })

  it.each(['', '0', '-5', 'abc', '1.5'])('falls back to the default for %j', (value) => {
    expect(adminRequestTimeoutMs({ ADMIN_REQUEST_TIMEOUT_MS: value })).toBe(adminRequestTimeoutMs({}))
  })
})
