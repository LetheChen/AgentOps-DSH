/**
 * Mount the capability router on Connection's shared `/api` RPC channel.
 *
 * The browser bridge is one exact `POST` route that forwards the logical
 * capability path, method, query and body to the same router used by tests.
 *
 * @module @agentops/dsh-capability/mount-rpc
 */

import type { Context } from '@deepseek-ai/cordis'
import type {
  ConnectionRpcHandler,
  ConnectionRpcHandlerResult,
} from '@deepseek-ai/dsh-client-connection'

import type { CapabilityHttpApi, CapabilityHttpResponse } from './http.ts'

/** Shared channel owned by Connection. */
export const RPC_CHANNEL = '/api'

/** Endpoint prefix below `/api` owned by this surface. */
export const CAPABILITY_ENDPOINT_PREFIX = 'agentops/capabilities'

/** Exact browser route that forwards one payload to the same router. */
export const CAPABILITY_BRIDGE_PATH = '/api/agentops/capability-rpc'

/** Payload accepted by the browser bridge. */
export interface CapabilityRpcPayload {
  readonly method?: unknown
  readonly query?: unknown
  readonly body?: unknown
}

/**
 * Translate an RPC endpoint into the capability router path.
 * @param endpoint - endpoint below `/api`, without a leading slash.
 * @returns the router path, or undefined when the endpoint belongs elsewhere.
 */
export function decodeCapabilityEndpoint(endpoint: string): string | undefined {
  if (endpoint !== CAPABILITY_ENDPOINT_PREFIX && !endpoint.startsWith(`${CAPABILITY_ENDPOINT_PREFIX}/`)) return undefined
  return `/api/${endpoint}`
}

function toRpcResult(response: CapabilityHttpResponse): ConnectionRpcHandlerResult {
  if (response.status < 400) return { ok: true, value: response.body }
  const body = response.body as { error?: { code?: string; message?: string; details?: object } }
  return {
    ok: false,
    error: {
      code: body.error?.code ?? 'internal_error',
      message: body.error?.message ?? 'capability request failed',
      details: body.error?.details ?? {},
    },
  }
}

/**
 * Dispatch one capability RPC call.
 * @param api - transport-neutral capability router.
 * @param endpoint - endpoint below `/api`.
 * @param payload - method, query and body from the caller.
 * @param owner - whether the transport authenticated an owner peer.
 * @returns the RPC result envelope.
 */
export async function handleCapabilityRpc(
  api: CapabilityHttpApi,
  endpoint: string,
  payload: unknown,
  owner: boolean,
): Promise<ConnectionRpcHandlerResult> {
  const path = decodeCapabilityEndpoint(endpoint)
  if (path === undefined) return { ok: false, error: { code: 'not_found', message: `unknown endpoint ${endpoint}`, details: {} } }
  if (!owner) return { ok: false, error: { code: 'forbidden', message: 'capability surface is owner-only', details: {} } }
  const envelope = (typeof payload === 'object' && payload !== null ? payload : {}) as CapabilityRpcPayload
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
 * Register the capability surface on the shared RPC channel and its browser bridge.
 * @param ctx - context carrying Connection.
 * @param api - router over the same store the resolver uses.
 */
export function registerCapabilityRpc(ctx: Context, api: CapabilityHttpApi): void {
  const handler: ConnectionRpcHandler = async (endpoint, payload, _signal, peer) =>
    await handleCapabilityRpc(api, endpoint, payload, (peer.principal as { kind?: string }).kind === 'owner')
  ctx.effect(
    () => ctx.connection.rpc.intercept(RPC_CHANNEL, endpoint => decodeCapabilityEndpoint(endpoint) !== undefined, handler),
    'agentops-capability: shared /api RPC surface',
  )
  registerCapabilityRpcBridge(ctx, api)
}

/**
 * Register the browser bridge used by the capability panel.
 * @param ctx - context carrying Connection.
 * @param api - same router used by the shared RPC channel.
 */
export function registerCapabilityRpcBridge(ctx: Context, api: CapabilityHttpApi): void {
  ctx.effect(() => ctx.connection.fetch.register({
    path: CAPABILITY_BRIDGE_PATH,
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
      return jsonResponse(await handleCapabilityRpc(api, endpoint, {
        method: source.method,
        query: source.query,
        body: source.body,
      }, true))
    },
  }), 'agentops-capability: browser RPC bridge')
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}
