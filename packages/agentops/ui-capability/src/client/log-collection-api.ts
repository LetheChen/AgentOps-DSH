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

/**
 * Post one envelope to the log collection browser bridge.
 * @param endpoint - the log collection router endpoint to invoke.
 * @param method - the HTTP method the router applies.
 * @param payload - the query and body fields to send with the request.
 * @param signal - the abort signal for the request.
 * @returns the result envelope the bridge reported.
 */
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

/** Log collection operations the panel calls over the log collection router. */
export interface LogCollectionApi {
  /**
   * List the collection tasks.
   * @param signal - the abort signal for the request.
   * @returns the result envelope from the log collection router.
   */
  list(signal?: AbortSignal): Promise<LogCollectionRpcResult>
  /**
   * Create a collection task.
   * @param body - the task definition to store.
   * @param signal - the abort signal for the request.
   * @returns the result envelope from the log collection router.
   */
  create(body: unknown, signal?: AbortSignal): Promise<LogCollectionRpcResult>
  /**
   * Update a collection task.
   * @param taskId - the task to update.
   * @param body - the task definition to store.
   * @param signal - the abort signal for the request.
   * @returns the result envelope from the log collection router.
   */
  update(taskId: string, body: unknown, signal?: AbortSignal): Promise<LogCollectionRpcResult>
  /**
   * Delete a collection task.
   * @param taskId - the task to delete.
   * @param signal - the abort signal for the request.
   * @returns the result envelope from the log collection router.
   */
  remove(taskId: string, signal?: AbortSignal): Promise<LogCollectionRpcResult>
  /**
   * List the Agent presets allowed to read a task.
   * @param taskId - the task to read the access list of.
   * @param signal - the abort signal for the request.
   * @returns the result envelope from the log collection router.
   */
  listAcl(taskId: string, signal?: AbortSignal): Promise<LogCollectionRpcResult>
  /**
   * Replace the access list of a task.
   * @param taskId - the task to authorize.
   * @param body - the access list to store.
   * @param signal - the abort signal for the request.
   * @returns the result envelope from the log collection router.
   */
  grantAcl(taskId: string, body: unknown, signal?: AbortSignal): Promise<LogCollectionRpcResult>
  /**
   * Remove one Agent preset from the access list of a task.
   * @param taskId - the task to revoke access to.
   * @param agentPreset - the Agent preset to remove.
   * @param signal - the abort signal for the request.
   * @returns the result envelope from the log collection router.
   */
  revokeAcl(taskId: string, agentPreset: string, signal?: AbortSignal): Promise<LogCollectionRpcResult>
  /**
   * Run a collection task now.
   * @param taskId - the task to run.
   * @param signal - the abort signal for the request.
   * @returns the result envelope from the log collection router.
   */
  runNow(taskId: string, signal?: AbortSignal): Promise<LogCollectionRpcResult>
  /**
   * List the recorded collection runs.
   * @param taskId - the task to filter by; every task when absent.
   * @param signal - the abort signal for the request.
   * @returns the result envelope from the log collection router.
   */
  listRuns(taskId?: string, signal?: AbortSignal): Promise<LogCollectionRpcResult>
}

/**
 * Build the browser client for the log collection router.
 * @param call - the transport that reaches the log collection router.
 * @returns the log collection API bound to that transport.
 */
export function createLogCollectionApi(call: LogCollectionRpcCall = postLogCollectionRpc): LogCollectionApi {
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
