import { AsyncLocalStorage } from 'async_hooks'

export interface RequestContext {
  jweFp: string
}

// Carries the JWE fingerprint (`iv`) extracted at HTTP inbound through Credo's
// async processing chain to event handlers and the session acquire wrapper.
export const requestContext = new AsyncLocalStorage<RequestContext>()
