/**
 * The load balancer polls /health constantly and the Swagger page is not worth a trace; both are kept
 * out of Tempo. Everything else, including look-alike paths, is traced.
 */
export {}

const { isUntracedRequest } = await import('../tracer')

describe('isUntracedRequest', () => {
  it.each(['/health', '/health?probe=1', '/docs', '/docs/', '/docs/swagger-ui.css'])('skips %s', (url) => {
    expect(isUntracedRequest(url)).toBe(true)
  })

  it.each(['/didcomm/oob/create-invitation', '/healthcheck', '/api/health', '/documents', '/', undefined])(
    'traces %s',
    (url) => {
      expect(isUntracedRequest(url)).toBe(false)
    },
  )
})
