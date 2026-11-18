/* eslint-disable import/order */
/* eslint-disable no-console */
// Must be the first thing the process loads (cli.ts imports it before anything else): the
// instrumentations can only patch http and express if they are registered before those modules
// are required. Everything below is inert unless OTEL_ENABLED=true.
import { NodeSDK } from '@opentelemetry/sdk-node'
import * as process from 'process'

import { HttpInstrumentation } from '@opentelemetry/instrumentation-http'
import { ExpressInstrumentation, ExpressLayerType } from '@opentelemetry/instrumentation-express'
import { RuntimeNodeInstrumentation } from '@opentelemetry/instrumentation-runtime-node'
import { UndiciInstrumentation } from '@opentelemetry/instrumentation-undici'
import { HostMetrics } from '@opentelemetry/host-metrics'

import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http'
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http'

import {
  defaultResource,
  detectResources,
  envDetector,
  hostDetector,
  resourceFromAttributes,
} from '@opentelemetry/resources'
import { awsEcsDetector } from '@opentelemetry/resource-detector-aws'
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions'
import type { Logger } from '@opentelemetry/api-logs'
import type { IncomingMessage, RequestOptions } from 'http'

import { LoggerProvider, BatchLogRecordProcessor } from '@opentelemetry/sdk-logs'
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics'
import { DiagConsoleLogger, DiagLogLevel, diag } from '@opentelemetry/api'
import dotenv from 'dotenv'
dotenv.config()

const otelEnabled = process.env.OTEL_ENABLED === 'true'

// Not in the stable semantic-conventions entry point (it is under /incubating, which this repo's
// moduleResolution cannot import).
const ATTR_SERVICE_INSTANCE_ID = 'service.instance.id'

// The load balancer polls /health constantly and nobody reads the Swagger page's traces; either would
// fill Tempo with identical spans. Matched on the path only, so a query string cannot defeat it.
export const isUntracedRequest = (url: string | undefined) => {
  const path = (url ?? '').split('?')[0]
  return path === '/health' || path === '/docs' || path.startsWith('/docs/')
}

if (otelEnabled) {
  // Must be set before the instrumentations are built. The old HTTP semantic conventions label
  // http.server.duration with net.host.name (the client's Host header, so every scanner's random Host is
  // a new series) and with the raw http.method. The stable conventions drop both, and name the URL
  // attributes url.full / url.query. An operator can still set it explicitly.
  process.env.OTEL_SEMCONV_STABILITY_OPT_IN ??= 'http'
}

/**
 * A query string as exported on a span: parameter names kept, values replaced. Names are useful (which filter
 * was used) and not secret; values can be (the OpenID4VC routes take preAuthorizedCode and authorizationCode
 * as query parameters). Without the leading '?', as url.query is defined.
 */
export const redactedQuery = (search: string) => search.replace(/^\?/, '').replace(/=[^&]*/g, '=[redacted]')

/**
 * An outgoing URL as exported on a span: scheme, host and path, never the query or userinfo. The wallet
 * import downloads a presigned S3 URL, and X-Amz-Signature / X-Amz-Security-Token sit in its query.
 */
export const urlWithoutQuery = (scheme: string, host: string, path: string) => `${scheme}//${host}${path.split('?')[0]}`

// Override what the instrumentations record: attributes returned from a start-span hook win over theirs.
export const outgoingHttpUrlAttributes = (options: RequestOptions) => ({
  'url.full': urlWithoutQuery(
    options.protocol ?? 'http:',
    `${options.hostname ?? options.host ?? 'localhost'}${options.port ? `:${options.port}` : ''}`,
    options.path ?? '/',
  ),
})

// What the controller's own API was called with.
export const incomingUrlAttributes = (request: IncomingMessage) => {
  const url = request.url ?? ''
  const queryStart = url.indexOf('?')
  return { 'url.query': queryStart < 0 ? '' : redactedQuery(url.slice(queryStart)) }
}

export const undiciUrlAttributes = (request: { origin: string | URL; path: string }) => {
  try {
    const url = new URL(request.path, request.origin)
    return { 'url.full': `${url.origin}${url.pathname}`, 'url.query': redactedQuery(url.search) }
  } catch {
    return {}
  }
}

const ENDPOINT_VARS = ['OTEL_TRACES_OTLP_ENDPOINT', 'OTEL_LOGS_OTLP_ENDPOINT', 'OTEL_METRICS_OTLP_ENDPOINT'] as const

if (otelEnabled) {
  // The SDK reports failed exports through this logger, so it stays on; WARN keeps it quiet otherwise.
  const diagLevels: Record<string, DiagLogLevel> = {
    NONE: DiagLogLevel.NONE,
    ERROR: DiagLogLevel.ERROR,
    WARN: DiagLogLevel.WARN,
    INFO: DiagLogLevel.INFO,
    DEBUG: DiagLogLevel.DEBUG,
    VERBOSE: DiagLogLevel.VERBOSE,
    ALL: DiagLogLevel.ALL,
  }
  diag.setLogger(
    new DiagConsoleLogger(),
    diagLevels[(process.env.OTEL_LOG_LEVEL ?? '').toUpperCase()] ?? DiagLogLevel.WARN,
  )

  // An exporter with no URL silently falls back to localhost:4318, and one with no key is refused by Alloy.
  const missing = [...ENDPOINT_VARS, 'OTEL_HEADERS_KEY'].filter((name) => !process.env[name])
  if (missing.length > 0) {
    console.warn(`OpenTelemetry is enabled but ${missing.join(', ')} ${missing.length > 1 ? 'are' : 'is'} not set`)
  }
}

