/**
 * Browser API for the log collection control plane.
 *
 * The panel talks to the same exact bridge the capability center uses, with its
 * own endpoint prefix so the two surfaces stay independent.
 *
 * @module @agentops/dsh-ui-capability/client
 */

/** One log collection result envelope. */
export type LogCollectionRpcResult<T = unknown> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string; readonly details: object } }

/** Transport function; tests inject a fake instead of using the bridge. */
export type LogCollectionRpcCall = (
  endpoint: string,
  method: string,
  payload: { readonly query?: Readonly<Record<string, string>>; readonly body?: unknown },
  signal?: AbortSignal,
) => Promise<LogCollectionRpcResult>

const BRIDGE = '/api/agentops/log-collection-rpc'
const PREFIX = 'agentops/log-collection'

/** Post one envelope to the log collection browser bridge. */
export async function postLogCollectionRpc(
  endpoint: string,
  method: string,
  payload: { readonly query?: Readonly<Record<string, string>>; readonly body?: unknown },
  signal?: AbortSignal,
): Promise<LogCollectionRpcResult> {
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
  return await response.json() as LogCollectionRpcResult
}

/** Browser client backed by the log collection router. */
export function createLogCollectionApi(call: LogCollectionRpcCall = postLogCollectionRpc) {
  return {
    list(signal?: AbortSignal) {
      return call(`${PREFIX}/tasks`, 'GET', {}, signal)
    },
    create(body: unknown, signal?: AbortSignal) {
      return call(`${PREFIX}/tasks`, 'POST', { body }, signal)
    },
    update(taskId: string, body: unknown, signal?: AbortSignal) {
      return call(`${PREFIX}/tasks/${encodeURIComponent(taskId)}`, 'PATCH', { body }, signal)
    },
    remove(taskId: string, signal?: AbortSignal) {
      return call(`${PREFIX}/tasks/${encodeURIComponent(taskId)}`, 'DELETE', {}, signal)
    },
    listAcl(taskId: string, signal?: AbortSignal) {
      return call(`${PREFIX}/tasks/${encodeURIComponent(taskId)}/acl`, 'GET', {}, signal)
    },
    grantAcl(taskId: string, body: unknown, signal?: AbortSignal) {
      return call(`${PREFIX}/tasks/${encodeURIComponent(taskId)}/acl`, 'PUT', { body }, signal)
    },
    revokeAcl(taskId: string, agentPreset: string, signal?: AbortSignal) {
      return call(`${PREFIX}/tasks/${encodeURIComponent(taskId)}/acl/${encodeURIComponent(agentPreset)}`, 'DELETE', {}, signal)
    },
    runNow(taskId: string, signal?: AbortSignal) {
      return call(`${PREFIX}/tasks/${encodeURIComponent(taskId)}/run`, 'POST', {}, signal)
    },
    listRuns(taskId?: string, signal?: AbortSignal) {
      return call(
        `${PREFIX}/runs`,
        'GET',
        taskId === undefined || taskId.trim() === '' ? {} : { query: { task_id: taskId.trim() } },
        signal,
      )
    },
  }
}
