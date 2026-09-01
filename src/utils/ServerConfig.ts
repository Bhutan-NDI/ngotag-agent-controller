import type { Express } from 'express'
import type { Server } from 'ws'

export interface ServerConfig {
  port: number
  /* Opens POST /agent/token, the only route that mints an agent token. Optional on the type because
     ServerConfig is also the argument to the event emitters, which have no use for it - but
     setupServer validates it, so a server started without one fails at boot rather than silently
     serving an agent whose tokens can never be minted. */
  apiKey?: string
  cors?: boolean
  app?: Express
  webhookUrl?: string
  /* Socket server is used for sending events over websocket to clients */
  socketServer?: Server
  schemaFileServerURL?: string
}
