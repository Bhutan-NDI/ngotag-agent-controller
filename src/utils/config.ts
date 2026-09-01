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

// Unset or empty leaves dynamicApiKey '', making POST /agent/token - the only route that can mint a
// token - permanently unreachable on an agent that otherwise boots clean. Fail at boot instead.
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
