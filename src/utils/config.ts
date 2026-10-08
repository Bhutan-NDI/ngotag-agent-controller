/* eslint-disable no-console */
export const isCustomDocumentLoaderEnabled = (): boolean => {
  const flag = process.env.ENABLE_CUSTOM_DOCUMENT_LOADER ?? 'false'
  const isCustomDocumentLoaderEnabled = flag.toLowerCase() === 'true'

  if (isCustomDocumentLoaderEnabled) {
    if (!process.env.DEPRECATED_DOMAIN || !process.env.CURRENT_DOMAIN) {
      console.debug('Invalid configuration set for enabling custom document loader')
      console.info(
        "If you are unsure about what the error is about. Try setting the 'ENABLE_CUSTOM_DOCUMENT_LOADER' flag in the env variable to false",
      )
      throw new Error(
        `Custom document loader for the agent is enabled but the deprecated domain and updated domain is not set`,
      )
    }
    console.warn(
      `Custom document loader for the agent is enabled. Resolution of all URLs from the deprecated domain(${process.env.DEPRECATED_DOMAIN}) will actually be resolved from the current, updated domain(${process.env.CURRENT_DOMAIN})`,
    )
  }

  return isCustomDocumentLoaderEnabled
}

// An empty key leaves dynamicApiKey '', which makes POST /agent/token unreachable.
export const validateApiKey = (input: string | undefined | null): string => {
  const apiKey = input?.trim()
  if (!apiKey) {
    throw new Error('API key is required: set API_KEY to at least 16 characters')
  }
  if (apiKey.length < 16) {
    throw new Error('API key must be at least 16 characters long')
  }
  return apiKey
}

// A factory, not a const: the default has to read process.env at call time.
export const apiKeyOptionDefinition = () => ({
  string: true,
  default: process.env.API_KEY,
  // yargs prints an option's default in its generated help, which it emits on any parse failure.
  defaultDescription: '(from API_KEY)',
  coerce: validateApiKey,
})
