/**
 * Browser-side requests for the read-only DAG run history.
 *
 * Responses are parsed here because browser fetch results are untrusted wire
 * data. Invalid responses fail before the panel receives them.
 *
 * @module @agentops/dsh-client/run-history-api
 */

/** Terminal or active state of one DAG run. */
export type RunStatus = 'running' | 'completed' | 'failed' | 'cancelled'

/** State of one node within a DAG run. */
export type RunNodeStatus = 'pending' | 'ready' | 'running' | 'completed' | 'failed' | 'skipped'

/** A JSON value persisted as a node output. */
export type RunOutputValue =
  | string
  | number
  | boolean
  | null
  | readonly RunOutputValue[]
  | { readonly [key: string]: RunOutputValue }

/** One row in the paged run history. */
export interface RunSummary {
  readonly runId: string
  readonly workflowId: string
  readonly status: RunStatus
  readonly startedAt: string
  readonly finishedAt?: string
  readonly error?: string
}

/** One node's persisted execution state. */
export interface RunNodeDetail {
  readonly id: string
  readonly status: RunNodeStatus
  readonly attempts: number
  readonly startedAt?: string
  readonly finishedAt?: string
  readonly error?: string
  readonly chosenPort?: string
  readonly outputs?: Readonly<Record<string, RunOutputValue>>
}

/** One run with all persisted node states. */
export interface RunDetail extends RunSummary {
  readonly nodes: readonly RunNodeDetail[]
}

/** One page of run summaries and the total matching count. */
export interface RunHistoryPage {
  readonly runs: readonly RunSummary[]
  readonly total: number
}

/** Optional predicates and paging for a run-history request. */
export interface RunHistoryQuery {
  readonly limit?: number
  readonly offset?: number
  readonly status?: RunStatus
  readonly workflowId?: string
}

/** A non-success HTTP response from the run-history API. */
export class RunHistoryRequestError extends Error {
  /**
   * @param status - HTTP status returned by the host.
   */
  public constructor(public readonly status: number) {
    super(`run history request failed with HTTP ${status}`)
    this.name = 'RunHistoryRequestError'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isRunStatus(value: unknown): value is RunStatus {
  return value === 'running' || value === 'completed' || value === 'failed' || value === 'cancelled'
}

function isRunNodeStatus(value: unknown): value is RunNodeStatus {
  return value === 'pending'
    || value === 'ready'
    || value === 'running'
    || value === 'completed'
    || value === 'failed'
    || value === 'skipped'
}

function parseOptionalString(value: unknown, errorMessage: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new Error(errorMessage)
  return value
}

function parseSummary(value: unknown): RunSummary {
  const parseFailure = 'invalid run history response'
  if (
    !isRecord(value)
    || typeof value.runId !== 'string'
    || typeof value.workflowId !== 'string'
    || !isRunStatus(value.status)
    || typeof value.startedAt !== 'string'
  ) {
    throw new Error(parseFailure)
  }
  const finishedAt = parseOptionalString(value.finishedAt, parseFailure)
  const error = parseOptionalString(value.error, parseFailure)
  return {
    runId: value.runId,
    workflowId: value.workflowId,
    status: value.status,
    startedAt: value.startedAt,
    ...(finishedAt === undefined ? {} : { finishedAt }),
    ...(error === undefined ? {} : { error }),
  }
}

function parseOutputValue(value: unknown, errorMessage: string): RunOutputValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(errorMessage)
    return value
  }
  if (Array.isArray(value)) return value.map(item => parseOutputValue(item, errorMessage))
  if (isRecord(value)) return parseOutputRecord(value, errorMessage)
  throw new Error(errorMessage)
}

function parseOutputRecord(
  value: Record<string, unknown>,
  errorMessage: string,
): Readonly<Record<string, RunOutputValue>> {
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, parseOutputValue(item, errorMessage)]),
  )
}

function parseNode(value: unknown): RunNodeDetail {
  const parseFailure = 'invalid run detail response'
  if (
    !isRecord(value)
    || typeof value.id !== 'string'
    || !isRunNodeStatus(value.status)
    || typeof value.attempts !== 'number'
    || !Number.isSafeInteger(value.attempts)
    || value.attempts < 0
  ) {
    throw new Error(parseFailure)
  }
  const startedAt = parseOptionalString(value.startedAt, parseFailure)
  const finishedAt = parseOptionalString(value.finishedAt, parseFailure)
  const error = parseOptionalString(value.error, parseFailure)
  const chosenPort = parseOptionalString(value.chosenPort, parseFailure)
  let outputs: Readonly<Record<string, RunOutputValue>> | undefined
  if (value.outputs !== undefined) {
    if (!isRecord(value.outputs)) throw new Error(parseFailure)
    outputs = parseOutputRecord(value.outputs, parseFailure)
  }
  return {
    id: value.id,
    status: value.status,
    attempts: value.attempts,
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(finishedAt === undefined ? {} : { finishedAt }),
    ...(error === undefined ? {} : { error }),
    ...(chosenPort === undefined ? {} : { chosenPort }),
    ...(outputs === undefined ? {} : { outputs }),
  }
}

function parsePage(value: unknown): RunHistoryPage {
  const parseFailure = 'invalid run history response'
  if (
    !isRecord(value)
    || !Array.isArray(value.runs)
    || typeof value.total !== 'number'
    || !Number.isSafeInteger(value.total)
    || value.total < 0
  ) {
    throw new Error(parseFailure)
  }
  return {
    runs: value.runs.map(parseSummary),
    total: value.total,
  }
}

function parseDetail(value: unknown): RunDetail {
  const parseFailure = 'invalid run detail response'
  if (!isRecord(value) || !Array.isArray(value.nodes)) throw new Error(parseFailure)
  const summary = parseSummary(value)
  return {
    ...summary,
    nodes: value.nodes.map(parseNode),
  }
}

function runListUrl(query: RunHistoryQuery): string {
  const params = new URLSearchParams()
  if (query.limit !== undefined) params.set('limit', String(query.limit))
  if (query.offset !== undefined) params.set('offset', String(query.offset))
  if (query.status !== undefined) params.set('status', query.status)
  if (query.workflowId !== undefined) params.set('workflowId', query.workflowId)
  const search = params.toString()
  return search.length === 0 ? '/api/agentops/runs' : `/api/agentops/runs?${search}`
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch (reason) {
    throw new Error(`invalid run history response (HTTP ${response.status})`, { cause: reason })
  }
}

function unexpected(response: Response): RunHistoryRequestError {
  return new RunHistoryRequestError(response.status)
}

/**
 * Load one page of persisted run summaries.
 * @param query - optional status, workflow, and paging predicates.
 * @param fetchImpl - fetch implementation, injectable for tests.
 * @returns parsed summaries and the total matching count.
 */
export async function loadRunHistory(
  query: RunHistoryQuery = {},
  fetchImpl: typeof fetch = fetch,
): Promise<RunHistoryPage> {
  const response = await fetchImpl(runListUrl(query), { credentials: 'include' })
  if (!response.ok) throw unexpected(response)
  return parsePage(await readJson(response))
}

/**
 * Load one run with all persisted node states.
 * @param runId - opaque run identity.
 * @param fetchImpl - fetch implementation, injectable for tests.
 * @returns the parsed run and node details.
 */
export async function loadRunDetail(
  runId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<RunDetail> {
  const response = await fetchImpl(`/api/agentops/run?id=${encodeURIComponent(runId)}`, {
    credentials: 'include',
  })
  if (!response.ok) throw unexpected(response)
  return parseDetail(await readJson(response))
}
