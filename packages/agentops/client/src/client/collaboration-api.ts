/**
 * Client-side parser for one persisted run's collaboration activity.
 *
 * The endpoint is a wire boundary, so every field is validated before the
 * panel consumes it. HTTP error codes are retained for localized rendering;
 * server messages are never copied into the UI.
 *
 * @module @agentops/dsh-client/collaboration-api
 */

/** Persisted run status accepted by the activity endpoint. */
export type ActivityRunStatus = 'running' | 'completed' | 'failed' | 'cancelled'

/** Workflow node kind accepted by the activity endpoint. */
export type ActivityNodeType =
  | 'agent'
  | 'command'
  | 'await_command'
  | 'gateway'
  | 'parallel_branch'
  | 'while'

/** Persisted node status accepted by the activity endpoint. */
export type ActivityNodeStatus =
  | 'pending'
  | 'ready'
  | 'running'
  | 'completed'
  | 'failed'
  | 'skipped'

/** Timeline event kinds reconstructed from persisted timestamps. */
export type ActivityTimelineType =
  | 'run.started'
  | 'node.started'
  | 'node.completed'
  | 'node.failed'
  | 'node.skipped'
  | 'run.completed'
  | 'run.failed'
  | 'run.cancelled'

/** JSON values accepted in a node's persisted outputs. */
export type ActivityOutputValue =
  | null
  | boolean
  | number
  | string
  | readonly ActivityOutputValue[]
  | { readonly [key: string]: ActivityOutputValue }

/** Recursive JSON object accepted as persisted run inputs or rerun inputs. */
export type ActivityInputs = Readonly<Record<string, ActivityOutputValue>>

/** A business lane grouping nodes in workflow declaration order. */
export interface ActivityLane {
  readonly id: string
  readonly label: string
  readonly nodeIds: readonly string[]
}

/** One workflow node joined with its persisted execution state. */
export interface ActivityNode {
  readonly id: string
  readonly displayName: string
  readonly type: ActivityNodeType
  readonly laneId: string
  readonly status: ActivityNodeStatus
  readonly attempts: number
  readonly agentRef?: string
  readonly businessRole?: string
  readonly harness?: string
  readonly model?: string
  readonly startedAt?: string
  readonly finishedAt?: string
  readonly durationMs?: number
  readonly error?: string
  readonly chosenPort?: string
  readonly outputs?: Readonly<Record<string, ActivityOutputValue>>
}

/** Scheduling dependency from `after`; this is the only ordering edge. */
export interface ActivityScheduleEdge {
  readonly from: string
  readonly to: string
}

/** Declared data dependency from `outputs`; it never changes topology. */
export interface ActivityDataEdge {
  readonly from: string
  readonly to: string
  readonly port: string
}

/** One real lifecycle event reconstructed from persisted timestamps. */
export interface ActivityTimelineEntry {
  readonly id: string
  readonly type: ActivityTimelineType
  readonly occurredAt: string
  readonly nodeId?: string
  readonly error?: string
}

/** A handoff event reserved for future persisted event support. */
export interface ActivityHandoff {
  readonly id: string
  readonly fromNodeId: string
  readonly fromRole: string
  readonly toNodeId: string
  readonly toRole: string
  readonly port: string
  readonly payloadSize: number
  readonly summary: string
  readonly occurredAt?: string
}

/** Complete collaboration payload for one persisted run. */
export interface RunActivity {
  readonly runId: string
  readonly workflowId: string
  readonly status: ActivityRunStatus
  readonly inputs: ActivityInputs
  readonly startedAt: string
  readonly finishedAt?: string
  readonly lanes: readonly ActivityLane[]
  readonly nodes: readonly ActivityNode[]
  readonly scheduleEdges: readonly ActivityScheduleEdge[]
  readonly dataEdges: readonly ActivityDataEdge[]
  readonly timeline: readonly ActivityTimelineEntry[]
  readonly handoffs: readonly ActivityHandoff[]
}

