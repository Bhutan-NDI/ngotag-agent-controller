import 'reflect-metadata'

import type { ServerConfig } from './utils/ServerConfig'
import type { Agent } from '@credo-ts/core'
import type { Socket } from 'net'

import { WebSocketServer } from 'ws'

import { setupServer } from './server'

export const startServer = async (agent: Agent, config: ServerConfig) => {
  const socketServer = config.socketServer ?? new WebSocketServer({ noServer: true })
  // Keep apiKey out of the object setupServer serializes to config.json.
  const { apiKey, ...serverConfig } = config
  const app = await setupServer(agent, { ...serverConfig, socketServer }, apiKey)
  const server = app.listen(config.port)

  // If no socket server is provided, we will use the existing http server
  // to also host the websocket server
  if (!config.socketServer) {
    server.on('upgrade', (request, socket, head) => {
      socketServer.handleUpgrade(request, socket as Socket, head, () => {})
    })
  }

  return server
}
