export const silentLogger = (): never =>
  ({
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
    trace: () => undefined,
  }) as never

export const eventually = async (check: () => boolean | Promise<boolean>, timeoutMs = 3000): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('condition not met in time')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

// A lease that is always granted, for tests that stand in for a single task.
export const grantingLease = { acquire: async () => true, release: async () => undefined }
