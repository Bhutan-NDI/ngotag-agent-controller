/** Shared by the logger specs. Not a spec itself: jest only collects *.spec / *.test files. */

export type EmittedRecord = { body: unknown; attributes: Record<string, unknown> }

/** Module shape for `jest.unstable_mockModule('../../tracer', ...)`; records every OTEL emit. */
export function tracerMock(emitted: EmittedRecord[] = []) {
  return {
    otelLogger: {
      emit: (record: EmittedRecord) => {
        emitted.push(record)
      },
    },
    otelLoggerProviderInstance: {},
    otelSDK: {},
  }
}

/** tslog writes debug/info to stdout and warn/error to stderr; capture both. */
export function captureOutput(run: () => void): string {
  const stdout = process.stdout.write.bind(process.stdout)
  const stderr = process.stderr.write.bind(process.stderr)
  let captured = ''
  const sink = ((chunk: string | Uint8Array): boolean => {
    captured += String(chunk)
    return true
  }) as typeof process.stdout.write
  process.stdout.write = sink
  process.stderr.write = sink
  try {
    run()
  } finally {
    process.stdout.write = stdout
    process.stderr.write = stderr
  }
  return captured
}
