/**
 * Browser-side access to the AgentOps Agent directory.
 *
 * Catalogue and mutation responses cross the host wire boundary, so every
 * value consumed by the UI is parsed here instead of being trusted.
 *
 * @module @agentops/dsh-client/agent-catalogue-api
 */

/** Harness identifiers accepted by the Agent definition parser. */
export type ExecutionBackend = 'dsh_native' | 'codex' | 'claude_code' | 'auto'

/** Harnesses an Agent definition can run on. */
export type AgentHarness =
  | 'local_llm'
  | 'claude_sdk'
  | 'codex'
  | 'opencode'
  | 'deterministic'

/** Security tier assigned to an Agent definition. */
export type AgentTier = 'T0' | 'T1' | 'T2' | 'T3'

/**
 * How one Agent executes a task: its own skill manual, or the single workflow
 * it owns. The host parses a missing value as `skill`.
 */
export type AgentExecution = 'skill' | 'workflow'

/** Explicit model selection stored on an Agent definition. */
export interface AgentModel {
  readonly provider: string
  readonly id: string
}

/** One live model option available to the Agent editor. */
export interface AgentModelOption {
  readonly id: string
  readonly name: string
  readonly description?: string
}

/** Live models advertised by one provider route. */
export interface AgentModelProvider {
  readonly id: string
  readonly name: string
  readonly models: readonly AgentModelOption[]
}

/** Provider whose live model catalog could not be read. */
export interface AgentModelFailure {
  readonly id: string
  readonly name: string
  readonly message: string
}

/** Live provider and model catalog used by the Agent editor. */
export interface AgentModelCatalog {
  readonly providers: readonly AgentModelProvider[]
  readonly failures: readonly AgentModelFailure[]
}

/** One validation issue returned with an Agent response. */
export interface AgentValidationIssue {
  readonly path: string
  readonly message: string
  readonly kind?: string
  readonly line?: number
  readonly column?: number
  readonly nodeIds?: readonly string[]
  readonly cycle?: readonly string[]
}

/** One tool offered by the Agent permission matrix. */
export interface AgentToolCatalogEntry {
  /** Legacy tool id stored in `allowed_tools` / `denied_tools`. */
  readonly id: string
  /** Human-readable label. */
  readonly displayName: string
  /** What the tool does. */
  readonly description: string
  /** Legacy business domains the tool was restricted to. */
  readonly allowedDomains: readonly string[]
  /** Whether the legacy tool required human approval. */
  readonly requiresHumanApproval: boolean
  /** Whether a DSH equivalent exists. */
  readonly migrated: boolean
  /** Plugin package registering the DSH equivalent. */
  readonly mappedPlugin?: string
  /** Tool name inside the plugin. */
  readonly mappedTool?: string
  /** Why the tool has no DSH equivalent. */
  readonly note?: string
}

/** The tool catalogue read from the deployment's tool mapping file. */
export interface AgentToolCatalog {
  /** File the catalogue was read from. */
  readonly file: string
  /** Whether the catalogue file was missing. */
  readonly missing: boolean
  /** Tools sorted by id. */
  readonly tools: readonly AgentToolCatalogEntry[]
}

