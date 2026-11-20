/**
 * Puts a failed request's network error code (ECONNREFUSED, ENOTFOUND, ...) into the error message. Node's fetch hides
 * it on `error.cause` and reports only "fetch failed", and Credo keeps nothing but the message when a send fails, so
 * without this a caller cannot tell "the request never left" from "it may have arrived".
 */
export const withNetworkErrorCodes =
  (fetchImpl: typeof fetch): typeof fetch =>
  async (...args) => {
    try {
      return await fetchImpl(...args)
    } catch (error) {
      const { cause, message } = (error ?? {}) as { cause?: { code?: unknown }; message?: unknown }
      const code = cause?.code
      // Not `instanceof Error`: the error may come from another realm (it does under Jest's VM).
      if ('string' === typeof code && 'string' === typeof message && !message.includes(code)) {
        ;(error as { message: string }).message = `${message} (${code})`
      }
      throw error
    }
  }
