/**
 * Mount the log collection router on Connection's shared `/api` RPC channel.
 *
 * Matches the capability center: one exact browser bridge forwards the logical
 * path, method, query and body to the same router used by tests.
 *
 * @module @agentops/dsh-log-collection/mount-rpc
 */

import type { Context } from '@deepseek-ai/cordis'
import type {
  ConnectionRpcHandler,
  ConnectionRpcHandlerResult,
} from '@deepseek-ai/dsh-client-connection'

import type { LogCollectionHttpApi, LogCollectionHttpResponse } from './http.ts'

/** Shared channel owned by Connection. */
export const RPC_CHANNEL = '/api'

/** Endpoint prefix below `/api` owned by this surface. */
export const LOG_COLLECTION_ENDPOINT_PREFIX = 'agentops/log-collection'

/** Exact browser route that forwards one payload to the same router. */
export const LOG_COLLECTION_BRIDGE_PATH = '/api/agentops/log-collection-rpc'

/** Payload accepted by the browser bridge. */
export interface LogCollectionRpcPayload {
  readonly method?: unknown
  readonly query?: unknown
  readonly body?: unknown
}

/**
 * Translate an RPC endpoint into the log collection router path.
 * @param endpoint - endpoint below `/api`, without a leading slash.
 * @returns the router path, or undefined when the endpoint belongs elsewhere.
 */
export function decodeLogCollectionEndpoint(endpoint: string): string | undefined {
  if (endpoint !== LOG_COLLECTION_ENDPOINT_PREFIX && !endpoint.startsWith(`${LOG_COLLECTION_ENDPOINT_PREFIX}/`)) return undefined
  return `/api/${endpoint}`
}

function toRpcResult(response: LogCollectionHttpResponse): ConnectionRpcHandlerResult {
  if (response.status < 400) return { ok: true, value: response.body }
  const body = response.body as { error?: { code?: string; message?: string; details?: object } }
  return {
    ok: false,
    error: {
      code: body.error?.code ?? 'internal_error',
      message: body.error?.message ?? 'log collection request failed',
      details: body.error?.details ?? {},
    },
  }
}

/**
 * Dispatch one log collection RPC call.
 * @param api - transport-neutral router.
 * @param endpoint - endpoint below `/api`.
 * @param payload - method, query and body from the caller.
 * @param owner - whether the transport authenticated an owner peer.
 * @returns the RPC result envelope.
 */
export async function handleLogCollectionRpc(
  api: LogCollectionHttpApi,
  endpoint: string,
  payload: unknown,
  owner: boolean,
): Promise<ConnectionRpcHandlerResult> {
  const path = decodeLogCollectionEndpoint(endpoint)
  if (path === undefined) return { ok: false, error: { code: 'not_found', message: `unknown endpoint ${endpoint}`, details: {} } }
  if (!owner) return { ok: false, error: { code: 'forbidden', message: 'log collection surface is owner-only', details: {} } }
  const envelope = (typeof payload === 'object' && payload !== null ? payload : {}) as LogCollectionRpcPayload
  const query: Record<string, string> = {}
  if (typeof envelope.query === 'object' && envelope.query !== null) {
    for (const [key, value] of Object.entries(envelope.query)) {
      if (typeof value === 'string') query[key] = value
    }
  }
  return api.handle({
    method: typeof envelope.method === 'string' ? envelope.method : 'POST',
    path,
    query,
    body: envelope.body,
    actor: 'owner',
  }).then(toRpcResult)
}

/**
 * Register the log collection surface and its browser bridge.
 * @param ctx - context carrying Connection.
 * @param api - router over the same store the tools read.
 */
export function registerLogCollectionRpc(ctx: Context, api: LogCollectionHttpApi): void {
  const handler: ConnectionRpcHandler = async (endpoint, payload, _signal, peer) =>
    await handleLogCollectionRpc(api, endpoint, payload, (peer.principal as { kind?: string }).kind === 'owner')
  ctx.effect(
    () => ctx.connection.rpc.intercept(RPC_CHANNEL, endpoint => decodeLogCollectionEndpoint(endpoint) !== undefined, handler),
    'agentops-log-collection: shared /api RPC surface',
  )
  registerLogCollectionRpcBridge(ctx, api)
}

/**
 * Register the browser bridge used by the log collection panel.
 * @param ctx - context carrying Connection.
 * @param api - same router used by the shared RPC channel.
 */
export function registerLogCollectionRpcBridge(ctx: Context, api: LogCollectionHttpApi): void {
  ctx.effect(() => ctx.connection.fetch.register({
    path: LOG_COLLECTION_BRIDGE_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      let envelope: unknown
      try {
        envelope = await request.json()
      } catch {
        return jsonResponse({ ok: false, error: { code: 'invalid_request', message: 'body is not JSON', details: {} } })
      }
      const source = (typeof envelope === 'object' && envelope !== null ? envelope : {}) as {
        endpoint?: unknown
        method?: unknown
        query?: unknown
        body?: unknown
      }
      const endpoint = typeof source.endpoint === 'string' ? source.endpoint : ''
      return jsonResponse(await handleLogCollectionRpc(api, endpoint, {
        method: source.method,
        query: source.query,
        body: source.body,
      }, true))
    },
  }), 'agentops-log-collection: browser RPC bridge')
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}