/** One catalogue row exposed by the host Agent directory. */
export interface AgentCatalogEntry {
  readonly id: string
  readonly name: string
  readonly domain: string
  readonly description: string
  readonly harness: string
  readonly executionBackend: ExecutionBackend
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

/** Agent entries plus the directory that supplied them. */
export interface AgentCatalog {
  readonly dir: string
  readonly missing: boolean
  readonly entries: readonly AgentCatalogEntry[]
}

/** Complete Agent definition used by the management editor. */
export interface AgentRecord {
  readonly agentId: string
  readonly displayName: string
  readonly domain: string
  readonly description?: string
  readonly harness: AgentHarness
  readonly executionBackend: ExecutionBackend
  readonly model: AgentModel | 'auto'
  readonly systemPrompt?: string
  readonly tier: AgentTier
  /** Execution mode; the host defaults a missing value to `skill`. */
  readonly execution: AgentExecution
  /** Workflow this Agent owns, present exactly when `execution` is `workflow`. */
  readonly workflow?: string
  readonly permissions: {
    readonly allowedTools: readonly string[]
    readonly deniedTools: readonly string[]
  }
  readonly knowledgeBases?: readonly string[]
  readonly timeoutSeconds?: number
  readonly maxConcurrentRuns?: number
  readonly costLimitPerRun?: number | null
  readonly outputFiles: Readonly<Record<string, string>>
}

/** Parsed successful mutation response. */
export interface AgentOperationResult {
  readonly value: AgentRecord
  readonly issues: readonly AgentValidationIssue[]
}

/** Confirmation returned after deleting one Agent definition. */
export interface DeletedAgent {
  readonly agentId: string
}

/** Base class for an Agent API response with an unsuccessful HTTP status. */
export class AgentApiError extends Error {
  /** HTTP status that selected this error class. */
  readonly status: number
  /** Validation issues supplied by the host, when present. */
  readonly issues: readonly AgentValidationIssue[]

  /**
   * @param status - HTTP response status.
   * @param message - actionable response failure copied from the host.
   * @param issues - field-level validation issues.
   */
  constructor(status: number, message: string, issues: readonly AgentValidationIssue[] = []) {
    super(message)
    this.name = 'AgentApiError'
    this.status = status
    this.issues = issues
  }
}

/** Request body or endpoint input was rejected with HTTP 400. */
export class AgentBadRequestError extends AgentApiError {
  /** @param message - host rejection reason. */
  constructor(message: string) {
    super(400, message)
    this.name = 'AgentBadRequestError'
  }
}

/** Agent definition does not exist, reported with HTTP 404. */
export class AgentNotFoundError extends AgentApiError {
  /** @param message - host rejection reason. */
  constructor(message: string) {
    super(404, message)
    this.name = 'AgentNotFoundError'
  }
}

/** Agent definition already exists, reported with HTTP 409. */
export class AgentConflictError extends AgentApiError {
  /** @param message - host rejection reason. */
  constructor(message: string) {
    super(409, message)
    this.name = 'AgentConflictError'
  }
}

/** Agent definition failed field validation, reported with HTTP 422. */
export class AgentValidationError extends AgentApiError {
  /**
   * @param message - host rejection reason.
   * @param issues - field-level validation issues.
   */
  constructor(message: string, issues: readonly AgentValidationIssue[]) {
    super(422, message, issues)
    this.name = 'AgentValidationError'
  }
}

/**
 * Parse one live provider group from the host response.
 * @param value - untrusted provider response value.
 * @returns the validated provider group.
 */
function parseModelProvider(value: unknown): AgentModelProvider {
  if (!isRecord(value) || !Array.isArray(value.models)) {
    throw new Error('invalid agent model response: provider')
  }
  return {
    id: requiredString(value, 'id'),
    name: requiredString(value, 'name'),
    models: value.models.map((model) => {
      if (!isRecord(model)) throw new Error('invalid agent model response: model')
      const description = optionalString(model, 'description')
      return {
        id: requiredString(model, 'id'),
        name: requiredString(model, 'name'),
        ...(description === undefined ? {} : { description }),
      }
    }),
  }
}

/**
 * Parse one provider failure from the host response.
 * @param value - untrusted failure response value.
 * @returns the validated provider failure.
 */
function parseModelFailure(value: unknown): AgentModelFailure {
  if (!isRecord(value)) throw new Error('invalid agent model response: failure')
  return {
    id: requiredString(value, 'id'),
    name: requiredString(value, 'name'),
    message: requiredString(value, 'message'),
  }
}

/** Agent storage failed, reported with HTTP 500. */
export class AgentServerError extends AgentApiError {
  /** @param message - host rejection reason. */
  constructor(message: string) {
    super(500, message)
    this.name = 'AgentServerError'
  }
}

/** A supposedly successful response did not match the Agent wire format. */
export class AgentResponseError extends AgentApiError {
  /**
   * @param status - HTTP response status.
   * @param message - response validation failure.
   * @param cause - JSON parse failure, when applicable.
   */
  constructor(status: number, message: string, cause?: unknown) {
    super(status, message)
    this.name = 'AgentResponseError'
    if (cause !== undefined) this.cause = cause
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string')
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key]
  if (typeof value !== 'string') throw new Error(`invalid agent response: ${key}`)
  return value
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new Error(`invalid agent response: ${key}`)
  return value
}

function optionalNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key]
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`invalid agent response: ${key}`)
  }
  return value
}

