import type { Express } from 'express'
import type { Server } from 'ws'

export interface ServerConfig {
  port: number
  /* Forwarded to setupServer separately, and never serialized. */
  apiKey?: string
  cors?: boolean
  app?: Express
  webhookUrl?: string
  /* Socket server is used for sending events over websocket to clients */
  socketServer?: Server
  schemaFileServerURL?: string
}

// config.json is written on boot, and a secret on disk outlives any rotation.
export const toSerializableConfig = (config: ServerConfig): Omit<ServerConfig, 'apiKey'> => {
  const { apiKey, ...serializableConfig } = config
  return serializableConfig
}