/** Documented structured activity endpoint error codes. */
export type CollaborationErrorCode =
  | 'invalid_query'
  | 'unknown_run'
  | 'workflow_missing'
  | 'workflow_mismatch'
  | 'workflow_invalid'
  | 'internal_error'

/** Optional request controls for {@link loadRunActivity}. */
export interface LoadRunActivityOptions {
  readonly signal?: AbortSignal
  readonly fetchImpl?: typeof fetch
}

/** A documented HTTP failure from the activity endpoint. */
export class CollaborationRequestError extends Error {
  /** Stable error code for localized copy and recovery decisions. */
  readonly code: CollaborationErrorCode
  /** HTTP status paired with {@link code}. */
  readonly status: number
  /** Workflow validation details, when supplied by the endpoint. */
  readonly issues: readonly string[]

  /**
   * Create a structured request failure.
   * @param code - documented endpoint error code.
   * @param status - HTTP response status.
   * @param issues - optional validation details.
   */
  constructor(code: CollaborationErrorCode, status: number, issues: readonly string[] = []) {
    super(`run activity request failed: ${code}`)
    this.name = 'CollaborationRequestError'
    this.code = code
    this.status = status
    this.issues = issues
  }
}

/** A non-documented HTTP status or an unreadable activity response. */
export class CollaborationResponseError extends Error {
  /** HTTP status of the rejected response. */
  readonly status: number

  /**
   * Create a response failure without copying untrusted response text.
   * @param status - HTTP response status.
   * @param cause - optional JSON or transport failure.
   */
  constructor(status: number, cause?: unknown) {
    super(`run activity request failed with HTTP ${status}`, cause === undefined ? undefined : { cause })
    this.name = 'CollaborationResponseError'
    this.status = status
  }
}

/** Documented structured workflow rerun error codes. */
export type RerunErrorCode =
  | 'invalid_request'
  | 'unknown_run'
  | 'workflow_mismatch'
  | 'node_missing'
  | 'run_running'
  | 'workflow_invalid'
  | 'invalid_inputs'
  | 'session_unavailable'
  | 'internal_error'

/** Request body for rerunning one persisted workflow node. */
export interface RerunNodeRequest {
  readonly runId: string
  readonly workflowId: string
  readonly nodeId: string
  readonly onlyNode: boolean
  readonly inputs: ActivityInputs
}

/** Confirmation that one rerun instruction was created and queued. */
export interface RerunNodeQueued {
  readonly ok: true
  readonly sessionId: string
  readonly runId: string
  readonly workflowId: string
  readonly nodeId: string
  readonly onlyNode: boolean
}

/** Optional transport controls for {@link requestNodeRerun}. */
export interface RerunNodeOptions {
  readonly signal?: AbortSignal
  readonly fetchImpl?: typeof fetch
}

/** A documented HTTP failure from the workflow rerun endpoint. */
export class RerunRequestError extends Error {
  /** Stable error code for localized copy and recovery decisions. */
  readonly code: RerunErrorCode
  /** HTTP status paired with {@link code}. */
  readonly status: number
  /** Optional validation details returned by the endpoint. */
  readonly issues: readonly string[]
  /** Created Session when prompt queueing failed after Session creation. */
  readonly sessionId: string | undefined

  /**
   * Create a structured rerun failure.
   * @param code - documented endpoint error code.
   * @param status - HTTP response status.
   * @param issues - optional validation details.
   * @param sessionId - optional created Session identity.
   */
  constructor(
    code: RerunErrorCode,
    status: number,
    issues: readonly string[] = [],
    sessionId?: string,
  ) {
    super(`node rerun request failed: ${code}`)
    this.name = 'RerunRequestError'
    this.code = code
    this.status = status
    this.issues = issues
    this.sessionId = sessionId
  }
}

/** A non-documented HTTP status or an unreadable rerun response. */
export class RerunResponseError extends Error {
  /** HTTP status of the rejected response. */
  readonly status: number

