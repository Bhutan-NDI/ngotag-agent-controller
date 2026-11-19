import dotenv from 'dotenv'

dotenv.config()

// Before anything that loads http or express (cliAgent does): OpenTelemetry can only instrument
// modules that are required after it is registered. cli.startup.order.spec.ts guards this order.
// eslint-disable-next-line import/order
import { startTelemetry } from './tracer'
import { parseArguments, toAgentConfig } from './cli.parser.js'
import { runRestAgent } from './cliAgent.js'

export async function runCliServer() {
  await startTelemetry()
  const parsed = await parseArguments()

  await runRestAgent(toAgentConfig(parsed))
}
