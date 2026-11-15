/**
 * Agent definitions stored as YAML under the AgentOps agents directory.
 *
 * Reads and writes cross a durable-file boundary. Every write is parsed by the
 * shared contracts package, serialized from the parsed value, and published
 * with a same-directory temporary file before the target is replaced.
 *
 * @module @agentops/dsh-host/agents
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

import {
  isSafeAgentId,
  loadAgentDefinition,
  parseAgentDefinition,
  serializeAgentDefinition,
  type AgentDefinition,
  type ValidationIssue,
} from '@agentops/dsh-contracts'

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'

/** Catalogue row consumed by the workflow node library and the Agent page. */
export interface AgentSummary {
  readonly id: string
  readonly name: string
  readonly domain: string
  readonly description: string
  readonly harness: string
  readonly execution_backend: string
  readonly execution: 'skill' | 'workflow'
  readonly workflow: string
  readonly model: string
  readonly source: 'yaml'
  readonly allowed_tools: readonly string[]
  readonly denied_tools: readonly string[]
  readonly knowledge_bases: readonly string[]
  readonly timeout_seconds: number
  readonly max_concurrent_runs: number
  readonly cost_limit_per_run: number | null
  readonly file_name: string
  readonly valid: boolean
  readonly issues: readonly string[]
}

/** A directory scan result. A missing directory is an empty, valid catalogue. */
export interface AgentCatalogScan {
  readonly dir: string
  readonly entries: readonly AgentSummary[]
  readonly missing: boolean
}

/** Stable failure classes for Agent catalogue operations. */
export type AgentFailureCode = 'not_found' | 'invalid' | 'exists' | 'io'

/** Failure returned by an Agent catalogue operation. */
export interface AgentFailure {
  readonly ok: false
  readonly code: AgentFailureCode
  readonly issues: readonly ValidationIssue[]
  readonly message: string
}

/** Typed result from an Agent catalogue operation. */
export type AgentOperationResult<T> =
  | { readonly ok: true; readonly value: T; readonly issues: readonly ValidationIssue[] }
  | AgentFailure

/** Confirmation returned after deleting one Agent definition. */
export interface DeletedAgent {
  readonly agentId: string
}

/**
 * Scan one agents directory.
 *
 * A missing directory yields an empty catalogue. Invalid YAML remains visible
 * as an entry with `valid: false` instead of disappearing from the page.
 * @param dir - directory holding `*.yaml` Agent definitions.
 * @returns catalogue rows and whether the directory exists.
 */
export function scanAgents(dir: string): AgentCatalogScan {
  let files: string[]
  try {
    files = readdirSync(dir).filter(name => name.endsWith('.yaml')).sort()
  } catch {
    return { dir, entries: [], missing: true }
  }

  const entries = files.map((fileName) => {
    let source: string
    try {
      source = readFileSync(join(dir, fileName), 'utf8')
    } catch {
      return invalidSummary(fileName, ['无法读取 Agent 文件'])
    }
    const parsed = loadAgentDefinition(source)
    if (!parsed.ok) return invalidSummary(fileName, parsed.issues.map(issue => issue.message))
    return summaryOf(parsed.value, fileName, parsed.issues)
  })
  return { dir, entries, missing: false }
}

/**
 * Read one Agent definition by id.
 * @param dir - directory holding `*.yaml` Agent definitions.
 * @param agentId - file stem and Agent id.
 * @returns the complete parsed definition or a typed failure.
 */
export function readAgent(dir: string, agentId: string): AgentOperationResult<AgentDefinition> {
  if (!isSafeAgentId(agentId)) return invalidAgentId()

  let source: string
  try {
    source = readFileSync(agentPath(dir, agentId), 'utf8')
  } catch (reason) {
    if (isErrno(reason, 'ENOENT')) return failure('not_found', `Agent ${agentId} 不存在`)
    return failure('io', `无法读取 Agent ${agentId}`)
  }

  const parsed = loadAgentDefinition(source)
  if (!parsed.ok) return failure('invalid', `Agent ${agentId} 定义无效`, parsed.issues)
  if (parsed.value.agentId !== agentId) {
    return failure('invalid', `Agent 文件 ${agentId}.yaml 的 agent_id 与文件名不一致`, [{
      path: 'agent_id',
      message: `期望 ${agentId}，实际为 ${parsed.value.agentId}`,
    }])
  }
  return { ok: true, value: parsed.value, issues: parsed.issues }
}

