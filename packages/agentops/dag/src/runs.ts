/**
 * Run history routes: list settled runs and inspect one run's nodes.
 *
 * @module @agentops/dsh-dag/runs
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'

import { projectAgentActivity } from './activity.ts'
import type { AgentActivity } from './activity.ts'
import { parseWorkflowYaml } from './load.ts'
import { SqliteRunStore } from './run-store.ts'
import type { RunSummary } from './run-store.ts'
import type { RunState } from './types.ts'
import { validateWorkflow } from './validate.ts'

interface RunListBody {
  runs: RunSummary[]
  total: number
}

interface RunDetailBody {
  runId: string
  workflowId: string
  status: RunState['status']
  startedAt: string
  finishedAt?: string
  error?: string
  nodes: RunDetailNode[]
}

interface RunDetailNode {
  id: string
  status: RunState['nodes'][string]['status']
  attempts: number
  startedAt?: string
  finishedAt?: string
  error?: string
  chosenPort?: string
  outputs?: Record<string, unknown>
}

/** Failure codes returned by the collaboration activity route. */
export type RunActivityErrorCode =
  | 'invalid_query'
  | 'unknown_run'
  | 'workflow_missing'
  | 'workflow_mismatch'
  | 'workflow_invalid'
  | 'internal_error'

interface RunActivityErrorBody {
  error: {
    code: RunActivityErrorCode
    message: string
    issues?: readonly string[]
  }
}

/** Reads the raw YAML for a persisted workflow identity. */
export type WorkflowSourceReader = (workflowId: string) => Promise<{ readonly text: string }>

/**
 * Create the paged run-list handler.
 * @param store - run persistence.
 * @returns a request handler suitable for the Connection fetch registry.
 */
export function createRunListHandler(store: SqliteRunStore): (request: Request) => Response {
  return (request) => {
    const params = new URL(request.url).searchParams
    const limit = parseInteger(params.get('limit'), 50, 1, 200)
    const offset = parseInteger(params.get('offset'), 0, 0, Number.MAX_SAFE_INTEGER)
    const status = parseStatus(params.get('status'))
    if (limit === null || offset === null || status === null) return badRequest('invalid run list query')

    const workflow = params.get('workflowId')
    const workflowId = workflow === null || workflow.trim() === '' ? undefined : workflow
    const filter = {
      ...(status === undefined ? {} : { status }),
      ...(workflowId === undefined ? {} : { workflowId }),
    }
    const body: RunListBody = {
      runs: store.listPage(limit, { ...filter, offset }),
      total: store.count(filter),
    }
    return json(body)
  }
}

/**
 * Create the run-detail handler.
 * @param store - run persistence.
 * @returns a request handler suitable for the Connection fetch registry.
 */
export function createRunDetailHandler(store: SqliteRunStore): (request: Request) => Response {
  return (request) => {
    const id = new URL(request.url).searchParams.get('id') ?? ''
    const record = id.length === 0 ? null : store.loadRecord(id)
    if (record === null) return new Response('not found', { status: 404 })
    const { state } = record
    const body: RunDetailBody = {
      runId: state.runId,
      workflowId: record.workflowId,
      status: state.status,
      startedAt: state.startedAt,
      ...(state.finishedAt === undefined ? {} : { finishedAt: state.finishedAt }),
      ...(state.error === undefined ? {} : { error: state.error }),
      nodes: Object.entries(state.nodes).map(([nodeId, node]) => ({
        id: nodeId,
        status: node.status,
        attempts: node.attempts,
        ...(node.startedAt === undefined ? {} : { startedAt: node.startedAt }),
        ...(node.finishedAt === undefined ? {} : { finishedAt: node.finishedAt }),
        ...(node.error === undefined ? {} : { error: node.error }),
        ...(node.chosenPort === undefined ? {} : { chosenPort: node.chosenPort }),
        ...(node.outputs === undefined ? {} : { outputs: node.outputs }),
      })),
    }
    return json(body)
  }
}

/**
 * Create the collaboration activity handler.
 *
 * A persisted run identifies its workflow by id, but does not store the
 * definition revision. The route therefore combines the run with the current
 * YAML and fails rather than drawing a partial or unrelated graph.
 * @param store - run persistence.
 * @param readSource - raw workflow source reader.
 * @returns a request handler suitable for the Connection fetch registry.
 */