  /**
   * Create a rerun response failure without copying untrusted response text.
   * @param status - HTTP response status.
   * @param cause - optional JSON or transport failure.
   */
  constructor(status: number, cause?: unknown) {
    super(`node rerun request failed with HTTP ${status}`, cause === undefined ? undefined : { cause })
    this.name = 'RerunResponseError'
    this.status = status
  }
}

const ERROR_STATUS: Readonly<Record<CollaborationErrorCode, number>> = {
  invalid_query: 400,
  unknown_run: 404,
  workflow_missing: 404,
  workflow_mismatch: 409,
  workflow_invalid: 422,
  internal_error: 500,
}

const RERUN_ERROR_STATUS: Readonly<Record<RerunErrorCode, number>> = {
  invalid_request: 400,
  unknown_run: 404,
  workflow_mismatch: 409,
  node_missing: 404,
  run_running: 409,
  workflow_invalid: 422,
  invalid_inputs: 422,
  session_unavailable: 503,
  internal_error: 500,
}

const RUN_STATUSES: ReadonlySet<string> = new Set<ActivityRunStatus>([
  'running', 'completed', 'failed', 'cancelled',
])

const NODE_TYPES: ReadonlySet<string> = new Set<ActivityNodeType>([
  'agent', 'command', 'await_command', 'gateway', 'parallel_branch', 'while',
])

const NODE_STATUSES: ReadonlySet<string> = new Set<ActivityNodeStatus>([
  'pending', 'ready', 'running', 'completed', 'failed', 'skipped',
])

const TIMELINE_TYPES: ReadonlySet<string> = new Set<ActivityTimelineType>([
  'run.started', 'node.started', 'node.completed', 'node.failed', 'node.skipped',
  'run.completed', 'run.failed', 'run.cancelled',
])

const RESPONSE_FAILURE = 'invalid run activity response'

/**
 * Load and validate collaboration activity for one run.
 * @param runId - opaque persisted run identity.
 * @param options - optional abort signal and fetch implementation.
 * @returns the validated activity payload.
 */
export async function loadRunActivity(
  runId: string,
  options: LoadRunActivityOptions = {},
): Promise<RunActivity> {
  const fetchImpl = options.fetchImpl ?? fetch
  const init: RequestInit = {
    credentials: 'include',
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  }
  const response = await fetchImpl(
    `/api/agentops/run-activity?id=${encodeURIComponent(runId)}`,
    init,
  )
  if (!response.ok) throw await requestFailure(response)
  return parseActivity(await readJson(response))
}

/**
 * Create one Session instruction that invokes `dag_rerun` for a node.
 * @param request - run, workflow, node, scope, and approved rerun inputs.
 * @param options - optional abort signal and fetch implementation.
 * @returns the validated queued instruction identity.
 */
export async function requestNodeRerun(
  request: RerunNodeRequest,
  options: RerunNodeOptions = {},
): Promise<RerunNodeQueued> {
  const fetchImpl = options.fetchImpl ?? fetch
  const init: RequestInit = {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  }
  const response = await fetchImpl('/api/agentops/workflow-rerun', init)
  if (!response.ok) throw await rerunFailure(response)
  return parseRerunSuccess(await readRerunJson(response), request)
}

async function rerunFailure(response: Response): Promise<Error> {
  try {
    const body: unknown = await response.json()
    const structured = parseRerunErrorBody(body, response.status)
    if (structured !== undefined) return structured
  } catch (reason) {
    return new RerunResponseError(response.status, reason)
  }
  return new RerunResponseError(response.status)
}

function parseRerunErrorBody(
  body: unknown,
  status: number,
): RerunRequestError | undefined {
  if (!hasOnlyKeys(body, ['error', 'sessionId']) || !isRecord(body.error)) return undefined
  if (!hasOnlyKeys(body.error, ['code', 'message', 'issues'])) return undefined
  const code = body.error.code
  if (typeof code !== 'string' || !isRerunErrorCode(code)) return undefined
  if (RERUN_ERROR_STATUS[code] !== status || typeof body.error.message !== 'string') return undefined

  const issues = body.error.issues
  if (issues !== undefined) {
    if (!Array.isArray(issues) || !issues.every(issue => typeof issue === 'string')) return undefined
  }
  const sessionId = body.sessionId
  if (sessionId !== undefined && !isNonEmptyString(sessionId)) return undefined
  return new RerunRequestError(code, status, issues ?? [], sessionId)
}

