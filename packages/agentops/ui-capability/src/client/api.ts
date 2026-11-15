/**
 * Browser API for the capability center over the exact capability RPC bridge.
 *
 * @module @agentops/dsh-ui-capability/client
 */

/** One capability result envelope. */
export type CapabilityRpcResult<T = unknown> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string; readonly details: object } }

/** Transport function; tests inject a fake instead of using the bridge. */
export type CapabilityRpcCall = (
  endpoint: string,
  method: string,
  payload: { readonly query?: Readonly<Record<string, string>>; readonly body?: unknown },
  signal?: AbortSignal,
) => Promise<CapabilityRpcResult>

const BRIDGE = '/api/agentops/capability-rpc'
const PREFIX = 'agentops/capabilities'

/** Post one envelope to the exact browser bridge. */
export async function postCapabilityRpc(
  endpoint: string,
  method: string,
  payload: { readonly query?: Readonly<Record<string, string>>; readonly body?: unknown },
  signal?: AbortSignal,
): Promise<CapabilityRpcResult> {
  const response = await fetch(BRIDGE, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ endpoint, method, ...payload }),
    ...(signal === undefined ? {} : { signal }),
  })
  if (!response.ok) {
    return { ok: false, error: { code: `http_${response.status}`, message: response.statusText, details: {} } }
  }
  return await response.json() as CapabilityRpcResult
}

/** Browser client backed by the capability router. */
export function createCapabilityApi(call: CapabilityRpcCall = postCapabilityRpc) {
  return {
    listCatalog(signal?: AbortSignal) {
      return call(`${PREFIX}/catalog`, 'GET', {}, signal)
    },
    listIntegrations(signal?: AbortSignal) {
      return call(`${PREFIX}/integrations`, 'GET', {}, signal)
    },
    listTools(capabilityId?: string, signal?: AbortSignal) {
      return call(
        `${PREFIX}/tools`,
        'GET',
        capabilityId === undefined || capabilityId.trim() === ''
          ? {}
          : { query: { capability_id: capabilityId.trim() } },
        signal,
      )
    },
    createIntegration(body: unknown, signal?: AbortSignal) {
      return call(`${PREFIX}/integrations`, 'POST', { body }, signal)
    },
    updateIntegration(instanceId: string, body: unknown, signal?: AbortSignal) {
      return call(`${PREFIX}/integrations/${encodeURIComponent(instanceId)}`, 'PATCH', { body }, signal)
    },
    deleteIntegration(instanceId: string, signal?: AbortSignal) {
      return call(`${PREFIX}/integrations/${encodeURIComponent(instanceId)}`, 'DELETE', {}, signal)
    },
    listInstanceTables(instanceId: string, signal?: AbortSignal) {
      return call(`${PREFIX}/integrations/${encodeURIComponent(instanceId)}/tables`, 'POST', {}, signal)
    },
    probeSshHostKey(host: string, port: number, signal?: AbortSignal) {
      return call(`${PREFIX}/ssh/host-key`, 'POST', { body: { host, port } }, signal)
    },
    testIntegration(instanceId: string, signal?: AbortSignal) {
      return call(`${PREFIX}/integrations/${encodeURIComponent(instanceId)}/test`, 'POST', {}, signal)
    },
    listBindings(agentPreset: string, signal?: AbortSignal) {
      return call(`${PREFIX}/bindings`, 'GET', { query: { agent_preset: agentPreset } }, signal)
    },
    replaceBindings(body: unknown, signal?: AbortSignal) {
      return call(`${PREFIX}/bindings`, 'PUT', { body }, signal)
    },
    listAudit(signal?: AbortSignal) {
      return call(`${PREFIX}/audit`, 'GET', {}, signal)
    },
  }
}
