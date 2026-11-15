/**
 * Browser-side task API over the shared `/api` RPC channel.
 *
 * The task surface is mounted by `@agentops/dsh-task/mount-rpc`: the physical
 * request is an authenticated RPC envelope, and the payload carries the HTTP
 * method, query and body that the host router expects. Panels call this module
 * instead of `fetch` so the `/api` method allowlist never constrains them.
 *
 * @module @agentops/dsh-client/task-rpc-api
 */



/** Endpoint prefix owned by the task surface, below `/api`. */
const TASKS = 'agentops/tasks'

/** Candidate admission endpoint prefix. */
const CANDIDATES = 'agentops/candidates'

/** Decision memory endpoint prefix. */
const DECISIONS = 'agentops/decisions'

/** One task RPC payload. */
export interface TaskRpcPayload {
  readonly method: string
  readonly query?: Readonly<Record<string, string>>
  readonly body?: unknown
}

/** Transport function; injectable so tests do not need a live connection. */
export type TaskRpcCall = (
  endpoint: string,
  payload: TaskRpcPayload,
  signal?: AbortSignal,
) => Promise<TaskRpcResult>

/** Failure carried by a rejected task RPC call. */
export interface TaskRpcFailure {
  readonly code: string
  readonly message: string
  readonly details: object
}

/** Result of one task RPC call. */
export type TaskRpcResult<T = unknown> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: TaskRpcFailure }

/** Exact browser route that forwards one payload to the task router. */
const BRIDGE_PATH = '/api/agentops/task-rpc'

/**
 * Post one task payload through the browser bridge.
 * @param endpoint - endpoint below `/api`.
 * @param payload - method, query and body.
 * @param signal - cancellation.
 * @returns the RPC result envelope.
 */
export async function postTaskRpc(
  endpoint: string,
  payload: TaskRpcPayload,
  signal?: AbortSignal,
): Promise<TaskRpcResult> {
  const response = await fetch(BRIDGE_PATH, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ endpoint, ...payload }),
    ...(signal === undefined ? {} : { signal }),
  })
  if (!response.ok) {
    return {
      ok: false,
      error: { code: `http_${response.status}`, message: response.statusText, details: {} },
    }
  }
  return await response.json() as TaskRpcResult
}

/**
 * Wrap a shared-channel caller so panels only name endpoints and payloads.
 * @param call - transport that posts one RPC envelope to `/api`.
 * @returns the task client used by the panels.
 */
