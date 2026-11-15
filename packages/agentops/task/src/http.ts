/**
 * HTTP surface for the task domain.
 *
 * The router is transport-agnostic: it takes an already-parsed request
 * (method, path, query, JSON body, authenticated actor) and returns a status and
 * JSON body. DSH mounts it behind `connection.fetch`; tests call it directly.
 *
 * Every mutation goes through `TaskService`; reads go straight to SQLite. Error
 * responses are `{ error: { code, message, details } }`, with the status taken
 * from `TaskServiceError.httpStatus`.
 *
 * Routes are matched in registration order so static paths (`projects`,
 * `search`, `graph`, ...) win over `{task_id}`.
 *
 * @module @agentops/dsh-task/http
 */

import type { DatabaseSync } from 'node:sqlite'

import { exportReportDocument, listExports, readReportDocument, verifyExport } from './reports.ts'
import type { Actor, DecisionEvidenceInput, SearchDecisionsInput, TaskPatch } from './service.ts'
import { TaskService, TaskServiceError } from './service.ts'

/** One inbound request after transport parsing. */
export interface TaskHttpRequest {
  readonly method: string
  readonly path: string
  readonly query?: Readonly<Record<string, string | undefined>>
  readonly body?: unknown
  readonly actor: Actor
}

/** One outbound response. */
export interface TaskHttpResponse {
  readonly status: number
  readonly body: unknown
}

interface RouteContext {
  readonly params: Readonly<Record<string, string>>
  readonly query: Readonly<Record<string, string | undefined>>
  readonly body: Record<string, unknown>
  readonly actor: Actor
}

type Handler = (context: RouteContext) => unknown

interface Route {
  readonly method: string
  readonly namespace: 'tasks' | 'candidates' | 'decisions'
  readonly segments: readonly string[]
  readonly handler: Handler
}

const PREFIX = '/api/agentops/tasks'
const CANDIDATE_PREFIX = '/api/agentops/candidates'
const DECISION_PREFIX = '/api/agentops/decisions'

/**
 * Parse a JSON body that must be an object.
 * @param value - raw body.
 * @returns the object, or an empty object for an absent body.
 */
function objectBody(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null) return {}
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new TaskServiceError('invalid_request', 'request body must be a JSON object', {}, 400)
  }
  return value as Record<string, unknown>
}

/**
 * Read a numeric `if_version`, defaulting to 0.
 * @param body - request body.
 * @returns the expected version.
 */
function ifVersion(body: Record<string, unknown>): number {
  const value = body.if_version
  if (value === undefined) return 0
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new TaskServiceError('invalid_request', 'if_version must be a non-negative integer', {}, 400)
  }
  return value
}

/**
 * Read a required string field.
 * @param body - request body.
 * @param field - field name.
 * @returns the trimmed value.
 */
function requireString(body: Record<string, unknown>, field: string): string {
  const value = body[field]
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TaskServiceError('invalid_request', `${field} is required`, { field }, 400)
  }
  return value.trim()
}

/**
 * Read an optional string field.
 * @param body - request body.
 * @param field - field name.
 * @returns the string, or undefined when absent.
 */
function optionalString(body: Record<string, unknown>, field: string): string | undefined {
  const value = body[field]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') {
    throw new TaskServiceError('invalid_request', `${field} must be a string`, { field }, 400)
  }
  return value
}

/**
 * Coerce a JSON value into the record shape the service expects.
 * @param body - request body.
 * @returns the parsed object, or undefined.
 */
function optionalObject(body: Record<string, unknown>, field: string): Record<string, unknown> | undefined {
  const value = body[field]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new TaskServiceError('invalid_request', `${field} must be an object`, { field }, 400)
  }
  return value as Record<string, unknown>
}

/**
 * Coerce a JSON array of strings.
 * @param body - request body.
 * @param field - field name.
 * @returns the array, or undefined.
 */
function optionalStringArray(body: Record<string, unknown>, field: string): string[] | undefined {
  const value = body[field]
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
    throw new TaskServiceError('invalid_request', `${field} must be an array of strings`, { field }, 400)
  }
  return value as string[]
}

/**
 * Read an optional string that may be explicitly cleared with JSON null.
 * @param body - request body.
 * @param field - field name.
 * @returns the string, null, or undefined when absent.
 */
function optionalNullableString(body: Record<string, unknown>, field: string): string | null | undefined {
  const value = body[field]
  if (value === undefined) return undefined
  if (value === null) return null
  if (typeof value !== 'string') {
    throw new TaskServiceError('invalid_request', `${field} must be a string or null`, { field }, 400)
  }
  return value
}

/**
 * Parse an array of Decision evidence objects.
 * @param body - request body.
 * @param field - field name.
 * @returns typed evidence, or undefined when absent.
 */
function optionalDecisionEvidence(body: Record<string, unknown>, field = 'evidence'): DecisionEvidenceInput[] | undefined {
  const value = body[field]
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value)) {
    throw new TaskServiceError('invalid_request', `${field} must be an array`, { field }, 400)
  }
  return value.map((item, index) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new TaskServiceError('invalid_request', `${field}[${index}] must be an object`, { field, index }, 400)
    }
    const record = item as Record<string, unknown>
    const kind = optionalEnum(record, 'kind', [
      'pull_request', 'commit', 'deployment', 'document', 'approval', 'test', 'manual',
    ] as const)
    if (kind === undefined) {
      throw new TaskServiceError('invalid_request', `${field}[${index}].kind is required`, { field, index }, 400)
    }
    const contentHash = optionalString(record, 'content_hash') ?? optionalString(record, 'contentHash')
    return {
      kind,
      ref: requireString(record, 'ref'),
      ...(contentHash === undefined ? {} : { contentHash }),
    }
  })
}

/**
 * Read an optional enum field.
 * @param body - request body.
 * @param field - field name.
 * @param allowed - accepted values.
 * @returns the value, or undefined when absent.
 */
function optionalEnum<T extends string>(body: Record<string, unknown>, field: string, allowed: readonly T[]): T | undefined {
  const value = body[field]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new TaskServiceError('invalid_request', `${field} must be one of ${allowed.join(', ')}`, { field }, 400)
  }
  return value as T
}

/**
 * Read a required enum field.
 * @param body - request body.
 * @param field - field name.
 * @param allowed - accepted values.
 * @returns the value.
 */
function requireEnum<T extends string>(body: Record<string, unknown>, field: string, allowed: readonly T[]): T {
  const value = optionalEnum(body, field, allowed)
  if (value === undefined) throw new TaskServiceError('invalid_request', `${field} is required`, { field }, 400)
  return value
}

/**
 * Read a required query string field.
 * @param query - query parameters.
 * @param field - field name.
 * @returns the trimmed value.
 */
function requireQueryString(
  query: Readonly<Record<string, string | undefined>>,
  field: string,
): string {
  const value = query[field]
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TaskServiceError('invalid_request', `${field} is required`, { field }, 400)
  }
  return value.trim()
}

/**
 * Read an optional query enum field.
 * @param query - query parameters.
 * @param field - field name.
 * @param allowed - accepted values.
 * @returns the value, or undefined when absent.
 */