/**
 * Create one Agent definition without replacing an existing file.
 * @param dir - directory holding `*.yaml` Agent definitions.
 * @param input - parsed YAML or API body to validate.
 * @returns the serialized definition after the atomic publish.
 */
export function createAgent(dir: string, input: unknown): AgentOperationResult<AgentDefinition> {
  const parsed = parseAgentDefinition(input)
  if (!parsed.ok) return failure('invalid', 'Agent 定义无效', parsed.issues)
  if (!isSafeAgentId(parsed.value.agentId)) return invalidAgentId()

  const path = agentPath(dir, parsed.value.agentId)
  if (existsSync(path)) return failure('exists', `Agent ${parsed.value.agentId} 已存在`)
  try {
    mkdirSync(dir, { recursive: true })
    writeAtomically(path, serializeAgentDefinition(parsed.value))
  } catch (reason) {
    if (isErrno(reason, 'EEXIST')) return failure('exists', `Agent ${parsed.value.agentId} 已存在`)
    return failure('io', `无法创建 Agent ${parsed.value.agentId}`)
  }
  return { ok: true, value: parsed.value, issues: parsed.issues }
}

/**
 * Replace one existing Agent definition.
 * @param dir - directory holding `*.yaml` Agent definitions.
 * @param input - parsed YAML or API body to validate.
 * @returns the serialized definition after the atomic publish.
 */
export function updateAgent(dir: string, input: unknown): AgentOperationResult<AgentDefinition> {
  const parsed = parseAgentDefinition(input)
  if (!parsed.ok) return failure('invalid', 'Agent 定义无效', parsed.issues)
  if (!isSafeAgentId(parsed.value.agentId)) return invalidAgentId()

  const path = agentPath(dir, parsed.value.agentId)
  if (!existsSync(path)) return failure('not_found', `Agent ${parsed.value.agentId} 不存在`)

  // A caller that sends neither field predates workflow ownership. Accepting it
  // would write `execution: skill` over a workflow Agent and orphan its
  // workflow, so the loss has to be explicit instead of silent.
  const declaredOwnership = isRecord(input)
    && (input.execution !== undefined || input.workflow !== undefined)
  const stored = readAgent(dir, parsed.value.agentId)
  if (!declaredOwnership && stored.ok && stored.value.workflow !== undefined) {
    return failure(
      'invalid',
      `Agent ${parsed.value.agentId} 拥有工作流 ${stored.value.workflow}，更新时必须显式声明 execution 与 workflow`,
      [{ path: 'execution', message: '缺少 execution：拒绝把工作流型 Agent 静默降级为 skill' }],
    )
  }

  try {
    writeAtomically(path, serializeAgentDefinition(parsed.value))
  } catch {
    return failure('io', `无法更新 Agent ${parsed.value.agentId}`)
  }
  return { ok: true, value: parsed.value, issues: parsed.issues }
}

/**
 * Delete one Agent definition.
 * @param dir - directory holding `*.yaml` Agent definitions.
 * @param agentId - file stem and Agent id.
 * @returns the deleted id or a typed failure.
 */
export function deleteAgent(dir: string, agentId: string): AgentOperationResult<DeletedAgent> {
  if (!isSafeAgentId(agentId)) return invalidAgentId()
  try {
    unlinkSync(agentPath(dir, agentId))
  } catch (reason) {
    if (isErrno(reason, 'ENOENT')) return failure('not_found', `Agent ${agentId} 不存在`)
    return failure('io', `无法删除 Agent ${agentId}`)
  }
  return { ok: true, value: { agentId }, issues: [] }
}

/**
 * Register the Agent catalogue and mutation routes.
 *
 * Writes use exact paths because the client connection route table does not
 * accept path parameters or PUT/DELETE.
 * @param ctx - context carrying Connection.
 * @param dir - agents directory (config or `AGENTOPS_AGENT_DIR`).
 */
