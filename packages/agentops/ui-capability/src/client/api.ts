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

/**
 * Post one envelope to the exact browser bridge.
 * @param endpoint - the capability router endpoint to invoke.
 * @param method - the HTTP method the router applies.
 * @param payload - the query and body fields to send with the request.
 * @param signal - the abort signal for the request.
 * @returns the result envelope the bridge reported.
 */
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

/** Capability-center operations the panel calls over the capability router. */
export interface CapabilityApi {
  /**
   * List the capability catalog.
   * @param signal - the abort signal for the request.
   * @returns the result envelope from the capability router.
   */
  listCatalog(signal?: AbortSignal): Promise<CapabilityRpcResult>
  /**
   * List the connector instances.
   * @param signal - the abort signal for the request.
   * @returns the result envelope from the capability router.
   */
  listIntegrations(signal?: AbortSignal): Promise<CapabilityRpcResult>
  /**
   * List the tools and interfaces, optionally narrowed to one capability.
   * @param capabilityId - the capability to filter by; every capability when absent.
   * @param signal - the abort signal for the request.
   * @returns the result envelope from the capability router.
   */
  listTools(capabilityId?: string, signal?: AbortSignal): Promise<CapabilityRpcResult>
  /**
   * Create a connector instance.
   * @param body - the instance configuration to store.
   * @param signal - the abort signal for the request.
   * @returns the result envelope from the capability router.
   */
  createIntegration(body: unknown, signal?: AbortSignal): Promise<CapabilityRpcResult>
  /**
   * Update a connector instance.
   * @param instanceId - the instance to update.
   * @param body - the instance configuration to store.
   * @param signal - the abort signal for the request.
   * @returns the result envelope from the capability router.
   */
  updateIntegration(instanceId: string, body: unknown, signal?: AbortSignal): Promise<CapabilityRpcResult>
  /**
   * Delete a connector instance.
   * @param instanceId - the instance to delete.
   * @param signal - the abort signal for the request.
   * @returns the result envelope from the capability router.
   */
  deleteIntegration(instanceId: string, signal?: AbortSignal): Promise<CapabilityRpcResult>
  /**
   * List the tables a database instance exposes.
   * @param instanceId - the instance to read from.
   * @param signal - the abort signal for the request.
   * @returns the result envelope from the capability router.
   */
  listInstanceTables(instanceId: string, signal?: AbortSignal): Promise<CapabilityRpcResult>
  /**
   * Read the host key fingerprint of an SSH server.
   * @param host - the server hostname or address.
   * @param port - the server SSH port.
   * @param signal - the abort signal for the request.
   * @returns the result envelope from the capability router.
   */
  probeSshHostKey(host: string, port: number, signal?: AbortSignal): Promise<CapabilityRpcResult>
  /**
   * Run the connectivity test of a connector instance.
   * @param instanceId - the instance to test.
   * @param signal - the abort signal for the request.
   * @returns the result envelope from the capability router.
   */
  testIntegration(instanceId: string, signal?: AbortSignal): Promise<CapabilityRpcResult>
  /**
   * List the instances an Agent preset may use.
   * @param agentPreset - the Agent preset to read the bindings of.
   * @param signal - the abort signal for the request.
   * @returns the result envelope from the capability router.
   */
  listBindings(agentPreset: string, signal?: AbortSignal): Promise<CapabilityRpcResult>
  /**
   * Replace the instance bindings of an Agent preset.
   * @param body - the bindings to store.
   * @param signal - the abort signal for the request.
   * @returns the result envelope from the capability router.
   */
  replaceBindings(body: unknown, signal?: AbortSignal): Promise<CapabilityRpcResult>
  /**
   * List the control-plane audit records.
   * @param signal - the abort signal for the request.
   * @returns the result envelope from the capability router.
   */
  listAudit(signal?: AbortSignal): Promise<CapabilityRpcResult>
}

/**
 * Build the browser client for the capability router.
 * @param call - the transport that reaches the capability router.
 * @returns the capability API bound to that transport.
 */
export function createCapabilityApi(call: CapabilityRpcCall = postCapabilityRpc): CapabilityApi {
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
