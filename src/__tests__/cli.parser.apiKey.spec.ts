/**
 * Parses through the definition cli.ts actually uses, rather than one the test rebuilds.
 *
 * validateApiKey passing in isolation proves nothing about the wiring: if `coerce` were detached, or
 * registered under a different option name, a unit test of the validator alone would stay green. This
 * calls the same buildParser that cli.ts's parseArguments calls, so the registration is under test.
 *
 * Only yargs' exit policy is overridden -- on a validation failure it prints and calls process.exit,
 * which is the right behaviour for a CLI but cannot be observed from a test (its ESM shim holds its
 * own reference to process.exit, so spying does not intercept). The option definitions, including the
 * coercion under test, are production.
 *
 * Runs under Jest ESM mode (see jest.config.base.ts).
 */
import { buildParser } from '../cli.parser'

// Everything else the parser demands, so a rejection can only come from apiKey.
const REQUIRED = [
  '--label=test',
  '--wallet-id=test',
  '--wallet-key=test',
  '--wallet-type=postgres',
  '--wallet-url=localhost:5432',
  '--wallet-scheme=DatabasePerWallet',
  '--wallet-account=test',
  '--wallet-password=test',
  '--wallet-admin-account=test',
  '--wallet-admin-password=test',
  '--admin-port=3000',
]

const parse = async (extra: string[], apiKeyEnv?: string): Promise<{ apiKey?: string }> => {
  const previous = process.env.API_KEY
  if (undefined === apiKeyEnv) {
    delete process.env.API_KEY
  } else {
    process.env.API_KEY = apiKeyEnv
  }
  try {
    return (await buildParser([...REQUIRED, ...extra])
      .exitProcess(false)
      .fail((message, error) => {
        throw new Error(message || error.message)
      })
      .parseAsync()) as { apiKey?: string }
  } finally {
    if (undefined === previous) {
      delete process.env.API_KEY
    } else {
      process.env.API_KEY = previous
    }
  }
}

describe('cli parser, apiKey option', () => {
  it.each([
    ['no flag and no API_KEY', [] as string[], undefined],
    ['an empty API_KEY', [] as string[], ''],
    ['a whitespace-only API_KEY', [] as string[], '   '],
  ])('rejects %s', async (_label, extra, apiKeyEnv) => {
    await expect(parse(extra, apiKeyEnv)).rejects.toThrow('API key is required')
  })

  it('rejects a short --apiKey', async () => {
    await expect(parse([`--apiKey=${'x'.repeat(15)}`])).rejects.toThrow('at least 16 characters')
  })

  it('trims, so a padded short value is still rejected', async () => {
    await expect(parse([], `  ${'x'.repeat(15)}  `)).rejects.toThrow('at least 16 characters')
  })

  it('accepts a valid --apiKey', async () => {
    await expect(parse([`--apiKey=${'x'.repeat(16)}`])).resolves.toMatchObject({ apiKey: 'x'.repeat(16) })
  })

  it('accepts a valid API_KEY from the environment', async () => {
    await expect(parse([], 'y'.repeat(20))).resolves.toMatchObject({ apiKey: 'y'.repeat(20) })
  })
})