function stringRecord(value: unknown, field: string): Readonly<Record<string, string>> {
  if (!isRecord(value)) throw new Error(`invalid agent response: ${field}`)
  const result: Record<string, string> = {}
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== 'string') throw new Error(`invalid agent response: ${field}.${key}`)
    result[key] = item
  }
  return result
}

function parseModel(value: unknown): AgentModel | 'auto' {
  if (value === 'auto') return 'auto'
  if (!isRecord(value)) throw new Error('invalid agent response: model')
  return {
    provider: requiredString(value, 'provider'),
    id: requiredString(value, 'id'),
  }
}

function parseExecutionBackend(value: unknown): ExecutionBackend {
  if (value === 'dsh_native' || value === 'codex' || value === 'claude_code' || value === 'auto') return value
  return 'auto'
}

function parseHarness(value: unknown): AgentHarness {
  if (value === 'local_llm' || value === 'claude_sdk' || value === 'codex'
    || value === 'opencode' || value === 'deterministic') {
    return value
  }
  throw new Error('invalid agent response: harness')
}

function parseTier(value: unknown): AgentTier {
  if (value === 'T0' || value === 'T1' || value === 'T2' || value === 'T3') return value
  throw new Error('invalid agent response: tier')
}

function parseIssues(value: unknown): readonly AgentValidationIssue[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error('invalid agent response: issues')
  return value.map((issue) => {
    if (!isRecord(issue)) throw new Error('invalid agent response: issue')
    const kind = optionalString(issue, 'kind')
    const line = optionalNumber(issue, 'line')
    const column = optionalNumber(issue, 'column')
    if (issue.nodeIds !== undefined && !isStringArray(issue.nodeIds)) {
      throw new Error('invalid agent response: issue.nodeIds')
    }
    if (issue.cycle !== undefined && !isStringArray(issue.cycle)) {
      throw new Error('invalid agent response: issue.cycle')
    }
    return {
      path: requiredString(issue, 'path'),
      message: requiredString(issue, 'message'),
      ...(kind === undefined ? {} : { kind }),
      ...(line === undefined ? {} : { line }),
      ...(column === undefined ? {} : { column }),
      ...(issue.nodeIds === undefined ? {} : { nodeIds: issue.nodeIds }),
      ...(issue.cycle === undefined ? {} : { cycle: issue.cycle }),
    }
  })
}

