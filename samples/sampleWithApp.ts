import type { ServerConfig } from '../src/utils/ServerConfig'

import { AgentConfig } from '@credo-ts/core'
import bodyParser from 'body-parser'
import express from 'express'
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

  const app = express()
  const jsonParser = bodyParser.json()

  app.post('/greeting', jsonParser, (req, res) => {
    const config = agent.dependencyManager.resolve(AgentConfig)

    res.send(`Hello, agent initialized: , ${agent.isInitialized}!`)
  })

  const conf: ServerConfig = {
    port: 3000,
    // No fallback: setupServer rejects a missing or short key, which is the point of the guard.
    apiKey: process.env.API_KEY,
    webhookUrl: 'http://localhost:5000/agent-events',
    app: app,
  }

  await startServer(agent, conf)
}

run()
