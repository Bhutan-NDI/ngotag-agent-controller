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