export function createRunActivityHandler(
  store: Pick<SqliteRunStore, 'loadRecord'>,
  readSource: WorkflowSourceReader,
): (request: Request) => Promise<Response> {
  return async (request) => {
    const id = new URL(request.url).searchParams.get('id')?.trim() ?? ''
    if (id.length === 0) {
      return activityError(400, 'invalid_query', 'run id is required')
    }

    try {
      const record = store.loadRecord(id)
      if (record === null) return activityError(404, 'unknown_run', 'run not found')

      let source: { readonly text: string }
      try {
        source = await readSource(record.workflowId)
      } catch (reason) {
        if (isErrno(reason, 'ENOENT') || reason instanceof RangeError) {
          return activityError(404, 'workflow_missing', 'workflow definition not found')
        }
        return activityError(500, 'internal_error', 'failed to read workflow definition')
      }

      let workflow
      try {
        workflow = parseWorkflowYaml(source.text)
      } catch (reason) {
        const issue = reason instanceof Error ? reason.message : 'invalid workflow YAML'
        return activityError(422, 'workflow_invalid', 'workflow definition is invalid', [issue])
      }

      if (workflow.id !== record.workflowId) {
        return activityError(
          409,
          'workflow_mismatch',
          `workflow id does not match run: expected ${record.workflowId}`,
        )
      }

      const validation = validateWorkflow(workflow)
      if (!validation.ok) {
        return activityError(422, 'workflow_invalid', 'workflow definition is invalid', validation.errors)
      }

      const body: AgentActivity = projectAgentActivity({ record, workflow })
      return json(body)
    } catch {
      return activityError(500, 'internal_error', 'failed to project run activity')
    }
  }
}

/**
 * Register the read-only run routes.
 * @param ctx - context carrying Connection.
 * @param store - run persistence.
 */
export function registerRunRoutes(ctx: Context, store: SqliteRunStore): void {
  const list = createRunListHandler(store)
  const detail = createRunDetailHandler(store)
  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/agentops/runs',
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: request => Promise.resolve(list(request)),
  }), 'agentops-dag: /api/agentops/runs')

  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/agentops/run',
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: request => Promise.resolve(detail(request)),
  }), 'agentops-dag: /api/agentops/run')
}

/**
 * Register the collaboration activity route.
 * @param ctx - context carrying Connection.
 * @param store - run persistence.
 * @param readSource - raw workflow source reader.
 */
export function registerRunActivityRoute(
  ctx: Context,
  store: SqliteRunStore,
  readSource: WorkflowSourceReader,
): void {
  const activity = createRunActivityHandler(store, readSource)
  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/agentops/run-activity',
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: activity,
  }), 'agentops-dag: /api/agentops/run-activity')
}

/**
 * Summaries for the client table, newest first.
 * @param store - the run store to read from.
 * @param limit - how many summaries to return.
 * @returns the newest run summaries.
 */
export function listRunSummaries(store: SqliteRunStore, limit = 50): RunSummary[] {
  return store.list(limit)
}

function parseInteger(raw: string | null, fallback: number, minimum: number, maximum: number): number | null {
  if (raw === null) return fallback
  if (!/^\d+$/.test(raw)) return null
  const value = Number(raw)
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum ? value : null
}

function parseStatus(raw: string | null): RunState['status'] | undefined | null {
  if (raw === null) return undefined
  return raw === 'running' || raw === 'completed' || raw === 'failed' || raw === 'cancelled'
    ? raw
    : null
}

function badRequest(message: string): Response {
  return json({ error: message }, 400)
}

function activityError(
  status: number,
  code: RunActivityErrorCode,
  message: string,
  issues?: readonly string[],
): Response {
  const body: RunActivityErrorBody = {
    error: {
      code,
      message,
      ...(issues === undefined ? {} : { issues }),
    },
  }
  return json(body, status)
}

function isErrno(reason: unknown, code: string): boolean {
  return typeof reason === 'object'
    && reason !== null
    && 'code' in reason
    && reason.code === code
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}