export function createTaskRpcClient(call: TaskRpcCall = postTaskRpc): TaskRpcClient {
  const invoke: TaskRpcCall = call
  return {
    listTasks(query, signal) {
      return invoke(TASKS, query === undefined ? { method: 'GET' } : { method: 'GET', query }, signal)
    },
    createTask(body, signal) {
      return invoke(TASKS, { method: 'POST', body }, signal)
    },
    captureCandidate(body, signal) {
      return invoke(CANDIDATES, { method: 'POST', body }, signal)
    },
    analyzeCandidate(candidateId, body, signal) {
      return invoke(`${CANDIDATES}/${candidateId}/analyze`, { method: 'POST', body }, signal)
    },
    preflightCandidate(candidateId, body, signal) {
      return invoke(`${CANDIDATES}/${candidateId}/preflight-search`, { method: 'POST', body }, signal)
    },
    gateCandidate(candidateId, body, signal) {
      return invoke(`${CANDIDATES}/${candidateId}/gate`, { method: 'POST', body }, signal)
    },
    getCandidate(candidateId, signal) {
      return invoke(`${CANDIDATES}/${candidateId}`, { method: 'GET' }, signal)
    },
    searchDecisions(query, signal) {
      return invoke(`${DECISIONS}/search`, { method: 'GET', query }, signal)
    },
    getDecision(decisionId, signal) {
      return invoke(`${DECISIONS}/${decisionId}`, { method: 'GET' }, signal)
    },
    searchTasks(query, signal) {
      return invoke(`${TASKS}/search`, { method: 'GET', query }, signal)
    },
    listRuns(taskId, signal) {
      return invoke(`${TASKS}/${taskId}/runs`, { method: 'GET' }, signal)
    },
    getTask(taskId, signal) {
      return invoke(`${TASKS}/${taskId}`, { method: 'GET' }, signal)
    },
    advanceTask(taskId, body, signal) {
      return invoke(`${TASKS}/${taskId}/advance`, { method: 'POST', body }, signal)
    },
    rollbackTask(taskId, body, signal) {
      return invoke(`${TASKS}/${taskId}/rollback`, { method: 'POST', body }, signal)
    },
    closeTask(taskId, body, signal) {
      return invoke(`${TASKS}/${taskId}/close`, { method: 'POST', body }, signal)
    },
    claimTask(taskId, body, signal) {
      return invoke(`${TASKS}/${taskId}/claim`, { method: 'POST', body }, signal)
    },
    executeTask(taskId, body, signal) {
      return invoke(`${TASKS}/${taskId}/execute`, { method: 'POST', body }, signal)
    },
    finishRun(taskId, runId, body, signal) {
      return invoke(`${TASKS}/${taskId}/runs/${runId}/finish`, { method: 'POST', body }, signal)
    },
    updateTask(taskId, body, signal) {
      return invoke(`${TASKS}/${taskId}`, { method: 'PATCH', body }, signal)
    },
    submitReport(taskId, body, signal) {
      return invoke(`${TASKS}/${taskId}/reports`, { method: 'POST', body }, signal)
    },
    listIdeas(query, signal) {
      return invoke(`${TASKS}/ideas`, query === undefined ? { method: 'GET' } : { method: 'GET', query }, signal)
    },
    captureIdea(body, signal) {
      return invoke(`${TASKS}/ideas`, { method: 'POST', body }, signal)
    },
    triageIdea(ideaId, body, signal) {
      return invoke(`${TASKS}/ideas/${ideaId}/triage`, { method: 'POST', body }, signal)
    },
    convertIdea(ideaId, signal) {
      return invoke(`${TASKS}/ideas/${ideaId}/convert`, { method: 'POST', body: {} }, signal)
    },
    listActivities(query, signal) {
      return invoke(`${TASKS}/activities`, query === undefined ? { method: 'GET' } : { method: 'GET', query }, signal)
    },
    listReports(taskId, signal) {
      return invoke(`${TASKS}/${taskId}/reports`, { method: 'GET' }, signal)
    },
    exportReport(taskId, reportId, signal) {
      return invoke(`${TASKS}/${taskId}/reports/${reportId}/export`, { method: 'POST', body: {} }, signal)
    },
    listProjects(signal) {
      return invoke(`${TASKS}/projects`, { method: 'GET' }, signal)
    },
    listWorkspaces(signal) {
      return invoke(`${TASKS}/workspaces`, { method: 'GET' }, signal)
    },
    getGraph(query, signal) {
      return invoke(`${TASKS}/graph`, query === undefined ? { method: 'GET' } : { method: 'GET', query }, signal)
    },
    getDashboard(query, signal) {
      return invoke(`${TASKS}/dashboard`, query === undefined ? { method: 'GET' } : { method: 'GET', query }, signal)
    },
    getTransitions(taskId, signal) {
      return invoke(`${TASKS}/${taskId}/transitions`, { method: 'GET' }, signal)
    },
    listRelations(taskId, signal) {
      return invoke(`${TASKS}/${taskId}/relations`, { method: 'GET' }, signal)
    },
    listArtifacts(taskId, signal) {
      return invoke(`${TASKS}/${taskId}/artifacts`, { method: 'GET' }, signal)
    },
    createProject(body, signal) {
      return invoke(`${TASKS}/projects`, { method: 'POST', body }, signal)
    },
    rebindProject(projectId, body, signal) {
      return invoke(`${TASKS}/projects/${projectId}/rebind`, { method: 'POST', body }, signal)
    },
    listComments(taskId, signal) {
      return invoke(`${TASKS}/${taskId}/comments`, { method: 'GET' }, signal)
    },
    addComment(taskId, body, signal) {
      return invoke(`${TASKS}/${taskId}/comments`, { method: 'POST', body }, signal)
    },
    listCriteria(taskId, signal) {
      return invoke(`${TASKS}/${taskId}/criteria`, { method: 'GET' }, signal)
    },
    addCriterion(taskId, body, signal) {
      return invoke(`${TASKS}/${taskId}/criteria`, { method: 'POST', body }, signal)
    },
    getReportDocument(taskId, reportId, signal) {
      return invoke(`${TASKS}/${taskId}/reports/${reportId}/export`, { method: 'GET' }, signal)
    },
    setCriterionStatus(taskId, criterionId, body, signal) {
      return invoke(`${TASKS}/${taskId}/criteria/${criterionId}/status`, { method: 'POST', body }, signal)
    },
    reviewReport(taskId, reportId, body, signal) {
      return invoke(`${TASKS}/${taskId}/reports/${reportId}/review`, { method: 'POST', body }, signal)
    },
  }
}