function isRerunErrorCode(value: string): value is RerunErrorCode {
  return value === 'invalid_request'
    || value === 'unknown_run'
    || value === 'workflow_mismatch'
    || value === 'node_missing'
    || value === 'run_running'
    || value === 'workflow_invalid'
    || value === 'invalid_inputs'
    || value === 'session_unavailable'
    || value === 'internal_error'
}

async function readRerunJson(response: Response): Promise<unknown> {
  try {
    const body: unknown = await response.json()
    return body
  } catch (reason) {
    throw new RerunResponseError(response.status, reason)
  }
}

function parseRerunSuccess(value: unknown, request: RerunNodeRequest): RerunNodeQueued {
  if (
    !hasOnlyKeys(value, ['ok', 'sessionId', 'runId', 'workflowId', 'nodeId', 'onlyNode'])
    || value.ok !== true
    || !isNonEmptyString(value.sessionId)
    || value.runId !== request.runId
    || value.workflowId !== request.workflowId
    || value.nodeId !== request.nodeId
    || value.onlyNode !== request.onlyNode
  ) {
    throw new RerunResponseError(200)
  }
  return {
    ok: true,
    sessionId: value.sessionId,
    runId: request.runId,
    workflowId: request.workflowId,
    nodeId: request.nodeId,
    onlyNode: request.onlyNode,
  }
}

async function requestFailure(response: Response): Promise<Error> {
  try {
    const body: unknown = await response.json()
    const structured = parseErrorBody(body, response.status)
    if (structured !== undefined) return structured
  } catch {
    // A malformed error body is still reported through the response status.
  }
  return new CollaborationResponseError(response.status)
}

function parseErrorBody(body: unknown, status: number): CollaborationRequestError | undefined {
  if (!isRecord(body) || !isRecord(body.error)) return undefined
  const code = body.error.code
  if (typeof code !== 'string' || !isErrorCode(code)) return undefined
  if (body.error.message !== undefined && typeof body.error.message !== 'string') return undefined
  if (ERROR_STATUS[code] !== status) return undefined
  const issues = body.error.issues
  if (issues !== undefined) {
    if (!Array.isArray(issues) || !issues.every(issue => typeof issue === 'string')) return undefined
  }
  return new CollaborationRequestError(code, status, issues ?? [])
}

function isErrorCode(value: string): value is CollaborationErrorCode {
  return value === 'invalid_query'
    || value === 'unknown_run'
    || value === 'workflow_missing'
    || value === 'workflow_mismatch'
    || value === 'workflow_invalid'
    || value === 'internal_error'
}

async function readJson(response: Response): Promise<unknown> {
  try {
    const body: unknown = await response.json()
    return body
  } catch (reason) {
    throw new CollaborationResponseError(response.status, reason)
  }
}