function optionalQueryEnum<T extends string>(
  query: Readonly<Record<string, string | undefined>>,
  field: string,
  allowed: readonly T[],
): T | undefined {
  const value = query[field]
  if (value === undefined || value === '') return undefined
  if (!(allowed as readonly string[]).includes(value)) {
    throw new TaskServiceError('invalid_request', `${field} must be one of ${allowed.join(', ')}`, { field }, 400)
  }
  return value as T
}

const PATCHABLE_FIELDS = new Set([
  'title',
  'description',
  'task_type',
  'risk_level',
  'assignee_name',
  'sort_order',
  'style_id',
  'parent_task_id',
])

/**
 * Convert an arbitrary object into the editable-field patch.
 * @param record - candidate patch object.
 * @returns the typed patch; unknown fields are rejected.
 */
function toTaskPatch(record: Record<string, unknown>): TaskPatch {
  for (const key of Object.keys(record)) {
    if (!PATCHABLE_FIELDS.has(key)) {
      throw new TaskServiceError('invalid_request', `field ${key} is not editable`, { field: key }, 400)
    }
  }
  return record
}

/** Split a path into its namespace and segments after the API prefix. */
function segmentsOf(path: string): { namespace: 'tasks' | 'candidates' | 'decisions'; segments: string[] } | undefined {
  const match = path.startsWith(DECISION_PREFIX)
    ? { namespace: 'decisions' as const, rest: path.slice(DECISION_PREFIX.length) }
    : path.startsWith(CANDIDATE_PREFIX)
      ? { namespace: 'candidates' as const, rest: path.slice(CANDIDATE_PREFIX.length) }
      : path.startsWith(PREFIX)
        ? { namespace: 'tasks' as const, rest: path.slice(PREFIX.length) }
        : undefined
  if (match === undefined) return undefined
  if (match.rest === '') return { namespace: match.namespace, segments: [] }
  if (!match.rest.startsWith('/')) return undefined
  return { namespace: match.namespace, segments: match.rest.slice(1).split('/') }
}

/**
 * The task HTTP API over one service and database.
 */
export interface TaskHttpApiOptions {
  readonly exportRootDir?: string
  readonly listWorkspaces?: () => readonly { workspace_id: string; title: string; path: string }[]
}

export class TaskHttpApi {
  readonly #service: TaskService
  readonly #db: DatabaseSync
  readonly #exportRootDir: string | undefined
  readonly #listWorkspaces: (() => readonly { workspace_id: string; title: string; path: string }[]) | undefined
  readonly #routes: readonly Route[]

  /**
   * @param service - the task write path.
   * @param db - the same database the service writes to, for reads.
   * @param options - optional export root; without it export routes answer 503.
   */
  constructor(service: TaskService, db: DatabaseSync, options: TaskHttpApiOptions = {}) {
    this.#service = service
    this.#db = db
    this.#exportRootDir = options.exportRootDir
    this.#listWorkspaces = options.listWorkspaces
    this.#routes = this.#buildRoutes()
  }

  /**
   * Handle one request.
   * @param request - parsed request.
   * @returns status and JSON body.
   */
  handle(request: TaskHttpRequest): TaskHttpResponse {
    const parsed = segmentsOf(request.path)
    if (parsed === undefined) return notFound('unknown path')
    for (const route of this.#routes) {
      if (route.namespace !== parsed.namespace) continue
      if (route.method !== request.method.toUpperCase()) continue
      const params = matchSegments(route.segments, parsed.segments)
      if (params === undefined) continue
      try {
        const result = route.handler({
          params,
          query: request.query ?? {},
          body: objectBody(request.body),
          actor: request.actor,
        })
        return { status: 200, body: result }
      } catch (error) {
        return toResponse(error)
      }
    }
    return notFound(`no route for ${request.method} ${request.path}`)
  }

  #buildRoutes(): Route[] {
    const routes: Route[] = []
    const add = (
      method: string,
      path: string,
      handler: Handler,
      namespace: 'tasks' | 'candidates' | 'decisions' = 'tasks',
    ): void => {
      routes.push({ method, namespace, segments: path === '' ? [] : path.split('/'), handler })
    }

