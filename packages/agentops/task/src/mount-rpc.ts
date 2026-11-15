/**
 * Mount the task HTTP surface on Connection's shared `/api` RPC channel.
 *
 * `connection.fetch` only accepts exact paths and `GET`/`HEAD`/`POST`, while the
 * task contract has `{task_id}` segments and `PATCH`. This adapter keeps the
 * contract intact: the physical request is an authenticated RPC envelope, and
 * the endpoint plus payload carry the method, query and body that
 * {@link TaskHttpApi.handle} expects.
 *
 * Only owner peers are admitted; every other principal gets `forbidden`, so the
 * acting user is the one the transport authenticated, never a request field.
 *
 * @module @agentops/dsh-task/mount-rpc
 */

import type { Context } from '@deepseek-ai/cordis'
import type {
  ConnectionRpcHandler,
  ConnectionRpcHandlerResult,
} from '@deepseek-ai/dsh-client-connection'

import type { TaskHttpApi, TaskHttpResponse } from './http.ts'
import type { Actor } from './service.ts'

/** Shared channel owned by Connection. */
export const RPC_CHANNEL = '/api'

/** Endpoint prefix (below `/api`) owned by the task surface. */
export const TASK_ENDPOINT_PREFIX = 'agentops/tasks'

/** Candidate admission endpoint prefix (below `/api`). */
export const CANDIDATE_ENDPOINT_PREFIX = 'agentops/candidates'

/** Decision memory endpoint prefix (below `/api`). */
export const DECISION_ENDPOINT_PREFIX = 'agentops/decisions'

/** Payload shape accepted by the task adapter. */
export interface TaskRpcPayload {
  readonly method?: unknown
  readonly query?: unknown
  readonly body?: unknown
}

/**
 * Translate an RPC endpoint into the router path.
 * @param endpoint - endpoint below `/api`, without a leading slash.
 * @returns the router path, or undefined when the endpoint belongs elsewhere.
 */
export function decodeTaskEndpoint(endpoint: string): string | undefined {
  const owned = [TASK_ENDPOINT_PREFIX, CANDIDATE_ENDPOINT_PREFIX, DECISION_ENDPOINT_PREFIX].some(prefix =>
    endpoint === prefix || endpoint.startsWith(`${prefix}/`))
  if (!owned) return undefined
  return `/${RPC_CHANNEL.slice(1)}/${endpoint}`
}

/**
 * Convert a router response into an RPC result.
 * @param response - router status and body.
 * @returns the RPC result envelope.
 */
function toRpcResult(response: TaskHttpResponse): ConnectionRpcHandlerResult {
  if (response.status < 400) return { ok: true, value: response.body }
  const body = response.body as { error?: { code?: string; message?: string; details?: object } }
  return {
    ok: false,
    error: {
      code: body.error?.code ?? 'internal_error',
      message: body.error?.message ?? 'task request failed',
      details: body.error?.details ?? {},
    },
  }
}

/**
 * Dispatch one task RPC call.
 * @param api - transport-agnostic task router.
 * @param endpoint - endpoint below `/api`.
 * @param payload - method, query and body supplied by the caller.
 * @param owner - whether the transport authenticated an owner peer.
 * @returns the RPC result envelope.
 */
export function handleTaskRpc(
  api: TaskHttpApi,
  endpoint: string,
  payload: unknown,
  owner: boolean,
): ConnectionRpcHandlerResult {
  const path = decodeTaskEndpoint(endpoint)
  if (path === undefined) {
    return { ok: false, error: { code: 'not_found', message: `unknown endpoint ${endpoint}`, details: {} } }
  }
  if (!owner) {
    return { ok: false, error: { code: 'forbidden', message: 'task surface is owner-only', details: {} } }
  }
  const envelope = (typeof payload === 'object' && payload !== null ? payload : {}) as TaskRpcPayload
  const method = typeof envelope.method === 'string' ? envelope.method : 'POST'
  const query: Record<string, string> = {}
  if (typeof envelope.query === 'object' && envelope.query !== null && !Array.isArray(envelope.query)) {
    for (const [key, value] of Object.entries(envelope.query)) {
      if (typeof value === 'string') query[key] = value
    }
  }
  const actor: Actor = { type: 'user', name: 'owner' }
  return toRpcResult(api.handle({ method, path, query, body: envelope.body, actor }))
}

/**
 * Register the task surface on the shared RPC channel.
 * @param ctx - Cordis context carrying `connection` in a Host profile.
 * @param api - task router over the same service the tools use.
 */
export function registerTaskRpc(ctx: Context, api: TaskHttpApi): void {
  const handler: ConnectionRpcHandler = (endpoint, payload, _signal, peer) =>
    Promise.resolve(handleTaskRpc(api, endpoint, payload, peer.principal.kind === 'owner'))
  ctx.effect(
    () => ctx.connection.rpc.intercept(RPC_CHANNEL, endpoint => decodeTaskEndpoint(endpoint) !== undefined, handler),
    'agentops-task: shared /api RPC surface',
  )
  registerTaskRpcBridge(ctx, api)
}

/** Exact browser route that forwards one payload to the same router. */
export const TASK_BRIDGE_PATH = '/api/agentops/task-rpc'

/**
 * Register the browser bridge: a single exact `POST` route the panels can call
 * with plain `fetch`, carrying `{ endpoint, method, query, body }`.
 *
 * Exact Fetch routes are owner-only by construction, so the bridge admits the
 * same caller as the RPC channel without re-checking the principal.
 * @param ctx - Cordis context carrying `connection` in a Web profile.
 * @param api - task router over the same service the tools use.
 */
export function registerTaskRpcBridge(ctx: Context, api: TaskHttpApi): void {
  ctx.effect(() => ctx.connection.fetch.register({
    path: TASK_BRIDGE_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      let envelope: unknown
      try {
        envelope = await request.json()
      } catch {
        return jsonResponse({ ok: false, error: { code: 'invalid_request', message: 'body is not JSON', details: {} } })
      }
      const source = (typeof envelope === 'object' && envelope !== null ? envelope : {}) as
        | { endpoint?: unknown; method?: unknown; query?: unknown; body?: unknown }
        | undefined
      const endpoint = typeof source?.endpoint === 'string' ? source.endpoint : ''
      return jsonResponse(handleTaskRpc(api, endpoint, {
        method: source?.method,
        query: source?.query,
        body: source?.body,
      }, true))
    },
  }), 'agentops-task: browser RPC bridge')
}

/**
 * @param body - RPC result envelope.
 * @returns JSON response carrying the same envelope.
 */
function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}