function parseActivity(value: unknown): RunActivity {
  if (
    !isRecord(value)
    || !isNonEmptyString(value.runId)
    || !isNonEmptyString(value.workflowId)
    || typeof value.status !== 'string'
    || !RUN_STATUSES.has(value.status)
    || !isTimestamp(value.startedAt)
    || !Array.isArray(value.lanes)
    || !Array.isArray(value.nodes)
    || !Array.isArray(value.scheduleEdges)
    || !Array.isArray(value.dataEdges)
    || !Array.isArray(value.timeline)
    || !Array.isArray(value.handoffs)
  ) {
    throw new Error(RESPONSE_FAILURE)
  }

  const finishedAt = parseOptionalTimestamp(value.finishedAt)
  const inputs = parseJsonObject(value.inputs)
  const lanes = value.lanes.map(parseLane)
  const nodes = value.nodes.map(parseNode)
  const scheduleEdges = value.scheduleEdges.map(parseScheduleEdge)
  const dataEdges = value.dataEdges.map(parseDataEdge)
  const timeline = value.timeline.map(parseTimelineEntry)
  const handoffs = value.handoffs.map(parseHandoff)

  assertUnique(lanes.map(lane => lane.id))
  assertUnique(nodes.map(node => node.id))
  assertUnique(timeline.map(entry => entry.id))
  assertUnique(handoffs.map(handoff => handoff.id))

  const laneIds = new Set(lanes.map(lane => lane.id))
  const nodeIds = new Set(nodes.map(node => node.id))
  for (const lane of lanes) {
    for (const nodeId of lane.nodeIds) {
      if (!nodeIds.has(nodeId)) throw new Error(RESPONSE_FAILURE)
    }
  }
  for (const node of nodes) {
    if (!laneIds.has(node.laneId)) throw new Error(RESPONSE_FAILURE)
  }
  for (const edge of scheduleEdges) {
    if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) throw new Error(RESPONSE_FAILURE)
  }
  for (const edge of dataEdges) {
    if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) throw new Error(RESPONSE_FAILURE)
  }
  for (const entry of timeline) {
    if (entry.nodeId !== undefined && !nodeIds.has(entry.nodeId)) throw new Error(RESPONSE_FAILURE)
  }
  for (const handoff of handoffs) {
    if (!nodeIds.has(handoff.fromNodeId) || !nodeIds.has(handoff.toNodeId)) {
      throw new Error(RESPONSE_FAILURE)
    }
  }

  return {
    runId: value.runId,
    workflowId: value.workflowId,
    status: value.status as ActivityRunStatus,
    inputs,
    startedAt: value.startedAt,
    ...(finishedAt === undefined ? {} : { finishedAt }),
    lanes,
    nodes,
    scheduleEdges,
    dataEdges,
    timeline,
    handoffs,
  }
}

function parseLane(value: unknown): ActivityLane {
  if (
    !isRecord(value)
    || !isNonEmptyString(value.id)
    || typeof value.label !== 'string'
    || !Array.isArray(value.nodeIds)
    || !value.nodeIds.every(nodeId => isNonEmptyString(nodeId))
  ) {
    throw new Error(RESPONSE_FAILURE)
  }
  return { id: value.id, label: value.label, nodeIds: value.nodeIds }
}

function parseNode(value: unknown): ActivityNode {
  if (
    !isRecord(value)
    || !isNonEmptyString(value.id)
    || typeof value.displayName !== 'string'
    || typeof value.type !== 'string'
    || !NODE_TYPES.has(value.type)
    || !isNonEmptyString(value.laneId)
    || typeof value.status !== 'string'
    || !NODE_STATUSES.has(value.status)
    || typeof value.attempts !== 'number'
    || !Number.isSafeInteger(value.attempts)
    || value.attempts < 0
  ) {
    throw new Error(RESPONSE_FAILURE)
  }

  const agentRef = parseOptionalString(value.agentRef)
  const businessRole = parseOptionalString(value.businessRole)
  const harness = parseOptionalString(value.harness)
  const model = parseOptionalString(value.model)
  const startedAt = parseOptionalTimestamp(value.startedAt)
  const finishedAt = parseOptionalTimestamp(value.finishedAt)
  const durationMs = parseOptionalNonNegativeNumber(value.durationMs)
  const error = parseOptionalString(value.error)
  const chosenPort = parseOptionalString(value.chosenPort)
  const outputs = parseOptionalOutputs(value.outputs)

  return {
    id: value.id,
    displayName: value.displayName,
    type: value.type as ActivityNodeType,
    laneId: value.laneId,
    status: value.status as ActivityNodeStatus,
    attempts: value.attempts,
    ...(agentRef === undefined ? {} : { agentRef }),
    ...(businessRole === undefined ? {} : { businessRole }),
    ...(harness === undefined ? {} : { harness }),
    ...(model === undefined ? {} : { model }),
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(finishedAt === undefined ? {} : { finishedAt }),
    ...(durationMs === undefined ? {} : { durationMs }),
    ...(error === undefined ? {} : { error }),
    ...(chosenPort === undefined ? {} : { chosenPort }),
    ...(outputs === undefined ? {} : { outputs }),
  }
}

