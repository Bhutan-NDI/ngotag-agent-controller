import { assertValidRelayTarget, InvalidRelayTargetError } from '../relayTarget'

describe('assertValidRelayTarget', () => {
  it('accepts a public https address and returns it normalised', () => {
    expect(assertValidRelayTarget('https://agent.example.org')).toBe('https://agent.example.org/')
    expect(assertValidRelayTarget('https://agent.example.org:8443/didcomm')).toBe(
      'https://agent.example.org:8443/didcomm',
    )
  })

  it.each([
    ['undefined', undefined],
    ['an empty string', ''],
    ['a number', 5],
    ['not a URL', 'agent.example.org'],
    ['plain http', 'http://agent.example.org'],
    ['credentials in the URL', 'https://user:pass@agent.example.org'],
    ['localhost', 'https://localhost:4002'],
    ['a .localhost name', 'https://agent.localhost'],
    ['an .internal name', 'https://metadata.google.internal'],
    ['loopback', 'https://127.0.0.1'],
    ['a private 10.x address', 'https://10.0.0.5'],
    ['a private 172.16 address', 'https://172.20.1.1'],
    ['a private 192.168 address', 'https://192.168.1.10'],
    ['the cloud metadata address', 'https://169.254.169.254/latest/meta-data'],
    ['a carrier-grade NAT address', 'https://100.64.0.1'],
    ['IPv6 loopback', 'https://[::1]/'],
    ['an IPv6 link-local address', 'https://[fe80::1]/'],
    ['an IPv6 unique-local address', 'https://[fd00::1]/'],
    ['an IPv4-mapped private address', 'https://[::ffff:10.0.0.5]:8443/'],
    ['an IPv4-mapped metadata address', 'https://[::ffff:169.254.169.254]/'],
    ['an IPv4-mapped loopback address', 'https://[::ffff:127.0.0.1]/'],
    ['an IPv4-compatible private address', 'https://[::10.0.0.5]/'],
    ['a NAT64 address', 'https://[64:ff9b::a00:5]/'],
    ['an over-long URL', `https://agent.example.org/${'a'.repeat(3000)}`],
  ])('rejects %s', (_name, value) => {
    expect(() => assertValidRelayTarget(value)).toThrow(InvalidRelayTargetError)
  })

  it('accepts an IPv4-mapped public address', () => {
    expect(assertValidRelayTarget('https://[::ffff:8.8.8.8]/')).toBe('https://[::ffff:808:808]/')
  })

  it('does not reject a public address that merely resembles a private range', () => {
    expect(() => assertValidRelayTarget('https://172.32.0.1')).not.toThrow()
    expect(() => assertValidRelayTarget('https://100.128.0.1')).not.toThrow()
  })
})