function parseAgentRecord(value: unknown): AgentRecord {
  if (!isRecord(value)) throw new Error('invalid agent response: value')
  const permissions = value.permissions
  if (!isRecord(permissions)) throw new Error('invalid agent response: permissions')
  if (!isStringArray(permissions.allowedTools) || !isStringArray(permissions.deniedTools)) {
    throw new Error('invalid agent response: permissions')
  }
  const knowledgeBases = value.knowledgeBases
  if (knowledgeBases !== undefined && !isStringArray(knowledgeBases)) {
    throw new Error('invalid agent response: knowledgeBases')
  }
  const cost = value.costLimitPerRun
  if (cost !== undefined && cost !== null && typeof cost !== 'number') {
    throw new Error('invalid agent response: costLimitPerRun')
  }
  const description = optionalString(value, 'description')
  const systemPrompt = optionalString(value, 'systemPrompt')
  const executionRaw = value.execution
  if (executionRaw !== undefined && executionRaw !== 'skill' && executionRaw !== 'workflow') {
    throw new Error('invalid agent response: execution')
  }
  const execution: AgentExecution = executionRaw === 'workflow' ? 'workflow' : 'skill'
  const workflow = optionalString(value, 'workflow')
  const timeoutSeconds = optionalNumber(value, 'timeoutSeconds')
  const maxConcurrentRuns = optionalNumber(value, 'maxConcurrentRuns')
  return {
    agentId: requiredString(value, 'agentId'),
    displayName: requiredString(value, 'displayName'),
    domain: requiredString(value, 'domain'),
    ...(description === undefined ? {} : { description }),
    harness: parseHarness(value.harness),
    executionBackend: parseExecutionBackend(value.executionBackend ?? value.execution_backend),
    model: parseModel(value.model),
    ...(systemPrompt === undefined ? {} : { systemPrompt }),
    tier: parseTier(value.tier),
    execution,
    ...(workflow === undefined ? {} : { workflow }),
    permissions: {
      allowedTools: permissions.allowedTools,
      deniedTools: permissions.deniedTools,
    },
    ...(knowledgeBases === undefined ? {} : { knowledgeBases }),
    ...(timeoutSeconds === undefined ? {} : { timeoutSeconds }),
    ...(maxConcurrentRuns === undefined ? {} : { maxConcurrentRuns }),
    ...(cost === undefined ? {} : { costLimitPerRun: cost }),
    outputFiles: stringRecord(value.outputFiles, 'outputFiles'),
  }
}

function parseEntry(value: unknown): AgentCatalogEntry {
  if (
    !isRecord(value)
    || typeof value.id !== 'string'
    || typeof value.name !== 'string'
    || typeof value.domain !== 'string'
    || typeof value.description !== 'string'
    || typeof value.harness !== 'string'
    || typeof value.model !== 'string'
    || value.source !== 'yaml'
    || !isStringArray(value.allowed_tools)
    || !isStringArray(value.denied_tools)
    || !isStringArray(value.knowledge_bases)
    || typeof value.timeout_seconds !== 'number'
    || typeof value.max_concurrent_runs !== 'number'
    || (typeof value.cost_limit_per_run !== 'number' && value.cost_limit_per_run !== null)
    || typeof value.file_name !== 'string'
    || typeof value.valid !== 'boolean'
    || !isStringArray(value.issues)
  ) {
    throw new AgentResponseError(200, 'invalid agent catalog response')
  }
  return {
    id: value.id,
    name: value.name,
    domain: value.domain,
    description: value.description,
    harness: value.harness,
    executionBackend: parseExecutionBackend(value.executionBackend ?? value.execution_backend),
    model: value.model,
    source: 'yaml',
    allowed_tools: value.allowed_tools,
    denied_tools: value.denied_tools,
    knowledge_bases: value.knowledge_bases,
    timeout_seconds: value.timeout_seconds,
    max_concurrent_runs: value.max_concurrent_runs,
    cost_limit_per_run: value.cost_limit_per_run,
    file_name: value.file_name,
    valid: value.valid,
    issues: value.issues,
  }
}

function responseMessage(payload: unknown, fallback: string): string {
  return isRecord(payload) && typeof payload.message === 'string' ? payload.message : fallback
}

function responseIssues(payload: unknown): readonly AgentValidationIssue[] {
  if (!isRecord(payload) || payload.issues === undefined) return []
  try {
    return parseIssues(payload.issues)
  } catch {
    return []
  }
}