    add('POST', '', ({ body, actor }) => ({
      candidate: this.#service.captureCandidate({
        projectId: requireString(body, 'project_id'),
        title: requireString(body, 'title'),
        actor,
        ...(optionalString(body, 'description') === undefined ? {} : { description: optionalString(body, 'description') as string }),
        ...(optionalEnum(body, 'source_type', ['manual', 'idea', 'agent', 'connector', 'external', 'legacy_task'] as const) === undefined
          ? {}
          : { sourceType: optionalEnum(body, 'source_type', ['manual', 'idea', 'agent', 'connector', 'external', 'legacy_task'] as const) as 'manual' }),
        ...(optionalString(body, 'source_system') === undefined ? {} : { sourceSystem: optionalString(body, 'source_system') as string }),
        ...(optionalString(body, 'source_ref') === undefined ? {} : { sourceRef: optionalString(body, 'source_ref') as string }),
        ...(optionalString(body, 'workspace_id') === undefined ? {} : { workspaceId: optionalString(body, 'workspace_id') as string }),
        ...(optionalString(body, 'repository_ref') === undefined ? {} : { repositoryRef: optionalString(body, 'repository_ref') as string }),
        ...(optionalString(body, 'branch_ref') === undefined ? {} : { branchRef: optionalString(body, 'branch_ref') as string }),
        ...(optionalString(body, 'owner_user_id') === undefined ? {} : { ownerUserId: optionalString(body, 'owner_user_id') as string }),
        ...(optionalString(body, 'proposed_assignee') === undefined ? {} : { proposedAssignee: optionalString(body, 'proposed_assignee') as string }),
        ...(optionalEnum(body, 'risk_level', ['low', 'medium', 'high'] as const) === undefined
          ? {}
          : { riskLevel: optionalEnum(body, 'risk_level', ['low', 'medium', 'high'] as const) as 'medium' }),
        ...(optionalString(body, 'risk_reason') === undefined ? {} : { riskReason: optionalString(body, 'risk_reason') as string }),
        ...(optionalEnum(body, 'complexity', ['simple', 'medium', 'complex'] as const) === undefined
          ? {}
          : { complexity: optionalEnum(body, 'complexity', ['simple', 'medium', 'complex'] as const) as 'medium' }),
        ...(body.decision_change_required === undefined ? {} : { decisionChangeRequired: body.decision_change_required === true }),
      }),
    }), 'candidates')
    add('POST', '{candidate_id}/analyze', ({ params, body, actor }) => ({
      candidate: this.#service.analyzeCandidate({
        candidateId: params.candidate_id ?? '',
        ifVersion: ifVersion(body),
        actor,
        ...(optionalString(body, 'title') === undefined ? {} : { title: optionalString(body, 'title') as string }),
        ...(optionalString(body, 'description') === undefined ? {} : { description: optionalString(body, 'description') as string }),
        ...(optionalString(body, 'analysis_problem') === undefined ? {} : { analysisProblem: optionalString(body, 'analysis_problem') as string }),
        ...(optionalString(body, 'analysis_non_goals') === undefined ? {} : { analysisNonGoals: optionalString(body, 'analysis_non_goals') as string }),
        ...(optionalString(body, 'analysis_deliverables') === undefined ? {} : { analysisDeliverables: optionalString(body, 'analysis_deliverables') as string }),
        ...(body.acceptance_criteria === undefined ? {} : { acceptanceCriteria: body.acceptance_criteria as readonly unknown[] }),
        ...(body.dependencies === undefined ? {} : { dependencies: body.dependencies as readonly unknown[] }),
        ...(optionalEnum(body, 'risk_level', ['low', 'medium', 'high'] as const) === undefined
          ? {}
          : { riskLevel: optionalEnum(body, 'risk_level', ['low', 'medium', 'high'] as const) as 'medium' }),
        ...(optionalString(body, 'risk_reason') === undefined ? {} : { riskReason: optionalString(body, 'risk_reason') as string }),
        ...(optionalEnum(body, 'complexity', ['simple', 'medium', 'complex'] as const) === undefined
          ? {}
          : { complexity: optionalEnum(body, 'complexity', ['simple', 'medium', 'complex'] as const) as 'medium' }),
        ...(optionalString(body, 'owner_user_id') === undefined ? {} : { ownerUserId: optionalString(body, 'owner_user_id') as string }),
        ...(optionalString(body, 'proposed_assignee') === undefined ? {} : { proposedAssignee: optionalString(body, 'proposed_assignee') as string }),
        ...(body.mandate_scope === undefined ? {} : { mandateScope: body.mandate_scope as Record<string, unknown> }),
        ...(body.decision_change_required === undefined ? {} : { decisionChangeRequired: body.decision_change_required === true }),
      }),
    }), 'candidates')
    add('POST', '{candidate_id}/preflight-search', ({ params, body, actor }) => ({
      snapshot: this.#service.createAdmissionSnapshot({
        candidateId: params.candidate_id ?? '',
        ifVersion: ifVersion(body),
        actor,
        query: body.query ?? {},
        searchCoverage: requireEnum(body, 'search_coverage', ['complete', 'partial', 'failed'] as const),
        ...(body.active_work === undefined ? {} : { activeWork: body.active_work as readonly Record<string, unknown>[] }),
        ...(optionalStringArray(body, 'proposed_decision_ids') === undefined ? {} : { proposedDecisionIds: optionalStringArray(body, 'proposed_decision_ids') as string[] }),
        ...(optionalStringArray(body, 'authoritative_decision_ids') === undefined ? {} : { authoritativeDecisionIds: optionalStringArray(body, 'authoritative_decision_ids') as string[] }),
        ...(optionalStringArray(body, 'historical_decision_ids') === undefined ? {} : { historicalDecisionIds: optionalStringArray(body, 'historical_decision_ids') as string[] }),
        ...(optionalStringArray(body, 'selected_decision_ids') === undefined ? {} : { selectedDecisionIds: optionalStringArray(body, 'selected_decision_ids') as string[] }),
        ...(body.conflicts === undefined ? {} : { conflicts: body.conflicts as readonly Record<string, unknown>[] }),
        ...(optionalStringArray(body, 'required_actions') === undefined ? {} : { requiredActions: optionalStringArray(body, 'required_actions') as string[] }),
        ...(optionalString(body, 'residual_risk') === undefined ? {} : { residualRisk: optionalString(body, 'residual_risk') as string }),
      }),
    }), 'candidates')
    add('POST', '{candidate_id}/gate', ({ params, body, actor }) => (
      this.#service.approveCandidateGate({
        candidateId: params.candidate_id ?? '',
        ifVersion: ifVersion(body),
        actor,
      })
    ), 'candidates')
    add('GET', '{candidate_id}', ({ params }) => ({ candidate: this.#service.getCandidate(params.candidate_id ?? '') }), 'candidates')

    add('GET', 'search', ({ query }) => {
      const input: SearchDecisionsInput = {
        projectId: requireQueryString(query, 'project_id'),
        ...(query.q === undefined ? {} : { q: query.q }),
        ...(optionalQueryEnum(query, 'collection', ['proposed', 'authoritative', 'historical', 'all'] as const) === undefined
          ? {}
          : { collection: optionalQueryEnum(query, 'collection', ['proposed', 'authoritative', 'historical', 'all'] as const) as 'all' }),
        ...(optionalQueryEnum(query, 'status', ['proposed', 'implemented', 'rejected', 'archived'] as const) === undefined
          ? {}
          : { status: optionalQueryEnum(query, 'status', ['proposed', 'implemented', 'rejected', 'archived'] as const) as 'proposed' }),
        ...(optionalQueryEnum(query, 'authority_scope', [
          'project', 'workspace', 'repository', 'branch', 'environment', 'task',
        ] as const) === undefined
          ? {}
          : { authorityScope: optionalQueryEnum(query, 'authority_scope', [
            'project', 'workspace', 'repository', 'branch', 'environment', 'task',
          ] as const) as 'project' }),
        ...(optionalQueryEnum(query, 'authority_level', [
          'hard_constraint', 'policy', 'implementation', 'local_default',
        ] as const) === undefined
          ? {}
          : { authorityLevel: optionalQueryEnum(query, 'authority_level', [
            'hard_constraint', 'policy', 'implementation', 'local_default',
          ] as const) as 'policy' }),
        ...(optionalQueryEnum(query, 'subject_type', [
          'project', 'task', 'module', 'service', 'api', 'process', 'data', 'security',
        ] as const) === undefined
          ? {}
          : { subjectType: optionalQueryEnum(query, 'subject_type', [
            'project', 'task', 'module', 'service', 'api', 'process', 'data', 'security',
          ] as const) as 'project' }),
        ...(query.subject_id === undefined ? {} : { subjectId: query.subject_id }),
        ...(query.decision_key === undefined ? {} : { decisionKey: query.decision_key }),
        ...(query.limit === undefined ? {} : { limit: limitOf(query, 50) }),
      }
      return this.#service.decisionSearch(input)
    }, 'decisions')
    add('POST', '', ({ body, actor }) => ({
      decision: this.#service.decisionPropose({
        projectId: requireString(body, 'project_id'),
        decisionKey: requireString(body, 'decision_key'),
        title: requireString(body, 'title'),
        subjectType: requireEnum(body, 'subject_type', [
          'project', 'task', 'module', 'service', 'api', 'process', 'data', 'security',
        ] as const),
        authorityScope: requireEnum(body, 'authority_scope', [
          'project', 'workspace', 'repository', 'branch', 'environment', 'task',
        ] as const),
        authorityLevel: requireEnum(body, 'authority_level', [
          'hard_constraint', 'policy', 'implementation', 'local_default',
        ] as const),
        problem: requireString(body, 'problem'),
        proposal: requireString(body, 'proposal'),
        rationale: requireString(body, 'rationale'),
        noteClass: requireEnum(body, 'note_class', [
          'feature', 'bug-fix', 'simplification', 'architecture', 'process', 'testing',
        ] as const),
        actor,
        ...(optionalString(body, 'decision_id') === undefined ? {} : { decisionId: optionalString(body, 'decision_id') as string }),
        ...(optionalString(body, 'workspace_id') === undefined ? {} : { workspaceId: optionalString(body, 'workspace_id') as string }),
        ...(optionalString(body, 'repository_ref') === undefined ? {} : { repositoryRef: optionalString(body, 'repository_ref') as string }),
        ...(optionalString(body, 'subject_id') === undefined ? {} : { subjectId: optionalString(body, 'subject_id') as string }),
        ...(optionalNullableString(body, 'relaxes_decision_id') == null ? {} : { relaxesDecisionId: optionalNullableString(body, 'relaxes_decision_id') as string }),
        ...(optionalNullableString(body, 'relaxes_evidence_id') == null ? {} : { relaxesEvidenceId: optionalNullableString(body, 'relaxes_evidence_id') as string }),
        ...(optionalString(body, 'environment') === undefined ? {} : { environment: optionalString(body, 'environment') as string }),
        ...(optionalString(body, 'branch_key') === undefined ? {} : { branchKey: optionalString(body, 'branch_key') as string }),
        ...(optionalString(body, 'rollout_key') === undefined ? {} : { rolloutKey: optionalString(body, 'rollout_key') as string }),
        ...(optionalString(body, 'tenant_key') === undefined ? {} : { tenantKey: optionalString(body, 'tenant_key') as string }),
        ...(optionalString(body, 'region_key') === undefined ? {} : { regionKey: optionalString(body, 'region_key') as string }),
        ...(optionalString(body, 'alternatives') === undefined ? {} : { alternatives: optionalString(body, 'alternatives') as string }),
        ...(optionalString(body, 'acceptance_criteria') === undefined ? {} : { acceptanceCriteria: optionalString(body, 'acceptance_criteria') as string }),
        ...(optionalNullableString(body, 'predecessor_id') == null ? {} : { predecessorId: optionalNullableString(body, 'predecessor_id') as string }),
        ...(optionalNullableString(body, 'supersedes_id') == null ? {} : { supersedesId: optionalNullableString(body, 'supersedes_id') as string }),
        ...(optionalNullableString(body, 'source_task_id') == null ? {} : { sourceTaskId: optionalNullableString(body, 'source_task_id') as string }),
        ...(optionalNullableString(body, 'source_candidate_id') == null ? {} : { sourceCandidateId: optionalNullableString(body, 'source_candidate_id') as string }),
        ...(optionalString(body, 'source_run') === undefined ? {} : { sourceRun: optionalString(body, 'source_run') as string }),
        ...(optionalString(body, 'note_path') === undefined ? {} : { notePath: optionalString(body, 'note_path') as string }),
        ...(optionalString(body, 'note_date') === undefined ? {} : { noteDate: optionalString(body, 'note_date') as string }),
        ...(optionalString(body, 'content_hash') === undefined ? {} : { contentHash: optionalString(body, 'content_hash') as string }),
        ...(optionalString(body, 'base_content_hash') === undefined ? {} : { baseContentHash: optionalString(body, 'base_content_hash') as string }),
        ...(optionalDecisionEvidence(body) === undefined ? {} : { evidence: optionalDecisionEvidence(body) as DecisionEvidenceInput[] }),
      }),
    }), 'decisions')
    add('GET', '{decision_id}', ({ params }) => this.#service.decisionGet(params.decision_id ?? ''), 'decisions')
    add('POST', '{decision_id}/revise', ({ params, body, actor }) => ({
      decision: this.#service.decisionRevise({
        decisionId: params.decision_id ?? '',
        ifVersion: ifVersion(body),
        actor,
        ...(optionalString(body, 'workspace_id') === undefined ? {} : { workspaceId: optionalString(body, 'workspace_id') as string }),
        ...(optionalString(body, 'repository_ref') === undefined ? {} : { repositoryRef: optionalString(body, 'repository_ref') as string }),
        ...(optionalString(body, 'decision_key') === undefined ? {} : { decisionKey: optionalString(body, 'decision_key') as string }),
        ...(optionalString(body, 'title') === undefined ? {} : { title: optionalString(body, 'title') as string }),
        ...(optionalEnum(body, 'subject_type', [
          'project', 'task', 'module', 'service', 'api', 'process', 'data', 'security',
        ] as const) === undefined
          ? {}
          : { subjectType: optionalEnum(body, 'subject_type', [
            'project', 'task', 'module', 'service', 'api', 'process', 'data', 'security',
          ] as const) as 'project' }),
        ...(optionalString(body, 'subject_id') === undefined ? {} : { subjectId: optionalString(body, 'subject_id') as string }),
        ...(optionalEnum(body, 'authority_scope', [
          'project', 'workspace', 'repository', 'branch', 'environment', 'task',
        ] as const) === undefined
          ? {}
          : { authorityScope: optionalEnum(body, 'authority_scope', [
            'project', 'workspace', 'repository', 'branch', 'environment', 'task',
          ] as const) as 'project' }),
        ...(optionalEnum(body, 'authority_level', [
          'hard_constraint', 'policy', 'implementation', 'local_default',
        ] as const) === undefined
          ? {}
          : { authorityLevel: optionalEnum(body, 'authority_level', [
            'hard_constraint', 'policy', 'implementation', 'local_default',
          ] as const) as 'policy' }),
        ...(optionalNullableString(body, 'relaxes_decision_id') === undefined ? {} : { relaxesDecisionId: optionalNullableString(body, 'relaxes_decision_id') as string | null }),
        ...(optionalNullableString(body, 'relaxes_evidence_id') === undefined ? {} : { relaxesEvidenceId: optionalNullableString(body, 'relaxes_evidence_id') as string | null }),
        ...(optionalString(body, 'environment') === undefined ? {} : { environment: optionalString(body, 'environment') as string }),
        ...(optionalString(body, 'branch_key') === undefined ? {} : { branchKey: optionalString(body, 'branch_key') as string }),
        ...(optionalString(body, 'rollout_key') === undefined ? {} : { rolloutKey: optionalString(body, 'rollout_key') as string }),
        ...(optionalString(body, 'tenant_key') === undefined ? {} : { tenantKey: optionalString(body, 'tenant_key') as string }),
        ...(optionalString(body, 'region_key') === undefined ? {} : { regionKey: optionalString(body, 'region_key') as string }),
        ...(optionalString(body, 'problem') === undefined ? {} : { problem: optionalString(body, 'problem') as string }),
        ...(optionalString(body, 'proposal') === undefined ? {} : { proposal: optionalString(body, 'proposal') as string }),
        ...(optionalString(body, 'rationale') === undefined ? {} : { rationale: optionalString(body, 'rationale') as string }),
        ...(optionalString(body, 'alternatives') === undefined ? {} : { alternatives: optionalString(body, 'alternatives') as string }),
        ...(optionalString(body, 'acceptance_criteria') === undefined ? {} : { acceptanceCriteria: optionalString(body, 'acceptance_criteria') as string }),
        ...(optionalNullableString(body, 'predecessor_id') === undefined ? {} : { predecessorId: optionalNullableString(body, 'predecessor_id') as string | null }),
        ...(optionalNullableString(body, 'supersedes_id') === undefined ? {} : { supersedesId: optionalNullableString(body, 'supersedes_id') as string | null }),
        ...(optionalNullableString(body, 'source_task_id') === undefined ? {} : { sourceTaskId: optionalNullableString(body, 'source_task_id') as string | null }),
        ...(optionalNullableString(body, 'source_candidate_id') === undefined ? {} : { sourceCandidateId: optionalNullableString(body, 'source_candidate_id') as string | null }),
        ...(optionalString(body, 'source_run') === undefined ? {} : { sourceRun: optionalString(body, 'source_run') as string }),
        ...(optionalString(body, 'note_path') === undefined ? {} : { notePath: optionalString(body, 'note_path') as string }),
        ...(optionalEnum(body, 'note_class', [
          'feature', 'bug-fix', 'simplification', 'architecture', 'process', 'testing',
        ] as const) === undefined
          ? {}
          : { noteClass: optionalEnum(body, 'note_class', [
            'feature', 'bug-fix', 'simplification', 'architecture', 'process', 'testing',
          ] as const) as 'feature' }),
        ...(optionalString(body, 'note_date') === undefined ? {} : { noteDate: optionalString(body, 'note_date') as string }),
        ...(optionalString(body, 'content_hash') === undefined ? {} : { contentHash: optionalString(body, 'content_hash') as string }),
        ...(optionalString(body, 'base_content_hash') === undefined ? {} : { baseContentHash: optionalString(body, 'base_content_hash') as string }),
        ...(optionalDecisionEvidence(body) === undefined ? {} : { evidence: optionalDecisionEvidence(body) as DecisionEvidenceInput[] }),
      }),
    }), 'decisions')
    add('POST', '{decision_id}/implement', ({ params, body, actor }) => ({
      decision: this.#service.decisionImplement({
        decisionId: params.decision_id ?? '',
        ifVersion: ifVersion(body),
        actor,
        ...(optionalString(body, 'effective_from') === undefined ? {} : { effectiveFrom: optionalString(body, 'effective_from') as string }),
        evidence: optionalDecisionEvidence(body) ?? [],
      }),
    }), 'decisions')
    add('POST', '{decision_id}/reject', ({ params, body, actor }) => ({
      decision: this.#service.decisionReject({
        decisionId: params.decision_id ?? '',
        ifVersion: ifVersion(body),
        actor,
        reason: requireString(body, 'reason'),
      }),
    }), 'decisions')
    add('POST', '{decision_id}/archive', ({ params, body, actor }) => ({
      decision: this.#service.decisionArchive({
        decisionId: params.decision_id ?? '',
        ifVersion: ifVersion(body),
        actor,
        reason: requireEnum(body, 'reason', ['superseded', 'invalidated', 'obsolete', 'project_archived'] as const),
      }),
    }), 'decisions')
    add('POST', '{decision_id}/supersede', ({ params, body, actor }) => (
      this.#service.decisionSupersede({
        decisionId: params.decision_id ?? '',
        ifVersion: ifVersion(body),
        actor,
        successorDecisionId: requireString(body, 'successor_decision_id'),
      })
    ), 'decisions')

    add('GET', 'projects', () => {
      const workspaces = new Map((this.#listWorkspaces?.() ?? []).map(workspace => [workspace.workspace_id, workspace]))
      return {
        projects: (this.#db
          .prepare(
            `SELECT p.*, (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.project_id) AS task_count
             FROM projects p ORDER BY p.created_at`,
          )
          .all() as unknown as Record<string, unknown>[]).map((project) => {
          const workspaceId = typeof project.workspace_id === 'string' ? project.workspace_id : ''
          const workspace = workspaces.get(workspaceId)
          return {
            ...project,
            workspace_path: workspace?.path ?? (workspaceId !== '' && (workspaceId.startsWith('/') || /^[A-Za-z]:[\\/]/.test(workspaceId)) ? workspaceId : null),
            workspace_title: workspace?.title ?? null,
          }
        }),
      }
    })
    add('GET', 'workspaces', () => ({
      workspaces: this.#listWorkspaces?.() ?? [],
    }))
    add('POST', 'projects/{project_id}/rebind', ({ params, body, actor }) => {
      const workspaceId = optionalString(body, 'workspace_id')
      if (workspaceId !== undefined && workspaceId.trim() !== '' && this.#listWorkspaces !== undefined) {
        const known = this.#listWorkspaces().some(workspace => workspace.workspace_id === workspaceId)
        if (!known) {
          throw new TaskServiceError('workspace_invalid', `workspace ${workspaceId} is not registered`, { workspaceId }, 400)
        }
      }
      return {
        project: this.#service.rebindProject({
          projectId: params.project_id ?? '',
          ifVersion: ifVersion(body),
          ...(workspaceId === undefined ? {} : { workspaceId }),
          ...(optionalString(body, 'local_path') === undefined ? {} : { localPath: optionalString(body, 'local_path') as string }),
          actor,
        }),
      }
    })
    add('POST', 'projects', ({ body, actor }) => {
      const workspaceId = optionalString(body, 'workspace_id')
      if (workspaceId !== undefined && workspaceId.trim() !== '' && this.#listWorkspaces !== undefined) {
        const known = this.#listWorkspaces().some(workspace => workspace.workspace_id === workspaceId)
        if (!known) {
          throw new TaskServiceError('workspace_invalid', `workspace ${workspaceId} is not registered`, { workspaceId }, 400)
        }
      }
      return {
        project_id: this.#service.createProject({
          name: requireString(body, 'name'),
          ...(optionalString(body, 'type') === undefined ? {} : { type: optionalString(body, 'type') as 'code' }),
          ...(workspaceId === undefined ? {} : { workspaceId }),
          ...(optionalString(body, 'local_path') === undefined ? {} : { localPath: optionalString(body, 'local_path') as string }),
          ...(optionalString(body, 'github_url') === undefined ? {} : { githubUrl: optionalString(body, 'github_url') as string }),
          ...(optionalString(body, 'branch_ref') === undefined ? {} : { branchRef: optionalString(body, 'branch_ref') as string }),
          ...(optionalString(body, 'feishu_doc_token') === undefined ? {} : { feishuDocToken: optionalString(body, 'feishu_doc_token') as string }),
          actor,
        }),
      }
    })
    add('GET', 'revision', () => ({
      revision: (this.#db.prepare('SELECT revision FROM global_revision WHERE singleton = 1').get() as { revision: number })
        .revision,
    }))
    add('GET', 'ideas', ({ query }) => ({ ideas: this.#listIdeas(query) }))
    add('POST', 'ideas', ({ body, actor }) => {
      const channel = optionalEnum(body, 'channel', ['manual', 'bot', 'agent', 'connector', 'agent_extract'] as const)
      const kind = optionalEnum(body, 'kind', ['requirement', 'bug', 'doc', 'question', 'idea'] as const)
      const title = optionalString(body, 'title')
      const projectId = optionalString(body, 'project_id')
      const sourceSystem = optionalString(body, 'source_system')
      const sourceRef = optionalString(body, 'source_ref')
      const connectorRef = optionalString(body, 'connector_ref')
      const rawRef = optionalString(body, 'raw_ref')
      const contentHash = optionalString(body, 'content_hash')
      const priority = optionalEnum(body, 'priority', ['P0', 'P1', 'P2'] as const)
      const confidence = optionalEnum(body, 'confidence', ['high', 'medium', 'low'] as const)
      const tags = optionalStringArray(body, 'tags')
      return {
        idea: this.#service.captureIdea({
          channel: channel ?? 'manual',
          content: requireString(body, 'content'),
          actor,
          ...(kind === undefined ? {} : { kind }),
          ...(title === undefined ? {} : { title }),
          ...(projectId === undefined ? {} : { projectId }),
          ...(sourceSystem === undefined ? {} : { sourceSystem }),
          ...(sourceRef === undefined ? {} : { sourceRef }),
          ...(connectorRef === undefined ? {} : { connectorRef }),
          ...(rawRef === undefined ? {} : { rawRef }),
          ...(contentHash === undefined ? {} : { contentHash }),
          ...(priority === undefined ? {} : { priority }),
          ...(confidence === undefined ? {} : { confidence }),
          ...(tags === undefined ? {} : { tags }),
        }),
      }
    })
    add('POST', 'ideas/{idea_id}/triage', ({ params, body, actor }) => {
      const kind = optionalEnum(body, 'kind', ['requirement', 'bug', 'doc', 'question', 'idea'] as const)
      const projectId = optionalString(body, 'project_id')
      const priority = optionalEnum(body, 'priority', ['P0', 'P1', 'P2'] as const)
      return {
        idea: this.#service.triageIdea({
          ideaId: params.idea_id ?? '',
          action: requireEnum(body, 'action', ['classify', 'ready', 'ignore', 'archive'] as const),
          actor,
          ...(kind === undefined ? {} : { kind }),
          ...(projectId === undefined ? {} : { projectId }),
          ...(priority === undefined ? {} : { priority }),
        }),
      }
    })
    add('POST', 'ideas/{idea_id}/confirm', ({ params, actor }) => ({
      idea: this.#service.confirmIdea({ ideaId: params.idea_id ?? '', actor }),
    }))
    add('POST', 'ideas/{idea_id}/convert', ({ params, actor }) => ({
      candidate: this.#service.convertIdea({ ideaId: params.idea_id ?? '', actor }),
    }))
    add('GET', 'proposals', ({ query }) => ({ proposals: this.#listProposals(query) }))
    add('GET', 'relations', ({ query }) => this.#listRelations(query))
    add('POST', 'relations', ({ body, actor }) => {
      this.#service.addRelation({
        taskId: requireString(body, 'task_id'),
        relationType: requireEnum(body, 'relation_type', ['parent', 'blocks', 'related'] as const),
        targetTaskId: requireString(body, 'target_task_id'),
        ifVersion: ifVersion(body),
        actor,
      })
      return { ok: true }
    })
    add('POST', 'proposals/{proposal_id}/apply', ({ params, body, actor }) => ({
      proposal: this.#service.applyDesignProposal({
        proposalId: params.proposal_id ?? '',
        ifVersion: ifVersion(body),
        actor,
      }),
    }))
    add('GET', 'search', ({ query }) => ({ tasks: this.#listTasks({ ...query, q: query.q ?? '' }) }))
    add('GET', 'graph', ({ query }) => this.#graph(requireQueryString(query, 'project_id')))
    add('GET', 'dashboard', ({ query }) => this.#dashboard(query.projectId))
    add('GET', '', ({ query }) => ({ tasks: this.#listTasks(query) }))
    add('POST', '', () => {
      throw new TaskServiceError(
        'admission_required',
        'tasks can only be created by approving a Candidate admission gate',
        { replacement_endpoint: '/api/agentops/candidates' },
        410,
      )
    })
    add('GET', 'activities', ({ query }) => ({
      activities: this.#db
        .prepare(
          `SELECT a.*, t.title AS task_title FROM task_activities a JOIN tasks t ON t.task_id = a.task_id
           ORDER BY a.created_at DESC LIMIT ?`,
        )
        .all(limitOf(query, 200)),
    }))
    add('GET', '{task_id}', ({ params }) => this.#detail(params.task_id ?? ''))
    add('PATCH', '{task_id}', ({ params, body, actor }) => {
      const patch = toTaskPatch(optionalObject(body, 'patch') ?? body)
      const task = this.#service.updateTask({
        taskId: params.task_id ?? '',
        ifVersion: ifVersion(body),
        actor,
        patch,
      })
      return { task }
    })
    add('GET', '{task_id}/transitions', ({ params }) => {
      const detail = this.#service.getTask(params.task_id ?? '')
      return { lifecycle_mode: detail.task.lifecycleMode, transitions: detail.allowed }
    })
    add('POST', '{task_id}/advance', ({ params, body, actor }) => {
      const comment = optionalString(body, 'comment')
      return {
        task: this.#service.advance({
          taskId: params.task_id ?? '',
          to: requireString(body, 'target_status'),
          ifVersion: ifVersion(body),
          actor,
          ...(comment === undefined ? {} : { comment }),
        }),
      }
    })
    add('POST', '{task_id}/claim', ({ params, body, actor }) => ({
      task: this.#service.claim({
        taskId: params.task_id ?? '',
        threadId: requireString(body, 'thread_id'),
        ifVersion: ifVersion(body),
        actor,
      }),
    }))
    add('POST', '{task_id}/rollback', ({ params, body, actor }) => {
      const targetStatus = optionalString(body, 'target_status')
      const alias = optionalEnum(body, 'alias', ['local', 'partial', 'global'] as const)
      return {
        task: this.#service.rollback({
          taskId: params.task_id ?? '',
          reason: requireString(body, 'reason'),
          ifVersion: ifVersion(body),
          actor,
          ...(targetStatus === undefined ? {} : { targetStatus }),
          ...(alias === undefined ? {} : { alias }),
        }),
      }
    })
    add('POST', '{task_id}/close', ({ params, body, actor }) => {
      const comment = optionalString(body, 'comment')
      return {
        task: this.#service.close({
          taskId: params.task_id ?? '',
          ifVersion: ifVersion(body),
          actor,
          ...(comment === undefined ? {} : { comment }),
        }),
      }
    })
    add('POST', '{task_id}/design-notes/{note_id}/status', ({ params, body, actor }) => ({
      note: this.#service.setDesignNoteStatus({
        taskId: params.task_id ?? '',
        noteId: params.note_id ?? '',
        status: requireEnum(body, 'status', ['proposed', 'implemented', 'rejected', 'archived'] as const),
        ifVersion: ifVersion(body),
        actor,
      }),
    }))
    add('POST', '{task_id}/ideas/{idea_id}/confirm', ({ params, actor }) => ({
      idea: this.#service.confirmIdea({ ideaId: params.idea_id ?? '', actor }),
    }))
    add('POST', '{task_id}/ideas/{idea_id}/convert', ({ params, actor }) => ({
      candidate: this.#service.convertIdea({ ideaId: params.idea_id ?? '', actor }),
    }))
    add('GET', '{task_id}/comments', ({ params }) => ({ comments: this.#listComments(params.task_id ?? '') }))
    add('POST', '{task_id}/comments', ({ params, body, actor }) => {
      const commentType = optionalEnum(body, 'comment_type', ['report', 'review', 'discussion'] as const)
      const decision = optionalEnum(body, 'decision', ['approve', 'request_changes'] as const)
      const rollbackTarget = optionalString(body, 'rollback_target')
      const mentions = optionalStringArray(body, 'mentions')
      return {
        comment: this.#service.addComment({
          taskId: params.task_id ?? '',
          body: requireString(body, 'body'),
          ifVersion: ifVersion(body),
          actor,
          ...(commentType === undefined ? {} : { commentType }),
          ...(decision === undefined ? {} : { decision }),
          ...(rollbackTarget === undefined ? {} : { rollbackTarget }),
          ...(mentions === undefined ? {} : { mentions }),
        }),
      }
    })
    add('GET', '{task_id}/criteria', ({ params }) => ({ criteria: this.#listCriteria(params.task_id ?? '') }))
    add('POST', '{task_id}/criteria/{criterion_id}/status', ({ params, body, actor }) => ({
      criteria: this.#service.setCriteriaStatus({
        taskId: params.task_id ?? '',
        criteriaId: params.criterion_id ?? '',
        status: requireEnum(body, 'status', ['passed', 'failed'] as const),
        ifVersion: ifVersion(body),
        actor,
      }),
    }))
    add('POST', '{task_id}/criteria', ({ params, body, actor }) => {
      const checkType = optionalEnum(body, 'check_type', ['auto', 'manual'] as const)
      return {
        criteria: this.#service.addCriteria({
          taskId: params.task_id ?? '',
          description: requireString(body, 'description'),
          ifVersion: ifVersion(body),
          actor,
          ...(checkType === undefined ? {} : { checkType }),
        }),
      }
    })
    add('GET', '{task_id}/reports', ({ params }) => ({ reports: this.#listReports(params.task_id ?? '') }))
    add('POST', '{task_id}/reports/{report_id}/export', ({ params, body }) => {
      const root = this.#exportRoot()
      const format = optionalEnum(body, 'format', ['md'] as const)
      if (body.verify_only === true) {
        return { export: verifyExport(this.#db, params.task_id ?? '', params.report_id ?? '') }
      }
      return { export: this.#writeDocument(root, params.task_id ?? '', params.report_id ?? '', format ?? 'md') }
    })
    add('GET', '{task_id}/reports/{report_id}/export', ({ params }) => {
      const taskId = params.task_id ?? ''
      const reportId = params.report_id ?? ''
      const current = verifyExport(this.#db, taskId, reportId)
      const content = current.path === null ? undefined : readReportDocument(current.path)
      if (content === undefined) {
        throw new TaskServiceError('report_not_found', 'report document is missing', { taskId, reportId }, 404)
      }
      return { export: { ...current, content } }
    })
    add('GET', '{task_id}/reports/{report_id}/exports', ({ params }) => ({
      exports: listExports(this.#db, params.task_id ?? '', params.report_id ?? ''),
    }))
    add('POST', '{task_id}/reports/{report_id}/review', ({ params, body, actor }) => ({
      report: this.#service.reviewReport({
        taskId: params.task_id ?? '',
        reportId: params.report_id ?? '',
        decision: requireEnum(body, 'decision', ['approve', 'request_changes'] as const),
        comment: requireString(body, 'comment'),
        ifVersion: ifVersion(body),
        actor,
      }),
    }))
    add('POST', '{task_id}/reports', ({ params, body, actor }) => {
      const sessionId = optionalString(body, 'session_id')
      const artifactIds = optionalStringArray(body, 'artifact_ids')
      const acceptanceSelfCheck = optionalObject(body, 'acceptance_self_check')
      return {
        report: this.#service.submitReport({
          taskId: params.task_id ?? '',
          content: requireString(body, 'content'),
          ifVersion: ifVersion(body),
          actor,
          ...(sessionId === undefined ? {} : { sessionId }),
          ...(artifactIds === undefined ? {} : { artifactIds }),
          ...(acceptanceSelfCheck === undefined ? {} : { acceptanceSelfCheck }),
        }),
      }
    })
    add('GET', '{task_id}/relations', ({ params }) => this.#relations(params.task_id ?? ''))
    add('POST', '{task_id}/relations', ({ params, body, actor }) => {
      this.#service.addRelation({
        taskId: params.task_id ?? '',
        relationType: requireEnum(body, 'relation_type', ['parent', 'blocks', 'related'] as const),
        targetTaskId: requireString(body, 'target_task_id'),
        ifVersion: ifVersion(body),
        actor,
      })
      return { ok: true }
    })
    add('GET', '{task_id}/runs', ({ params }) => ({ runs: this.#service.listRuns(params.task_id ?? '') }))
    add('GET', '{task_id}/leases', ({ params }) => ({ leases: this.#service.listLeases(params.task_id ?? '') }))
    add('POST', '{task_id}/leases/{lease_id}/heartbeat', ({ params, body, actor }) => {
      const ttl = body.ttl_ms
      return {
        lease: this.#service.heartbeatLease({
          taskId: params.task_id ?? '',
          leaseId: params.lease_id ?? '',
          leaseToken: requireString(body, 'lease_token'),
          actor,
          ...(typeof ttl === 'number' ? { ttlMs: ttl } : {}),
        }),
      }
    })
    add('POST', '{task_id}/leases/{lease_id}/release', ({ params, body, actor }) => ({
      lease: this.#service.releaseLease({
        taskId: params.task_id ?? '',
        leaseId: params.lease_id ?? '',
        leaseToken: requireString(body, 'lease_token'),
        status: requireEnum(body, 'status', ['released', 'revoked', 'expired'] as const),
        actor,
      }),
    }))
    add('POST', '{task_id}/runs/{run_id}/finish', ({ params, body, actor }) => ({
      run: this.#service.finishRun({
        taskId: params.task_id ?? '',
        linkId: params.run_id ?? '',
        status: requireEnum(body, 'status', ['succeeded', 'failed', 'canceled', 'unknown'] as const),
        actor,
      }),
    }))
    add('POST', '{task_id}/execute', ({ params, body, actor }) => {
      const role = optionalEnum(body, 'role', ['main_execution', 'validation', 'discussion'] as const)
      const idempotencyKey = optionalString(body, 'idempotency_key')
      const sessionId = optionalString(body, 'session_id')
      return {
        run: this.#service.execute({
          taskId: params.task_id ?? '',
          ifVersion: ifVersion(body),
          actor,
          ...(role === undefined ? {} : { role }),
          ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
          ...(sessionId === undefined ? {} : { sessionId }),
        }),
      }
    })
    add('GET', '{task_id}/activities', ({ params }) => ({
      activities: this.#db
        .prepare('SELECT * FROM task_activities WHERE task_id = ? ORDER BY created_at DESC')
        .all(params.task_id ?? ''),
    }))
    add('GET', '{task_id}/artifacts', ({ params }) => ({
      artifacts: this.#db.prepare('SELECT * FROM task_artifacts WHERE task_id = ?').all(params.task_id ?? ''),
    }))
    return routes
  }

  #listTasks(query: Readonly<Record<string, string | undefined>>): unknown[] {
    const tasks = this.#service.listTasks({
      ...(query.status === undefined ? {} : { status: query.status }),
      ...(query.projectId === undefined ? {} : { projectId: query.projectId }),
    })
    const q = query.q?.trim() ?? ''
    return q === ''
      ? tasks
      : tasks.filter(task => task.title.includes(q) || task.description.includes(q))
  }

  #detail(taskId: string): unknown {
    const detail = this.#service.getTask(taskId)
    const stageRows = this.#db
      .prepare('SELECT * FROM task_stages WHERE task_id = ? ORDER BY COALESCE(started_at, committed_at)')
      .all(taskId) as unknown as Record<string, unknown>[]
    const eventRows = this.#db
      .prepare('SELECT * FROM task_events WHERE task_id = ? ORDER BY created_at')
      .all(taskId) as unknown as Record<string, unknown>[]
    return {
      ...detail,
      stages: stageRows.map((row, index) => ({
        seq: index + 1,
        name: typeof row.stage_type === 'string' ? row.stage_type : 'stage',
        status: typeof row.status === 'string' ? row.status : 'pending',
        ...(typeof row.stage_output === 'string' && row.stage_output !== '' ? { note: row.stage_output } : {}),
        enteredAt: typeof row.started_at === 'string' ? row.started_at : (row.committed_at as string | null) ?? '',
      })),
      events: eventRows.map((row, index) => {
        let payload: Record<string, unknown> = {}
        try {
          payload = typeof row.payload === 'string' ? JSON.parse(row.payload) as Record<string, unknown> : {}
        } catch {
          payload = {}
        }
        const from = typeof payload.from_status === 'string' ? payload.from_status : undefined
        const to = typeof payload.to_status === 'string' ? payload.to_status : undefined
        return {
          seq: index + 1,
          kind: typeof row.event_type === 'string' ? row.event_type : 'event',
          ...(from === undefined ? {} : { fromStatus: from }),
          ...(to === undefined ? {} : { toStatus: to }),
          ...(typeof payload.reason === 'string' ? { reason: payload.reason } : {}),
          actor: typeof row.actor === 'string' ? row.actor : 'system',
          at: typeof row.created_at === 'string' ? row.created_at : '',
        }
      }),
      comments: this.#listComments(taskId),
      criteria: this.#listCriteria(taskId),
    }
  }

  #listComments(taskId: string): unknown[] {
    return this.#db.prepare('SELECT * FROM task_comments WHERE task_id = ? ORDER BY created_at').all(taskId)
  }

  #listCriteria(taskId: string): unknown[] {
    return this.#db
      .prepare('SELECT * FROM acceptance_criteria WHERE task_id = ? ORDER BY criteria_id')
      .all(taskId)
  }

  #listReports(taskId: string): unknown[] {
    return this.#db
      .prepare('SELECT * FROM task_reports WHERE task_id = ? ORDER BY submitted_at DESC')
      .all(taskId)
  }

  #exportRoot(): string {
    if (this.#exportRootDir === undefined) {
      throw new TaskServiceError('exporter_unavailable', 'report exporter is not configured', {}, 503)
    }
    return this.#exportRootDir
  }

  #writeDocument(root: string, taskId: string, reportId: string, _format: 'md'): unknown {
    try {
      return exportReportDocument(this.#db, { rootDir: root, taskId, reportId })
    } catch (error) {
      if (error instanceof Error && error.message === 'report_not_found') {
        throw new TaskServiceError('report_not_found', 'report does not belong to this task', {}, 404)
      }
      throw error
    }
  }

  #relations(taskId: string): unknown {
    const outgoing = this.#db.prepare('SELECT * FROM task_relations WHERE source_task_id = ?').all(taskId)
    const incoming = this.#db.prepare('SELECT * FROM task_relations WHERE target_task_id = ?').all(taskId)
    return { outgoing, incoming }
  }

  #graph(projectId: string): unknown {
    const nodes = this.#db.prepare(`
      SELECT t.task_id, t.title, t.status, t.risk_level, t.parent_task_id,
             t.project_id, p.name AS project_name
      FROM tasks t
      LEFT JOIN projects p ON p.project_id = t.project_id
      WHERE t.project_id = ?
    `).all(projectId)
    const edges = this.#db.prepare(`
      SELECT r.relation_type, r.source_task_id, r.target_task_id
      FROM task_relations r
      JOIN tasks s ON s.task_id = r.source_task_id
      JOIN tasks t ON t.task_id = r.target_task_id
      WHERE s.project_id = ? AND t.project_id = ?
    `).all(projectId, projectId)
    return { nodes, edges, scope: { project_id: projectId } }
  }

  #dashboard(projectId?: string): unknown {
    const where = projectId === undefined ? '' : 'WHERE project_id = ?'
    const params = projectId === undefined ? [] : [projectId]
    const byStatus = this.#db
      .prepare(`SELECT status, COUNT(*) AS count FROM tasks ${where} GROUP BY status ORDER BY status`)
      .all(...params)
    const byRisk = this.#db
      .prepare(`SELECT risk_level, COUNT(*) AS count FROM tasks ${where} GROUP BY risk_level ORDER BY risk_level`)
      .all(...params)
    return { byStatus, byRisk }
  }

  #listRelations(query: Readonly<Record<string, string | undefined>>): unknown {
    const clauses: string[] = []
    const params: string[] = []
    if (query.taskId !== undefined) {
      clauses.push('(source_task_id = ? OR target_task_id = ?)')
      params.push(query.taskId, query.taskId)
    }
    if (query.relationType !== undefined) {
      clauses.push('relation_type = ?')
      params.push(query.relationType)
    }
    const where = clauses.length === 0 ? '' : `WHERE ${clauses.join(' AND ')}`
    return { relations: this.#db.prepare(`SELECT * FROM task_relations ${where} ORDER BY created_at`).all(...params) }
  }

  #listProposals(query: Readonly<Record<string, string | undefined>>): unknown[] {
    const clauses: string[] = []
    const params: string[] = []
    if (query.taskId !== undefined) {
      clauses.push('task_id = ?')
      params.push(query.taskId)
    }
    if (query.status !== undefined) {
      clauses.push('status = ?')
      params.push(query.status)
    }
    const where = clauses.length === 0 ? '' : `WHERE ${clauses.join(' AND ')}`
    return this.#db.prepare(`SELECT * FROM doc_change_proposals ${where} ORDER BY created_at DESC`).all(...params)
  }

  #listIdeas(query: Readonly<Record<string, string | undefined>>): unknown[] {
    return this.#service.listIdeas({
      ...(query.status === undefined ? {} : { status: query.status }),
      ...(query.channel === undefined ? {} : { channel: query.channel }),
      ...(query.kind === undefined ? {} : { kind: query.kind }),
      ...(query.projectId === undefined ? {} : { projectId: query.projectId }),
      limit: 500,
    })
  }
}

/**
 * Parse one bounded list limit.
 * @param query - query parameters.
 * @param fallback - value used when the parameter is absent or invalid.
 * @returns the limit clamped to 1..500.
 */
function limitOf(query: Readonly<Record<string, string | undefined>>, fallback: number): number {
  const raw = Number(query.limit ?? fallback)
  return Math.min(Math.max(Number.isFinite(raw) ? Math.trunc(raw) : fallback, 1), 500)
}

/**
 * Match path segments against a route pattern.
 * @param pattern - route segments, `{name}` captures one segment.
 * @param actual - request segments.
 * @returns captured params, or undefined when the shape differs.
 */
function matchSegments(pattern: readonly string[], actual: readonly string[]): Record<string, string> | undefined {
  if (pattern.length !== actual.length) return undefined
  const params: Record<string, string> = {}
  for (let index = 0; index < pattern.length; index += 1) {
    const expected = pattern[index] ?? ''
    const value = actual[index] ?? ''
    if (expected.startsWith('{') && expected.endsWith('}')) {
      params[expected.slice(1, -1)] = decodeURIComponent(value)
      continue
    }
    if (expected !== value) return undefined
  }
  return params
}

/**
 * Build a 404 response.
 * @param message - reason.
 * @returns the response.
 */
function notFound(message: string): TaskHttpResponse {
  return { status: 404, body: { error: { code: 'not_found', message, details: {} } } }
}

/**
 * Map a thrown value to an error response.
 * @param error - thrown value.
 * @returns the response.
 */
function toResponse(error: unknown): TaskHttpResponse {
  if (error instanceof TaskServiceError) {
    return {
      status: error.httpStatus,
      body: { error: { code: error.code, message: error.message, details: error.details } },
    }
  }
  return {
    status: 500,
    body: { error: { code: 'internal_error', message: error instanceof Error ? error.message : String(error), details: {} } },
  }
}