/** The endpoints the panels use. */
export interface TaskRpcClient {
  /** List tasks with optional `status`/`projectId` filters. */
  listTasks(query?: Readonly<Record<string, string>>, signal?: AbortSignal): Promise<TaskRpcResult>
  /** Create one task in a project. */
  createTask(body: unknown, signal?: AbortSignal): Promise<TaskRpcResult>
  /** Capture a Candidate; direct Task creation is intentionally unavailable. */
  captureCandidate(body: unknown, signal?: AbortSignal): Promise<TaskRpcResult>
  /** Advance Candidate analysis by one phase. */
  analyzeCandidate(candidateId: string, body: unknown, signal?: AbortSignal): Promise<TaskRpcResult>
  /** Record the immutable preflight search snapshot. */
  preflightCandidate(candidateId: string, body: unknown, signal?: AbortSignal): Promise<TaskRpcResult>
  /** Approve the Candidate gate as the authenticated user. */
  gateCandidate(candidateId: string, body: unknown, signal?: AbortSignal): Promise<TaskRpcResult>
  /** Read the current Candidate version and snapshot pointer. */
  getCandidate(candidateId: string, signal?: AbortSignal): Promise<TaskRpcResult>
  /** Search decision memories for a project and collection. */
  searchDecisions(query: Readonly<Record<string, string>>, signal?: AbortSignal): Promise<TaskRpcResult>
  /** Read one Decision with evidence, relations and audit. */
  getDecision(decisionId: string, signal?: AbortSignal): Promise<TaskRpcResult>
  /** Full-text task search scoped by the supplied query. */
  searchTasks(query: Readonly<Record<string, string>>, signal?: AbortSignal): Promise<TaskRpcResult>
  /** List a task's execution records. */
  listRuns(taskId: string, signal?: AbortSignal): Promise<TaskRpcResult>
  /** Read one task with its stages and events. */
  getTask(taskId: string, signal?: AbortSignal): Promise<TaskRpcResult>
  /** Advance one task; failures include `version_conflict` and `invalid_transition`. */
  advanceTask(taskId: string, body: unknown, signal?: AbortSignal): Promise<TaskRpcResult>
  /** Roll one task back to an allowed target status. */
  rollbackTask(taskId: string, body: unknown, signal?: AbortSignal): Promise<TaskRpcResult>
  /** Run the close gate and close a validating or closing task. */
  closeTask(taskId: string, body: unknown, signal?: AbortSignal): Promise<TaskRpcResult>
  /** Bind the task to a thread before execution. */
  claimTask(taskId: string, body: unknown, signal?: AbortSignal): Promise<TaskRpcResult>
  /** Start one execution binding; pass an idempotency key for retries. */
  executeTask(taskId: string, body: unknown, signal?: AbortSignal): Promise<TaskRpcResult>
  /** Settle one execution record as succeeded, failed, canceled or unknown. */
  finishRun(taskId: string, runId: string, body: unknown, signal?: AbortSignal): Promise<TaskRpcResult>
  /** Patch editable task fields with optimistic locking. */
  updateTask(taskId: string, body: unknown, signal?: AbortSignal): Promise<TaskRpcResult>
  /** Submit a formal report for the task. */
  submitReport(taskId: string, body: unknown, signal?: AbortSignal): Promise<TaskRpcResult>
  /** List inbox records with optional `status`/`channel`/`kind` filters. */
  listIdeas(query?: Readonly<Record<string, string>>, signal?: AbortSignal): Promise<TaskRpcResult>
  /** Capture one inbox record. */
  captureIdea(body: unknown, signal?: AbortSignal): Promise<TaskRpcResult>
  /** Classify, ready, ignore or archive one inbox record. */
  triageIdea(ideaId: string, body: unknown, signal?: AbortSignal): Promise<TaskRpcResult>
  /** Convert a ready inbox record into a task. */
  convertIdea(ideaId: string, signal?: AbortSignal): Promise<TaskRpcResult>
  /** Recent activities across tasks. */
  listActivities(query?: Readonly<Record<string, string>>, signal?: AbortSignal): Promise<TaskRpcResult>
  /** List the formal reports of one task. */
  listReports(taskId: string, signal?: AbortSignal): Promise<TaskRpcResult>
  /** Write (or rewrite) the Markdown document for one report. */
  exportReport(taskId: string, reportId: string, signal?: AbortSignal): Promise<TaskRpcResult>
  /** List projects, used to give a ready inbox record its home. */
  listProjects(signal?: AbortSignal): Promise<TaskRpcResult>
  /** List DSH Workspaces available for project binding. */
  listWorkspaces(signal?: AbortSignal): Promise<TaskRpcResult>
  /** Read the dependency graph used by the star map. */
  getGraph(query?: Readonly<Record<string, string>>, signal?: AbortSignal): Promise<TaskRpcResult>
  /** Read status and risk counts for the dashboard. */
  getDashboard(query?: Readonly<Record<string, string>>, signal?: AbortSignal): Promise<TaskRpcResult>
  /** Read the allowed next statuses for one task. */
  getTransitions(taskId: string, signal?: AbortSignal): Promise<TaskRpcResult>
  /** Read parent/blocks/related edges for one task. */
  listRelations(taskId: string, signal?: AbortSignal): Promise<TaskRpcResult>
  /** Read task artifacts. */
  listArtifacts(taskId: string, signal?: AbortSignal): Promise<TaskRpcResult>
  /** Create a project; tasks and inbox records need one. */
  createProject(body: unknown, signal?: AbortSignal): Promise<TaskRpcResult>
  /** Change a project's execution workspace binding. */
  rebindProject(projectId: string, body: unknown, signal?: AbortSignal): Promise<TaskRpcResult>
  /** List a task's comments. */
  listComments(taskId: string, signal?: AbortSignal): Promise<TaskRpcResult>
  /** Append one comment, optionally as a review decision. */
  addComment(taskId: string, body: unknown, signal?: AbortSignal): Promise<TaskRpcResult>
  /** List a task's acceptance criteria. */
  listCriteria(taskId: string, signal?: AbortSignal): Promise<TaskRpcResult>
  /** Add one acceptance criterion. */
  addCriterion(taskId: string, body: unknown, signal?: AbortSignal): Promise<TaskRpcResult>
  /** Read the Markdown document of one report. */
  getReportDocument(taskId: string, reportId: string, signal?: AbortSignal): Promise<TaskRpcResult>
  /** Mark one acceptance criterion passed or failed. */
  setCriterionStatus(taskId: string, criterionId: string, body: unknown, signal?: AbortSignal): Promise<TaskRpcResult>
  /** Approve or request changes on one formal report. */
  reviewReport(taskId: string, reportId: string, body: unknown, signal?: AbortSignal): Promise<TaskRpcResult>
}