function parseScheduleEdge(value: unknown): ActivityScheduleEdge {
  if (!isRecord(value) || !isNonEmptyString(value.from) || !isNonEmptyString(value.to)) {
    throw new Error(RESPONSE_FAILURE)
  }
  return { from: value.from, to: value.to }
}

function parseDataEdge(value: unknown): ActivityDataEdge {
  if (
    !isRecord(value)
    || !isNonEmptyString(value.from)
    || !isNonEmptyString(value.to)
    || !isNonEmptyString(value.port)
  ) {
    throw new Error(RESPONSE_FAILURE)
  }
  return { from: value.from, to: value.to, port: value.port }
}

function parseTimelineEntry(value: unknown): ActivityTimelineEntry {
  if (
    !isRecord(value)
    || !isNonEmptyString(value.id)
    || typeof value.type !== 'string'
    || !TIMELINE_TYPES.has(value.type)
    || !isTimestamp(value.occurredAt)
  ) {
    throw new Error(RESPONSE_FAILURE)
  }
  const nodeId = parseOptionalString(value.nodeId)
  const error = parseOptionalString(value.error)
  return {
    id: value.id,
    type: value.type as ActivityTimelineType,
    occurredAt: value.occurredAt,
    ...(nodeId === undefined ? {} : { nodeId }),
    ...(error === undefined ? {} : { error }),
  }
}

function parseHandoff(value: unknown): ActivityHandoff {
  if (
    !isRecord(value)
    || !isNonEmptyString(value.id)
    || !isNonEmptyString(value.fromNodeId)
    || !isNonEmptyString(value.fromRole)
    || !isNonEmptyString(value.toNodeId)
    || !isNonEmptyString(value.toRole)
    || !isNonEmptyString(value.port)
    || typeof value.payloadSize !== 'number'
    || !Number.isSafeInteger(value.payloadSize)
    || value.payloadSize < 0
    || typeof value.summary !== 'string'
  ) {
    throw new Error(RESPONSE_FAILURE)
  }
  const occurredAt = parseOptionalTimestamp(value.occurredAt)
  return {
    id: value.id,
    fromNodeId: value.fromNodeId,
    fromRole: value.fromRole,
    toNodeId: value.toNodeId,
    toRole: value.toRole,
    port: value.port,
    payloadSize: value.payloadSize,
    summary: value.summary,
    ...(occurredAt === undefined ? {} : { occurredAt }),
  }
}

function parseOptionalOutputs(
  value: unknown,
): Readonly<Record<string, ActivityOutputValue>> | undefined {
  if (value === undefined) return undefined
  return parseJsonObject(value)
}

function parseJsonObject(value: unknown): ActivityInputs {
  if (!isRecord(value)) throw new Error(RESPONSE_FAILURE)
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, parseOutputValue(item)]),
  )
}

function parseOutputValue(value: unknown): ActivityOutputValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(RESPONSE_FAILURE)
    return value
  }
  if (Array.isArray(value)) return value.map(parseOutputValue)
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, parseOutputValue(item)]),
    )
  }
  throw new Error(RESPONSE_FAILURE)
}

function parseOptionalString(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new Error(RESPONSE_FAILURE)
  return value
}

function parseOptionalTimestamp(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (!isTimestamp(value)) throw new Error(RESPONSE_FAILURE)
  return value
}

function parseOptionalNonNegativeNumber(value: unknown): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(RESPONSE_FAILURE)
  }
  return value
}

function isTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOnlyKeys(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  if (!isRecord(value)) return false
  const allowed = new Set(keys)
  return Object.keys(value).every(key => allowed.has(key))
}

function assertUnique(ids: readonly string[]): void {
  if (new Set(ids).size !== ids.length) throw new Error(RESPONSE_FAILURE)
}
