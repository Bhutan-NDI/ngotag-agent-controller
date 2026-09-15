// eslint-disable-next-line import/order
import { otelSDK } from './tracer'
import 'reflect-metadata'
import type { RestAgentModules, RestMultiTenantAgentModules } from './cliAgent'
import type { ApiError } from './errors'
import type { ServerConfig } from './utils/ServerConfig'
import type { Response as ExResponse, Request as ExRequest, NextFunction, ErrorRequestHandler } from 'express'

import { Agent, type Logger } from '@credo-ts/core'
import { TenantAgent } from '@credo-ts/tenants'
import bodyParser from 'body-parser'
import cors from 'cors'
import dotenv from 'dotenv'
import express from 'express'
import { rateLimit } from 'express-rate-limit'
import * as fs from 'fs'
import { generateHTML, serve } from 'swagger-ui-express'
import { ValidateError } from 'tsoa'
import { container } from 'tsyringe'

import { setDynamicApiKey } from './authentication'
import { mountBaseMiddleware } from './baseMiddleware'
import { ErrorMessages } from './enums'
import { createErrorHandler } from './errorHandler'
import { BaseError } from './errors/errors'
import { basicMessageEvents } from './events/BasicMessageEvents'
import { connectionEvents } from './events/ConnectionEvents'
import { credentialEvents } from './events/CredentialEvents'
import { proofEvents } from './events/ProofEvents'
import { questionAnswerEvents } from './events/QuestionAnswerEvents'
import { reuseConnectionEvents } from './events/ReuseConnectionEvents'
import { openId4VcIssuanceSessionEvents } from './events/openId4VcIssuanceSessionEvents'
import { openId4VcVerificationSessionEvents } from './events/openId4VcVerificationSessionEvents'
import { RegisterRoutes } from './routes/routes'
import { SecurityMiddleware } from './securityMiddleware'
import { toSerializableConfig } from './utils/ServerConfig'
import { validateAuthConfig } from './utils/auth'
import { validateApiKey } from './utils/config'

dotenv.config()

export const setupServer = async (
  agent: Agent<RestMultiTenantAgentModules | RestAgentModules>,
  config: ServerConfig,
  apiKey?: string,
) => {
  // Before any side effect: a caught-and-retried boot would otherwise duplicate registrations.
  const validatedApiKey = validateApiKey(apiKey)

  if (process.env.OTEL_ENABLED === 'true') {
    await otelSDK.start()
    agent.config.logger.info('OpenTelemetry SDK started')
  } else {
    agent.config.logger.info('OpenTelemetry SDK disabled (set OTEL_ENABLED=true to enable)')
  }
  validateAuthConfig()
  container.registerInstance(Agent, agent as Agent)
  fs.writeFileSync('config.json', JSON.stringify(toSerializableConfig(config), null, 2))

  const app = config.app ?? express()
  if (config.cors) app.use(cors())

  if (config.socketServer || config.webhookUrl) {
    questionAnswerEvents(agent, config)
    basicMessageEvents(agent, config)
    connectionEvents(agent, config)
    credentialEvents(agent, config)
    openId4VcIssuanceSessionEvents(agent, config)
    openId4VcVerificationSessionEvents(agent, config)
    proofEvents(agent, config)
    reuseConnectionEvents(agent, config)
  }

  setDynamicApiKey(validatedApiKey)

  mountBaseMiddleware(app)
  app.use('/docs', serve, (_req: ExRequest, res: ExResponse, next: NextFunction) => {
    import('./routes/swagger.json')
      .then((swaggerJson) => {
        res.send(generateHTML(swaggerJson))
      })
      .catch(next)
  })

  // Note: Having used it above, redirects accordingly
  app.use((req, res, next) => {
    if (req.url == '/') {
      res.redirect('/docs')
      return
    }
    next()
  })

  app.use(async (req: ExRequest, res: ExResponse, next: NextFunction) => {
    res.on('finish', async () => {
      await endTenantSessionIfActive(req)
    })
    next()
  })

  const securityMiddleware = new SecurityMiddleware()
  app.use(securityMiddleware.use)
  RegisterRoutes(app)

  app.use(createErrorHandler(agent.config.logger))

  return app
}

async function endTenantSessionIfActive(request: ExRequest) {
  if ('agent' in request) {
    const agent = request?.agent
    if (agent instanceof TenantAgent) {
      agent.config.logger.debug(`Ending tenant session for tenant:: ${agent.context.contextCorrelationId}`)
      // TODO: we can also not wait for the ending of session
      // This can further imporve the response time
      await agent.endSession()
    }
  }
}