// One resource for traces, logs and metrics, so a log line, a span and a metric from the same task
// share their labels in Grafana. The ECS detector adds the task, cluster and container identity
// (async: exporters wait for it); outside ECS it detects nothing. Detection only runs when enabled.
//
// Deliberately not the process detector: it exports the whole of process.argv as process.command_args
// on every span, log and metric, and the documented start passes --wallet-key and --wallet-password as
// arguments. Only the process attributes that identify a task are set.
const resource = defaultResource()
  .merge(
    resourceFromAttributes({
      ...(process.env.OTEL_SERVICE_NAME ? { [ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME } : {}),
      ...(process.env.OTEL_SERVICE_VERSION ? { [ATTR_SERVICE_VERSION]: process.env.OTEL_SERVICE_VERSION } : {}),
      ...(process.env.HOSTNAME ? { [ATTR_SERVICE_INSTANCE_ID]: process.env.HOSTNAME } : {}),
      'process.pid': process.pid,
      'process.runtime.name': 'nodejs',
      'process.runtime.version': process.versions.node,
    }),
  )
  .merge(
    detectResources({
      detectors: otelEnabled ? [envDetector, hostDetector, awsEcsDetector] : [],
    }),
  )

// Alloy checks this against the environment's ingest token. Without a key there is nothing to send.
const headers = process.env.OTEL_HEADERS_KEY ? { Authorization: `Api-Key ${process.env.OTEL_HEADERS_KEY}` } : undefined

const traceExporter = new OTLPTraceExporter({ url: process.env.OTEL_TRACES_OTLP_ENDPOINT, headers })
const logExporter = new OTLPLogExporter({ url: process.env.OTEL_LOGS_OTLP_ENDPOINT, headers })
const metricExporter = new OTLPMetricExporter({ url: process.env.OTEL_METRICS_OTLP_ENDPOINT, headers })

// Only add the BatchLogRecordProcessor when OTEL is enabled — otherwise it
// tries to connect to localhost:4318 on every flush even if SDK never started.
const logProvider = new LoggerProvider({
  resource,
  processors: otelEnabled ? [new BatchLogRecordProcessor(logExporter)] : [],
})
export const otelLogger: Logger = logProvider.getLogger('credo-controller-logger')
export const otelLoggerProviderInstance = logProvider

// Instrumentations patch http, express and fetch the moment they are constructed, and this module loads
// first in every environment, so they are only built when OpenTelemetry is on.
export const createInstrumentations = (enabled: boolean) =>
  enabled
    ? [
        new HttpInstrumentation({
          ignoreIncomingRequestHook: (request) => isUntracedRequest(request.url),
          startIncomingSpanHook: incomingUrlAttributes,
          startOutgoingSpanHook: outgoingHttpUrlAttributes,
        }),
        // A span per middleware layer on every request is most of the trace volume; the router and
        // request-handler spans stay.
        new ExpressInstrumentation({ ignoreLayersType: [ExpressLayerType.MIDDLEWARE] }),
        // Global fetch (purge webhooks, the relay, trust lists); node-fetch and axios go through http above.
        new UndiciInstrumentation({ startSpanHook: undiciUrlAttributes }),
        // Event loop delay, GC and heap: the runtime view that host and ECS metrics do not give.
        new RuntimeNodeInstrumentation(),
      ]
    : []

export const otelSDK = new NodeSDK({
  traceExporter,
  resource,
  // The resource above already ran the detectors; the SDK must not run its own set on top.
  autoDetectResources: false,
  // Only when enabled: the reader starts exporting as soon as the SDK starts.
  ...(otelEnabled
    ? { metricReader: new PeriodicExportingMetricReader({ exporter: metricExporter, exportIntervalMillis: 60_000 }) }
    : {}),
  instrumentations: createInstrumentations(otelEnabled),
})

let started = false

// No-op unless OTEL_ENABLED=true. Called from cli.ts before the agent is built, so the earliest
// requests and the agent's own start-up are covered.
export const startTelemetry = async () => {
  if (!otelEnabled || started) return
  started = true
  await otelSDK.start()
  // Needs the meter provider the SDK just registered. Process and host CPU, memory and network.
  new HostMetrics({ name: process.env.OTEL_SERVICE_NAME }).start()
}

// Called from the graceful shutdown, after the app has stopped, so its last logs are in the flush.
// Bounded: an unreachable collector must not hold the task past ECS's stop timeout.
export const shutdownTelemetry = async (timeoutMs = 5000) => {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      console.error(`Telemetry flush did not finish in ${timeoutMs}ms; exiting without it`)
      resolve()
    }, timeoutMs)
  })
  const flush = Promise.all([otelSDK.shutdown(), logProvider.shutdown()]).then(
    () => console.log('SDK and Logger shut down successfully'),
    (err) => console.error('Error during telemetry shutdown', err),
  )
  await Promise.race([flush, timeout])
  clearTimeout(timer)
}
