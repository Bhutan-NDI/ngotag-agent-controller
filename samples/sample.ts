import type { ServerConfig } from '../src/utils/ServerConfig'

import { connect } from 'ngrok'

import { startServer } from '../src/index'
import { setupAgent } from '../src/utils/agent'

const run = async () => {
  const endpoint = await connect(3001)

  const agent = await setupAgent({
    port: 3001,
    endpoints: [endpoint],
    id: 'Sample',
    key: 'Sample',
  })

  const conf: ServerConfig = {
    port: 3000,
    // No fallback: setupServer rejects a missing or short key, which is the point of the guard.
    apiKey: process.env.API_KEY,
    cors: true,
  }

  await startServer(agent, conf)
}

run()
