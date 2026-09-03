import dotenv from 'dotenv'

dotenv.config()

import { parseArguments, toAgentConfig } from './cli.parser.js'
import { runRestAgent } from './cliAgent.js'

export async function runCliServer() {
  const parsed = await parseArguments()

  await runRestAgent(toAgentConfig(parsed))
}
