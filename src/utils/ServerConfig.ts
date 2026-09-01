import type { Express } from 'express'
import type { Server } from 'ws'

export interface ServerConfig {
  port: number
  /* Opens POST /agent/token, the only route that mints an agent token. setupServer takes it as a
     separate argument and never serializes it - see toSerializableConfig. */
  apiKey?: string
  cors?: boolean
  app?: Express
  webhookUrl?: string
  /* Socket server is used for sending events over websocket to clients */
  socketServer?: Server
  schemaFileServerURL?: string
}

// setupServer writes its config to config.json on boot, so the key has to be dropped before it is
// serialized: a secret on disk outlives the process and any rotation.
export const toSerializableConfig = (config: ServerConfig): Omit<ServerConfig, 'apiKey'> => {
  const { apiKey, ...serializableConfig } = config
  return serializableConfig
}
