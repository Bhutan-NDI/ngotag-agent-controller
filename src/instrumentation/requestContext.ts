import { AsyncLocalStorage } from 'async_hooks'

export interface RequestContext {
  outerMsgId: string
}

// Carries per-request context (outer_msg_id extracted at HTTP inbound)
// through Credo's async processing chain to the event handlers.
export const requestContext = new AsyncLocalStorage<RequestContext>()