export function registerAgentsRoute(ctx: Context, dir: string): void {
  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/agentops/agents',
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async () => json(scanAgents(dir)),
  }), 'agentops-system: GET /api/agentops/agents')

  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/agentops/agents/detail',
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const body = await requestRecord(request)
      if (body === null || typeof body.agentId !== 'string') return badRequest('agentId is required')
      return resultResponse(readAgent(dir, body.agentId))
    },
  }), 'agentops-system: POST /api/agentops/agents/detail')

  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/agentops/agents/create',
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const body = await requestRecord(request)
      if (body === null) return badRequest('Agent definition is required')
      return resultResponse(createAgent(dir, body))
    },
  }), 'agentops-system: POST /api/agentops/agents/create')

  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/agentops/agents/update',
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const body = await requestRecord(request)
      if (body === null) return badRequest('Agent definition is required')
      return resultResponse(updateAgent(dir, body))
    },
  }), 'agentops-system: POST /api/agentops/agents/update')

  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/agentops/agents/delete',
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const body = await requestRecord(request)
      if (body === null || typeof body.agentId !== 'string') return badRequest('agentId is required')
      return resultResponse(deleteAgent(dir, body.agentId))
    },
  }), 'agentops-system: POST /api/agentops/agents/delete')
}

function agentPath(dir: string, agentId: string): string {
  return join(dir, `${agentId}.yaml`)
}

function invalidAgentId(): AgentFailure {
  return failure('invalid', 'agentId 不安全', [{
    path: 'agent_id',
    message: 'agent_id 只能包含字母、数字、下划线或连字符，且必须以字母或数字开头',
  }])
}

function writeAtomically(path: string, source: string): void {
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`)
  try {
    writeFileSync(temporary, source, { encoding: 'utf8', flag: 'wx' })
    renameSync(temporary, path)
  } catch (reason) {
    rmSync(temporary, { force: true })
    throw reason
  }
}

function summaryOf(
  definition: AgentDefinition,
  fileName: string,
  issues: readonly ValidationIssue[],
): AgentSummary {
  return {
    id: definition.agentId,
    name: definition.displayName,
    domain: definition.domain,
    description: definition.description ?? '',
    harness: definition.harness,
    execution_backend: definition.executionBackend,
    execution: definition.execution,
    workflow: definition.workflow ?? '',
    model: definition.model === 'auto' ? 'auto' : `${definition.model.provider}/${definition.model.id}`,
    source: 'yaml',
    allowed_tools: definition.permissions.allowedTools,
    denied_tools: definition.permissions.deniedTools,
    knowledge_bases: definition.knowledgeBases ?? [],
    timeout_seconds: definition.timeoutSeconds ?? 0,
    max_concurrent_runs: definition.maxConcurrentRuns ?? 0,
    cost_limit_per_run: definition.costLimitPerRun ?? null,
    file_name: fileName,
    valid: true,
    issues: issues.map(issue => issue.message),
  }
}

function invalidSummary(fileName: string, issues: readonly string[]): AgentSummary {
  const id = fileName.replace(/\.yaml$/, '')
  return {
    id,
    name: id,
    domain: '',
    description: '',
    harness: '',
    execution_backend: 'auto',
    execution: 'skill',
    workflow: '',
    model: '',
    source: 'yaml',
    allowed_tools: [],
    denied_tools: [],
    knowledge_bases: [],
    timeout_seconds: 0,
    max_concurrent_runs: 0,
    cost_limit_per_run: null,
    file_name: fileName,
    valid: false,
    issues,
  }
}

function failure(
  code: AgentFailureCode,
  message: string,
  issues: readonly ValidationIssue[] = [],
): AgentFailure {
  return { ok: false, code, message, issues }
}

function resultResponse(result: AgentOperationResult<unknown>): Response {
  if (result.ok) return json(result)
  const status = result.code === 'invalid'
    ? 422
    : result.code === 'not_found'
      ? 404
      : result.code === 'exists'
        ? 409
        : 500
  return json(result, status)
}

function badRequest(message: string): Response {
  return json({ ok: false, code: 'invalid', message, issues: [] }, 400)
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}

async function requestRecord(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = await request.json()
    return isRecord(parsed) ? parsed : null
  } catch (_malformed) {
    // The caller reports malformed and non-object bodies as a bad request.
    return null
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isErrno(reason: unknown, code: string): boolean {
  return reason instanceof Error && 'code' in reason && reason.code === code
}
