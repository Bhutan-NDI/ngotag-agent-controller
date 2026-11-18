/**
 * What the tracer lets onto a span. Query strings are where secrets travel: the wallet import downloads a
 * presigned S3 URL (X-Amz-Signature, X-Amz-Security-Token), and the OpenID4VC routes take preAuthorizedCode
 * and authorizationCode as query parameters. Outgoing URLs are exported without their query; incoming query
 * strings keep their parameter names but not their values.
 */
export {}

const {
  urlWithoutQuery,
  outgoingHttpUrlAttributes,
  undiciUrlAttributes,
  incomingUrlAttributes,
  redactedQuery,
  createInstrumentations,
} = await import('../tracer')

describe('outgoing URLs', () => {
  it('drops the query from an http request (the presigned URL case)', () => {
    const attributes = outgoingHttpUrlAttributes({
      protocol: 'https:',
      hostname: 'bucket.s3.example.com',
      path: '/export/wallet.zip?X-Amz-Signature=SIG&X-Amz-Security-Token=TOK',
    })

    expect(attributes).toEqual({ 'url.full': 'https://bucket.s3.example.com/export/wallet.zip' })
    expect(JSON.stringify(attributes)).not.toMatch(/SIG|TOK/)
  })

  it('keeps the port, and falls back to http and the root path', () => {
    expect(outgoingHttpUrlAttributes({ host: 'listener.internal', port: 8080 })).toEqual({
      'url.full': 'http://listener.internal:8080/',
    })
    expect(urlWithoutQuery('https:', 'h', '/a?b=c')).toBe('https://h/a')
  })

  it('drops the query, and any userinfo, from a global fetch (undici) request', () => {
    const attributes = undiciUrlAttributes({
      origin: 'https://user:password@bucket.s3.example.com',
      path: '/export/wallet.zip?X-Amz-Signature=SIG&X-Amz-Security-Token=TOK',
    })

    expect(attributes['url.full']).toBe('https://bucket.s3.example.com/export/wallet.zip')
    expect(JSON.stringify(attributes)).not.toMatch(/SIG|TOK|password/)
  })

  it('exports nothing rather than throwing when the request has no usable URL', () => {
    expect(undiciUrlAttributes({ origin: 'not a url', path: '/x' })).toEqual({})
  })
})

describe('incoming query strings', () => {
  it('keeps parameter names and replaces every value', () => {
    expect(incomingUrlAttributes({ url: '/oid4vc/x?preAuthorizedCode=SECRET&limit=5&state=done' } as never)).toEqual({
      'url.query': 'preAuthorizedCode=[redacted]&limit=[redacted]&state=[redacted]',
    })
  })

  it('has an empty query when there is none', () => {
    expect(incomingUrlAttributes({ url: '/health' } as never)).toEqual({ 'url.query': '' })
    expect(incomingUrlAttributes({} as never)).toEqual({ 'url.query': '' })
  })

  it('redacts a value that itself contains an equals sign, and a bare flag stays a name', () => {
    expect(redactedQuery('?token=a=b&flag')).toBe('token=[redacted]&flag')
  })
})

describe('createInstrumentations', () => {
  it('builds nothing when OpenTelemetry is off, so http, express and fetch are not patched', () => {
    expect(createInstrumentations(false)).toEqual([])
  })
})
