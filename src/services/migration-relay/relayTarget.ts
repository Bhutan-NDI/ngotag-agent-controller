export class InvalidRelayTargetError extends Error {
  public constructor(reason: string) {
    super(`Invalid relay target: ${reason}`)
    this.name = 'InvalidRelayTargetError'
  }
}

const MAX_TARGET_LENGTH = 2048
const PRIVATE_IPV4 = [
  /^0\./,
  /^10\./,
  /^127\./,
  /^169\.254\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
]

// URL writes an IPv4-mapped (::ffff:a.b.c.d) or IPv4-compatible (::a.b.c.d) literal as two hex groups.
const embeddedIpv4 = (host: string): string | undefined => {
  const match = /^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host)
  if (!match) return undefined
  const [high, low] = [parseInt(match[1], 16), parseInt(match[2], 16)]
  return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`
}

// Where an organisation's agent is reached. https only, and never an address on this agent's own network or a cloud
// metadata endpoint, since the relay (and the probe) make requests to whatever this names. Hostname literals are
// checked; DNS answers are not.
export const assertValidRelayTarget = (target: unknown): string => {
  if ('string' !== typeof target || '' === target || target.length > MAX_TARGET_LENGTH) {
    throw new InvalidRelayTargetError('a target URL is required')
  }
  let url: URL
  try {
    url = new URL(target)
  } catch {
    throw new InvalidRelayTargetError('not a valid URL')
  }
  if ('https:' !== url.protocol) {
    throw new InvalidRelayTargetError('must use https')
  }
  if (url.username || url.password) {
    throw new InvalidRelayTargetError('must not carry credentials')
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  const ipv4 = embeddedIpv4(host) ?? host
  if (
    'localhost' === host ||
    host.endsWith('.localhost') ||
    host.endsWith('.internal') ||
    '::1' === host ||
    '::' === host ||
    host.startsWith('fe80:') ||
    (host.startsWith('fc') && host.includes(':')) ||
    (host.startsWith('fd') && host.includes(':')) ||
    host.startsWith('64:ff9b:') ||
    PRIVATE_IPV4.some((pattern) => pattern.test(ipv4))
  ) {
    throw new InvalidRelayTargetError('must be a public address')
  }
  return url.toString()
}