function statusError(status: number, payload: unknown): AgentApiError {
  const message = responseMessage(payload, `agent request failed with HTTP ${status}`)
  const issues = responseIssues(payload)
  switch (status) {
    case 400:
      return new AgentBadRequestError(message)
    case 404:
      return new AgentNotFoundError(message)
    case 409:
      return new AgentConflictError(message)
    case 422:
      return new AgentValidationError(message, issues)
    case 500:
      return new AgentServerError(message)
    default:
      return new AgentApiError(status, message, issues)
  }
}

async function requestJson(
  fetchImpl: typeof fetch,
  path: string,
  init: RequestInit,
): Promise<{ readonly payload: unknown; readonly status: number }> {
  const response = await fetchImpl(path, init)
  let payload: unknown
  try {
    payload = await response.json()
  } catch (reason) {
    if (!response.ok) throw statusError(response.status, null)
    throw new AgentResponseError(response.status, `invalid agent response (HTTP ${response.status})`, reason)
  }
  if (!response.ok) throw statusError(response.status, payload)
  return { payload, status: response.status }
}

function postBody(body: unknown): RequestInit {
  return {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }
}

function parseOperation(payload: unknown, status: number): AgentOperationResult {
  if (!isRecord(payload) || payload.ok !== true) {
    throw new AgentResponseError(status, 'invalid agent operation response')
  }
  try {
    return {
      value: parseAgentRecord(payload.value),
      issues: parseIssues(payload.issues),
    }
  } catch (reason) {
    throw new AgentResponseError(status, 'invalid agent operation response', reason)
  }
}

/**
 * Load the live provider and model catalog for explicit Agent model selection.
 * @param fetchImpl - fetch implementation, injectable for tests.
 * @returns validated providers and isolated provider failures.
 */
export async function loadAgentModelCatalog(
  fetchImpl: typeof fetch = fetch,
): Promise<AgentModelCatalog> {
  const { payload, status } = await requestJson(fetchImpl, '/api/agentops/models', {
    credentials: 'include',
  })
  if (!isRecord(payload) || !Array.isArray(payload.providers) || !Array.isArray(payload.failures)) {
    throw new AgentResponseError(status, 'invalid agent model catalog response')
  }
  try {
    return {
      providers: payload.providers.map(parseModelProvider),
      failures: payload.failures.map(parseModelFailure),
    }
  } catch (reason) {
    if (reason instanceof AgentResponseError) throw reason
    throw new AgentResponseError(status, 'invalid agent model catalog response', reason)
  }
}

/**
 * Load the Agent definitions used by the workflow node library.
 * @param fetchImpl - fetch implementation, injectable for tests.
 * @returns the parsed Agent catalogue.
 */
export async function loadAgentCatalog(
  fetchImpl: typeof fetch = fetch,
): Promise<AgentCatalog> {
  const { payload, status } = await requestJson(fetchImpl, '/api/agentops/agents', {
    credentials: 'include',
  })
  if (
    !isRecord(payload)
    || typeof payload.dir !== 'string'
    || typeof payload.missing !== 'boolean'
    || !Array.isArray(payload.entries)
  ) {
    throw new AgentResponseError(status, 'invalid agent catalog response')
  }
  try {
    return {
      dir: payload.dir,
      missing: payload.missing,
      entries: payload.entries.map(parseEntry),
    }
  } catch (reason) {
    if (reason instanceof AgentResponseError) throw reason
    throw new AgentResponseError(status, 'invalid agent catalog response', reason)
  }
}

/**
 * Load the tool catalogue shown by the Agent permission matrix.
 * @param fetchImpl - fetch implementation, injectable for tests.
 * @returns the parsed tool catalogue.
 */
