/**
 * The apiKey option needs `default: process.env.API_KEY` for yargs to invoke its coercion at all -
 * without a default, coerce never runs for an absent option and the key goes unvalidated. yargs also
 * renders an option's default in the help it emits on a parse failure, so the default carries a
 * defaultDescription to keep the value out of that output.
 */
import { buildParser } from '../cli.parser'

const SENTINEL = 'SENTINEL_API_KEY_123456'

const withApiKeyEnv = async (run: () => Promise<string>): Promise<string> => {
  const previous = process.env.API_KEY
  process.env.API_KEY = SENTINEL
  try {
    return await run()
  } finally {
    if (undefined === previous) {
      delete process.env.API_KEY
    } else {
      process.env.API_KEY = previous
    }
  }
}

describe('parser output', () => {
  it('keeps the key out of the help emitted on a parse failure', async () => {
    const output = await withApiKeyEnv(async () => {
      let failMessage = ''
      const parser = buildParser(['--label=test']).exitProcess(false)
      parser.fail((message) => {
        failMessage = message ?? ''
      })
      await parser.parseAsync()
      return `${failMessage}\n${await parser.getHelp()}`
    })

    expect(output).toContain('--apiKey')
    expect(output).not.toContain(SENTINEL)
  })

  it('keeps the key out of the help text', async () => {
    const output = await withApiKeyEnv(async () => buildParser([]).getHelp())

    expect(output).toContain('--apiKey')
    expect(output).not.toContain(SENTINEL)
  })
})