export async function loadAgentToolCatalog(
  fetchImpl: typeof fetch = fetch,
): Promise<AgentToolCatalog> {
  const { payload, status } = await requestJson(fetchImpl, '/api/agentops/tools', {
    credentials: 'include',
  })
  if (!isRecord(payload) || typeof payload.file !== 'string' || typeof payload.missing !== 'boolean'
    || !Array.isArray(payload.tools)) {
    throw new AgentResponseError(status, 'invalid agent tool catalog response')
  }
  try {
    return {
      file: payload.file,
      missing: payload.missing,
      tools: payload.tools.map(parseToolCatalogEntry),
    }
  } catch (reason) {
    if (reason instanceof AgentResponseError) throw reason
    throw new AgentResponseError(status, 'invalid agent tool catalog response', reason)
  }
}

function parseToolCatalogEntry(value: unknown): AgentToolCatalogEntry {
  if (
    !isRecord(value)
    || typeof value.id !== 'string'
    || typeof value.displayName !== 'string'
    || typeof value.description !== 'string'
    || !isStringArray(value.allowedDomains)
    || typeof value.requiresHumanApproval !== 'boolean'
    || typeof value.migrated !== 'boolean'
  ) {
    throw new AgentResponseError(200, 'invalid agent tool catalog response')
  }
  const plugin = typeof value.mappedPlugin === 'string' ? value.mappedPlugin : undefined
  const tool = typeof value.mappedTool === 'string' ? value.mappedTool : undefined
  const note = typeof value.note === 'string' ? value.note : undefined
  return {
    id: value.id,
    displayName: value.displayName,
    description: value.description,
    allowedDomains: value.allowedDomains,
    requiresHumanApproval: value.requiresHumanApproval,
    migrated: value.migrated,
    ...(plugin === undefined ? {} : { mappedPlugin: plugin }),
    ...(tool === undefined ? {} : { mappedTool: tool }),
    ...(note === undefined ? {} : { note }),
  }
}

/**
 * Load one complete Agent definition.
 * @param fetchImpl - fetch implementation, injectable for tests.
 * @param agentId - safe Agent identifier.
 * @returns the parsed Agent definition and non-fatal issues.
 */
export async function loadAgent(
  fetchImpl: typeof fetch,
  agentId: string,
): Promise<AgentOperationResult> {
  const { payload, status } = await requestJson(
    fetchImpl,
    '/api/agentops/agents/detail',
    postBody({ agentId }),
  )
  return parseOperation(payload, status)
}

/**
 * Create one Agent definition.
 * @param fetchImpl - fetch implementation, injectable for tests.
 * @param input - complete Agent definition in API camelCase fields.
 * @returns the persisted Agent definition.
 */
export async function createAgent(
  fetchImpl: typeof fetch,
  input: AgentRecord,
): Promise<AgentOperationResult> {
  const { payload, status } = await requestJson(
    fetchImpl,
    '/api/agentops/agents/create',
    postBody(input),
  )
  return parseOperation(payload, status)
}

/**
 * Replace one existing Agent definition.
 * @param fetchImpl - fetch implementation, injectable for tests.
 * @param input - complete Agent definition in API camelCase fields.
 * @returns the persisted Agent definition.
 */
export async function updateAgent(
  fetchImpl: typeof fetch,
  input: AgentRecord,
): Promise<AgentOperationResult> {
  const { payload, status } = await requestJson(
    fetchImpl,
    '/api/agentops/agents/update',
    postBody(input),
  )
  return parseOperation(payload, status)
}

/**
 * Delete one Agent definition.
 * @param fetchImpl - fetch implementation, injectable for tests.
 * @param agentId - safe Agent identifier.
 * @returns the deleted Agent identifier.
 */
export async function removeAgent(
  fetchImpl: typeof fetch,
  agentId: string,
): Promise<DeletedAgent> {
  const { payload, status } = await requestJson(
    fetchImpl,
    '/api/agentops/agents/delete',
    postBody({ agentId }),
  )
  if (
    !isRecord(payload)
    || payload.ok !== true
    || !isRecord(payload.value)
    || typeof payload.value.agentId !== 'string'
  ) {
    throw new AgentResponseError(status, 'invalid agent delete response')
  }
  return { agentId: payload.value.agentId }
}
