/**
 * Browser-side requests for the workflow YAML editor.
 *
 * The HTTP responses are parsed at this boundary because a browser fetch
 * result is untrusted wire data.
 *
 * @module @agentops/dsh-client/workflow-editor-api
 */

/** One validation problem returned by the host. */
export interface WorkflowIssue {
  readonly path: string
  readonly message: string
  readonly kind?: string
  readonly line?: number
  readonly column?: number
  readonly nodeIds?: readonly string[]
  readonly cycle?: readonly string[]
}

/** Exact source text and its compare-and-swap digest. */
export interface WorkflowSource {
  readonly text: string
  readonly digest: string
}

/** Node kinds emitted by the workflow YAML loader. */
export type WorkflowNodeType =
  | 'agent'
  | 'command'
  | 'await_command'
  | 'gateway'
  | 'parallel_branch'
  | 'while'

/** Backward-compatible name for the compact catalogue node kind. */
export type WorkflowSummaryNodeType = WorkflowNodeType

/** A compact node in a catalogue summary. */
export interface WorkflowSummaryNode {
  readonly id: string
  readonly level: number
  readonly type: WorkflowSummaryNodeType
  readonly agentRef?: string
  readonly displayName?: string
  readonly businessRole?: string
}

/** An agent definition embedded in a workflow node. */
export interface WorkflowInlineAgent {
  readonly rolePrompt: string
  readonly harness?: string
  readonly model?: string | { readonly provider: string; readonly id: string }
  readonly domain?: string
  readonly allowedTools?: readonly string[]
  readonly deniedTools?: readonly string[]
  readonly timeoutSeconds?: number
}

/** Configuration loaded for an `await_command` node. */
export interface WorkflowAwaitCommandConfig {
  readonly targetActors: readonly string[]
  readonly commandPort: string
  readonly expirySeconds: number
  readonly maxCommands: number
}

/** A node in the most recent recoverable validation graph. */
export interface WorkflowGraphNode {
  readonly id: string
  readonly level: number
  readonly type?: WorkflowNodeType
  readonly displayName?: string
  readonly businessRole?: string
  readonly agentRef?: string
  readonly inlineAgent?: WorkflowInlineAgent
  readonly rolePrompt: string
  readonly harness?: string
  readonly model?: string | { readonly provider: string; readonly id: string }
  readonly after: readonly string[]
  readonly inputs: readonly string[]
  readonly outputs: Readonly<Record<string, readonly string[]>>
  readonly timeoutMs?: number
  readonly condition?: string
  readonly branches?: readonly string[]
  readonly body?: readonly string[]
  readonly continueIf?: string
  readonly maxIterations?: number
  readonly skipIf?: string
  readonly joinStrategy?: string
  readonly cancelOnFirstFail?: boolean
  readonly gatewayKind?: string
  readonly commandConfig?: Readonly<Record<string, unknown>>
  readonly awaitCommandConfig?: WorkflowAwaitCommandConfig
  readonly whileConfig?: Readonly<Record<string, unknown>>
  readonly rawFields?: Readonly<Record<string, unknown>>
}

/** A scheduling edge in the most recent successful validation graph. */
export interface WorkflowGraphEdge {
  readonly from: string
  readonly to: string
}

/** One data dependency in the most recent successful validation graph. */
export interface WorkflowDataEdge {
  readonly from: string
  readonly to: string
  readonly port: string
}

/** Generated source and facts from the most recent successful compilation. */
export interface WorkflowCompiledArtifact {
  readonly source: string
  readonly layers: readonly (readonly string[])[]
  readonly digest: string
}

/** Value type accepted by one workflow run input. */
export type WorkflowRunInputType = 'string' | 'integer' | 'number' | 'boolean' | 'array'

/** One top-level workflow input declared by the YAML source. */
export interface WorkflowRunInputDefinition {
  readonly name: string
  readonly type: WorkflowRunInputType
  readonly required: boolean
  readonly description?: string
  readonly defaultValue?: unknown
}

/** Input declarations and the stable instruction for one workflow run. */
export interface WorkflowRunHint {
  readonly workflowId: string
  readonly prompt: string
  readonly reason: string
  readonly inputs: readonly WorkflowRunInputDefinition[]
}

/** One workflow entry in the catalogue response. */
export interface WorkflowSummary {
  readonly id: string
  readonly file: string
  readonly name: string
  readonly nodeCount: number
  readonly levelCount: number
  readonly ok: boolean
  readonly errors: readonly string[]
  readonly status: 'verified' | 'invalid'
  readonly inputs: readonly WorkflowRunInputDefinition[]
  readonly nodes: readonly WorkflowSummaryNode[]
  readonly edges: readonly WorkflowGraphEdge[]
  /** Source-file modification time when the host could read it. */
  readonly updatedAt?: string
}

/** Workflow catalogue plus the directory that supplied it. */
export interface WorkflowCatalog {
  readonly dir: string
  readonly entries: readonly WorkflowSummary[]
  readonly missing: boolean
}

/** Result of asking the host to start one workflow. */
export type WorkflowRunResult =
  | { readonly ok: true; readonly sessionId: string; readonly workflowId: string }
  | { readonly ok: false; readonly reason: string; readonly sessionId?: string }

/** Recoverable graph content returned for both successful and rejected drafts. */
export interface WorkflowGraphPayload {
  readonly issues: readonly WorkflowIssue[]
  readonly nodes?: readonly WorkflowGraphNode[]
  readonly edges?: readonly WorkflowGraphEdge[]
  readonly dataEdges?: readonly WorkflowDataEdge[]
  readonly compiled?: WorkflowCompiledArtifact
  readonly compileIssues?: readonly WorkflowIssue[]
}

/** Result of validating a draft without writing it. */
export type WorkflowValidationResult = WorkflowGraphPayload & { readonly ok: boolean }

/** Result of a compare-and-swap save. */
export type WorkflowSaveResult =
  | { readonly kind: 'saved'; readonly digest: string }
  | { readonly kind: 'conflict'; readonly actualDigest: string }
  | { readonly kind: 'invalid'; readonly issues: readonly WorkflowIssue[] }

/** Result of creating a workflow without overwriting an existing file. */
export type WorkflowCreateResult =
  | { readonly kind: 'created'; readonly digest: string }
  | { readonly kind: 'conflict' }
  | { readonly kind: 'invalid'; readonly issues: readonly WorkflowIssue[] }

/** One source-only operation supported by the workflow editor. */
export type WorkflowEditOperation =
  | {
    readonly kind: 'add-node'
    readonly id: string
    readonly agent: string
    readonly rolePrompt: string
  }
  | {
    readonly kind: 'add-node'
    readonly id: string
    readonly type: 'command'
    readonly cliTemplate: string
  }
  | {
    readonly kind: 'add-node'
    readonly id: string
    readonly type: 'await_command'
    readonly targetActors: readonly string[]
    readonly commandPort: string
    readonly expirySeconds: number
    readonly maxCommands: number
  }
  | {
    readonly kind: 'add-node'
    readonly id: string
    readonly type: 'gateway'
    readonly condition: string
  }
  | {
    readonly kind: 'add-node'
    readonly id: string
    readonly type: 'parallel_branch'
    readonly branches: readonly string[]
  }
  | {
    readonly kind: 'add-node'
    readonly id: string
    readonly type: 'while'
    readonly body: readonly string[]
    readonly continueIf: string
    readonly maxIterations: number
  }
  | { readonly kind: 'remove-node'; readonly id: string }
  | { readonly kind: 'add-schedule-edge'; readonly from: string; readonly to: string }
  | { readonly kind: 'remove-schedule-edge'; readonly from: string; readonly to: string }
  | { readonly kind: 'add-data-edge'; readonly from: string; readonly to: string; readonly port: string }
  | { readonly kind: 'remove-data-edge'; readonly from: string; readonly to: string; readonly port: string }

/** Result of applying one source-only edit to the current draft. */
export type WorkflowEditResult = WorkflowGraphPayload & {
  readonly ok: boolean
  readonly text?: string
}

/** A non-success HTTP status outside the editor's modelled responses. */
export class WorkflowEditorRequestError extends Error {
  /**
   * @param status - HTTP status returned by the host.
   */
  public constructor(public readonly status: number) {
    super(`workflow editor request failed with HTTP ${status}`)
    this.name = 'WorkflowEditorRequestError'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string')
}

function parseIssue(value: unknown): WorkflowIssue {
  if (!isRecord(value) || typeof value.path !== 'string' || typeof value.message !== 'string') {
    throw new Error('invalid workflow issue response')
  }
  const issue: {
    path: string
    message: string
    kind?: string
    line?: number
    column?: number
    nodeIds?: readonly string[]
    cycle?: readonly string[]
  } = { path: value.path, message: value.message }
  if (value.kind !== undefined) {
    if (typeof value.kind !== 'string') throw new Error('invalid workflow issue response')
    issue.kind = value.kind
  }
  if (value.line !== undefined) {
    if (typeof value.line !== 'number') throw new Error('invalid workflow issue response')
    issue.line = value.line
  }
  if (value.column !== undefined) {
    if (typeof value.column !== 'number') throw new Error('invalid workflow issue response')
    issue.column = value.column
  }
  if (value.nodeIds !== undefined) {
    if (!isStringArray(value.nodeIds)) throw new Error('invalid workflow issue response')
    issue.nodeIds = value.nodeIds
  }
  if (value.cycle !== undefined) {
    if (!isStringArray(value.cycle)) throw new Error('invalid workflow issue response')
    issue.cycle = value.cycle
  }
  return issue
}

function parseIssues(value: unknown): readonly WorkflowIssue[] {
  if (!Array.isArray(value)) throw new Error('invalid workflow issues response')
  return value.map(parseIssue)
}

function isWorkflowNodeType(value: unknown): value is WorkflowNodeType {
  return value === 'agent'
    || value === 'command'
    || value === 'await_command'
    || value === 'gateway'
    || value === 'parallel_branch'
    || value === 'while'
}

function parseSummaryNode(value: unknown): WorkflowSummaryNode {
  if (
    !isRecord(value)
    || typeof value.id !== 'string'
    || typeof value.level !== 'number'
    || !isWorkflowNodeType(value.type)
  ) {
    throw new Error('invalid workflow graph response')
  }
  if (value.agentRef !== undefined && typeof value.agentRef !== 'string') {
    throw new Error('invalid workflow graph response')
  }
  if (value.displayName !== undefined && typeof value.displayName !== 'string') {
    throw new Error('invalid workflow graph response')
  }
  if (value.businessRole !== undefined && typeof value.businessRole !== 'string') {
    throw new Error('invalid workflow graph response')
  }
  return {
    id: value.id,
    level: value.level,
    type: value.type,
    ...(value.agentRef === undefined ? {} : { agentRef: value.agentRef }),
    ...(value.displayName === undefined ? {} : { displayName: value.displayName }),
    ...(value.businessRole === undefined ? {} : { businessRole: value.businessRole }),
  }
}

function parseOutputs(value: unknown): Readonly<Record<string, readonly string[]>> {
  if (!isRecord(value)) throw new Error('invalid workflow graph response')
  const outputs: Record<string, readonly string[]> = {}
  for (const [port, targets] of Object.entries(value)) {
    if (!isStringArray(targets)) throw new Error('invalid workflow graph response')
    outputs[port] = targets
  }
  return outputs
}

function optionalString(value: unknown, errorMessage: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new Error(errorMessage)
  return value
}

function optionalStringArray(value: unknown, errorMessage: string): readonly string[] | undefined {
  if (value === undefined) return undefined
  if (!isStringArray(value)) throw new Error(errorMessage)
  return value
}

function optionalNumber(value: unknown, errorMessage: string): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number') throw new Error(errorMessage)
  return value
}

function optionalBoolean(value: unknown, errorMessage: string): boolean | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') throw new Error(errorMessage)
  return value
}

function optionalRecord(
  value: unknown,
  errorMessage: string,
): Readonly<Record<string, unknown>> | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value)) throw new Error(errorMessage)
  return value
}

function parseAwaitCommandConfig(
  value: unknown,
  errorMessage: string,
): WorkflowAwaitCommandConfig | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value)) throw new Error(errorMessage)

  const targetActors = value.targetActors === undefined ? [] : value.targetActors
  if (
    !isStringArray(targetActors)
    || targetActors.some(actor => actor.length === 0 || actor.includes('\0'))
  ) {
    throw new Error(errorMessage)
  }

  const commandPort = value.commandPort === undefined ? 'command' : value.commandPort
  if (typeof commandPort !== 'string' || commandPort.length === 0 || commandPort.includes('\0')) {
    throw new Error(errorMessage)
  }

  const expirySeconds = value.expirySeconds === undefined ? 86400 : value.expirySeconds
  const maxCommands = value.maxCommands === undefined ? 10 : value.maxCommands
  if (
    typeof expirySeconds !== 'number'
    || !Number.isSafeInteger(expirySeconds)
    || expirySeconds <= 0
    || typeof maxCommands !== 'number'
    || !Number.isSafeInteger(maxCommands)
    || maxCommands <= 0
  ) {
    throw new Error(errorMessage)
  }

  return { targetActors, commandPort, expirySeconds, maxCommands }
}

function parseModel(
  value: unknown,
  errorMessage: string,
): string | { readonly provider: string; readonly id: string } | undefined {
  if (value === undefined || typeof value === 'string') return value
  if (
    !isRecord(value)
    || typeof value.provider !== 'string'
    || typeof value.id !== 'string'
  ) {
    throw new Error(errorMessage)
  }
  return { provider: value.provider, id: value.id }
}

function parseInlineAgent(value: unknown): WorkflowInlineAgent | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value) || typeof value.rolePrompt !== 'string') {
    throw new Error('invalid workflow graph response')
  }
  const harness = optionalString(value.harness, 'invalid workflow graph response')
  const model = parseModel(value.model, 'invalid workflow graph response')
  const domain = optionalString(value.domain, 'invalid workflow graph response')
  const allowedTools = optionalStringArray(value.allowedTools, 'invalid workflow graph response')
  const deniedTools = optionalStringArray(value.deniedTools, 'invalid workflow graph response')
  const timeoutSeconds = optionalNumber(value.timeoutSeconds, 'invalid workflow graph response')
  return {
    rolePrompt: value.rolePrompt,
    ...(harness === undefined ? {} : { harness }),
    ...(model === undefined ? {} : { model }),
    ...(domain === undefined ? {} : { domain }),
    ...(allowedTools === undefined ? {} : { allowedTools }),
    ...(deniedTools === undefined ? {} : { deniedTools }),
    ...(timeoutSeconds === undefined ? {} : { timeoutSeconds }),
  }
}

function parseNode(value: unknown): WorkflowGraphNode {
  const errorMessage = 'invalid workflow graph response'
  if (
    !isRecord(value)
    || typeof value.id !== 'string'
    || typeof value.level !== 'number'
    || typeof value.rolePrompt !== 'string'
    || !isStringArray(value.after)
    || !isStringArray(value.inputs)
  ) {
    throw new Error(errorMessage)
  }
  if (value.type !== undefined && !isWorkflowNodeType(value.type)) throw new Error(errorMessage)

  const displayName = optionalString(value.displayName, errorMessage)
  const businessRole = optionalString(value.businessRole, errorMessage)
  const agentRef = optionalString(value.agentRef, errorMessage)
  const inlineAgent = parseInlineAgent(value.inlineAgent)
  const harness = optionalString(value.harness, errorMessage)
  const model = parseModel(value.model, errorMessage)
  const timeoutMs = optionalNumber(value.timeoutMs, errorMessage)
  const condition = optionalString(value.condition, errorMessage)
  const branches = optionalStringArray(value.branches, errorMessage)
  const body = optionalStringArray(value.body, errorMessage)
  const continueIf = optionalString(value.continueIf, errorMessage)
  const maxIterations = optionalNumber(value.maxIterations, errorMessage)
  const skipIf = optionalString(value.skipIf, errorMessage)
  const joinStrategy = optionalString(value.joinStrategy, errorMessage)
  const cancelOnFirstFail = optionalBoolean(value.cancelOnFirstFail, errorMessage)
  const gatewayKind = optionalString(value.gatewayKind, errorMessage)
  const commandConfig = optionalRecord(value.commandConfig, errorMessage)
  const awaitCommandConfig = parseAwaitCommandConfig(value.awaitCommandConfig, errorMessage)
  const whileConfig = optionalRecord(value.whileConfig, errorMessage)
  const rawFields = optionalRecord(value.rawFields, errorMessage)

  return {
    id: value.id,
    level: value.level,
    ...(value.type === undefined ? {} : { type: value.type }),
    rolePrompt: value.rolePrompt,
    after: value.after,
    inputs: value.inputs,
    outputs: parseOutputs(value.outputs),
    ...(displayName === undefined ? {} : { displayName }),
    ...(businessRole === undefined ? {} : { businessRole }),
    ...(agentRef === undefined ? {} : { agentRef }),
    ...(inlineAgent === undefined ? {} : { inlineAgent }),
    ...(harness === undefined ? {} : { harness }),
    ...(model === undefined ? {} : { model }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(condition === undefined ? {} : { condition }),
    ...(branches === undefined ? {} : { branches }),
    ...(body === undefined ? {} : { body }),
    ...(continueIf === undefined ? {} : { continueIf }),
    ...(maxIterations === undefined ? {} : { maxIterations }),
    ...(skipIf === undefined ? {} : { skipIf }),
    ...(joinStrategy === undefined ? {} : { joinStrategy }),
    ...(cancelOnFirstFail === undefined ? {} : { cancelOnFirstFail }),
    ...(gatewayKind === undefined ? {} : { gatewayKind }),
    ...(commandConfig === undefined ? {} : { commandConfig }),
    ...(awaitCommandConfig === undefined ? {} : { awaitCommandConfig }),
    ...(whileConfig === undefined ? {} : { whileConfig }),
    ...(rawFields === undefined ? {} : { rawFields }),
  }
}

function parseEdge(value: unknown): WorkflowGraphEdge {
  if (!isRecord(value) || typeof value.from !== 'string' || typeof value.to !== 'string') {
    throw new Error('invalid workflow graph response')
  }
  return { from: value.from, to: value.to }
}

function parseDataEdge(value: unknown): WorkflowDataEdge {
  if (
    !isRecord(value)
    || typeof value.from !== 'string'
    || typeof value.to !== 'string'
    || typeof value.port !== 'string'
  ) {
    throw new Error('invalid workflow graph response')
  }
  return { from: value.from, to: value.to, port: value.port }
}

function parseCompiledArtifact(value: unknown): WorkflowCompiledArtifact {
  if (
    !isRecord(value)
    || typeof value.source !== 'string'
    || typeof value.digest !== 'string'
    || !Array.isArray(value.layers)
    || !value.layers.every(isStringArray)
  ) {
    throw new Error('invalid workflow compiled response')
  }
  return { source: value.source, layers: value.layers, digest: value.digest }
}

function parseWorkflowGraph(payload: Record<string, unknown>): WorkflowGraphPayload {
  const issues = parseIssues(payload.issues)
  let nodes: readonly WorkflowGraphNode[] | undefined
  let edges: readonly WorkflowGraphEdge[] | undefined
  let dataEdges: readonly WorkflowDataEdge[] | undefined
  const graphFieldCount = Number(payload.nodes !== undefined)
    + Number(payload.edges !== undefined)
    + Number(payload.dataEdges !== undefined)
  if (graphFieldCount === 3) {
    if (!Array.isArray(payload.nodes) || !Array.isArray(payload.edges) || !Array.isArray(payload.dataEdges)) {
      throw new Error('invalid workflow graph response')
    }
    nodes = payload.nodes.map(parseNode)
    edges = payload.edges.map(parseEdge)
    dataEdges = payload.dataEdges.map(parseDataEdge)
  } else if (graphFieldCount !== 0) {
    throw new Error('invalid workflow graph response')
  }
  const compiled = payload.compiled === undefined
    ? undefined
    : parseCompiledArtifact(payload.compiled)
  const compileIssues = payload.compileIssues === undefined
    ? undefined
    : parseIssues(payload.compileIssues)
  return {
    issues,
    ...(nodes === undefined ? {} : { nodes }),
    ...(edges === undefined ? {} : { edges }),
    ...(dataEdges === undefined ? {} : { dataEdges }),
    ...(compiled === undefined ? {} : { compiled }),
    ...(compileIssues === undefined ? {} : { compileIssues }),
  }
}

function isRunInputType(value: unknown): value is WorkflowRunInputType {
  return value === 'string'
    || value === 'integer'
    || value === 'number'
    || value === 'boolean'
    || value === 'array'
}

function isJsonValue(value: unknown): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(isJsonValue)
  if (!isRecord(value)) return false
  return Object.values(value).every(isJsonValue)
}

function matchesRunInputType(type: WorkflowRunInputType, value: unknown): boolean {
  switch (type) {
    case 'string':
      return typeof value === 'string'
    case 'integer':
      return typeof value === 'number' && Number.isSafeInteger(value)
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
    case 'boolean':
      return typeof value === 'boolean'
    case 'array':
      return Array.isArray(value) && isJsonValue(value)
  }
}

function parseRunInputDefinition(
  value: unknown,
  errorMessage: string,
): WorkflowRunInputDefinition {
  if (
    !isRecord(value)
    || typeof value.name !== 'string'
    || !isRunInputType(value.type)
    || typeof value.required !== 'boolean'
  ) {
    throw new Error(errorMessage)
  }
  const name = value.name.trim()
  if (name.length === 0) throw new Error(errorMessage)
  const input: {
    name: string
    type: WorkflowRunInputType
    required: boolean
    description?: string
    defaultValue?: unknown
  } = {
    name,
    type: value.type,
    required: value.required,
  }
  if (value.description !== undefined) {
    if (typeof value.description !== 'string') throw new Error(errorMessage)
    input.description = value.description
  }
  if (Object.hasOwn(value, 'default')) {
    if (!matchesRunInputType(value.type, value.default)) throw new Error(errorMessage)
    input.defaultValue = value.default
  }
  return input
}

function parseRunInputDefinitions(
  value: unknown,
  errorMessage: string,
): readonly WorkflowRunInputDefinition[] {
  if (!Array.isArray(value)) throw new Error(errorMessage)
  const inputs = value.map(item => parseRunInputDefinition(item, errorMessage))
  if (new Set(inputs.map(input => input.name)).size !== inputs.length) {
    throw new Error(errorMessage)
  }
  return inputs
}

function parseWorkflowSummary(value: unknown): WorkflowSummary {
  if (
    !isRecord(value)
    || typeof value.id !== 'string'
    || typeof value.file !== 'string'
    || typeof value.name !== 'string'
    || typeof value.nodeCount !== 'number'
    || typeof value.levelCount !== 'number'
    || typeof value.ok !== 'boolean'
    || !isStringArray(value.errors)
    || (value.status !== 'verified' && value.status !== 'invalid')
    || !Array.isArray(value.inputs)
    || !Array.isArray(value.nodes)
    || !Array.isArray(value.edges)
  ) {
    throw new Error('invalid workflow catalog response')
  }
  if (value.updatedAt !== undefined && typeof value.updatedAt !== 'string') {
    throw new Error('invalid workflow catalog response')
  }
  return {
    id: value.id,
    file: value.file,
    name: value.name,
    nodeCount: value.nodeCount,
    levelCount: value.levelCount,
    ok: value.ok,
    errors: value.errors,
    status: value.status,
    inputs: parseRunInputDefinitions(value.inputs, 'invalid workflow catalog response'),
    nodes: value.nodes.map(parseSummaryNode),
    edges: value.edges.map(parseEdge),
    ...(value.updatedAt === undefined ? {} : { updatedAt: value.updatedAt }),
  }
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch (reason) {
    throw new Error(`invalid workflow editor response (HTTP ${response.status})`, { cause: reason })
  }
}

function unexpected(response: Response): WorkflowEditorRequestError {
  return new WorkflowEditorRequestError(response.status)
}

/**
 * Read the workflow catalogue and its source directory.
 * @param fetchImpl - fetch implementation, injectable for tests.
 * @returns workflow entries plus the directory that supplied them.
 */
export async function loadWorkflowCatalog(
  fetchImpl: typeof fetch = fetch,
): Promise<WorkflowCatalog> {
  const response = await fetchImpl('/api/agentops/workflows', { credentials: 'include' })
  if (!response.ok) throw unexpected(response)
  const payload = await readJson(response)
  if (
    !isRecord(payload)
    || typeof payload.dir !== 'string'
    || typeof payload.missing !== 'boolean'
    || !Array.isArray(payload.entries)
  ) {
    throw new Error('invalid workflow catalog response')
  }
  return {
    dir: payload.dir,
    entries: payload.entries.map(parseWorkflowSummary),
    missing: payload.missing,
  }
}

/**
 * Read exact workflow source and its current digest.
 * @param workflowId - workflow identity.
 * @param fetchImpl - fetch implementation, injectable for tests.
 * @returns exact source and digest.
 */
export async function loadWorkflowSource(
  workflowId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<WorkflowSource> {
  const response = await fetchImpl(
    `/api/agentops/workflow-source?id=${encodeURIComponent(workflowId)}`,
    { credentials: 'include' },
  )
  if (!response.ok) throw unexpected(response)
  const payload = await readJson(response)
  if (!isRecord(payload) || typeof payload.text !== 'string' || typeof payload.digest !== 'string') {
    throw new Error('invalid workflow source response')
  }
  return { text: payload.text, digest: payload.digest }
}

/**
 * Validate a draft without writing it.
 * @param text - exact draft source.
 * @param fetchImpl - fetch implementation, injectable for tests.
 * @returns issues plus the graph when validation succeeds.
 */
export async function validateWorkflowSource(
  text: string,
  fetchImpl: typeof fetch = fetch,
): Promise<WorkflowValidationResult> {
  const response = await fetchImpl('/api/agentops/workflow-validate', {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text }),
  })
  const payload = await readJson(response)
  if (response.status === 422) {
    if (!isRecord(payload) || payload.ok !== false) throw unexpected(response)
    return { ok: false, ...parseWorkflowGraph(payload) }
  }
  if (!response.ok) throw unexpected(response)
  if (!isRecord(payload) || payload.ok !== true) {
    throw new Error('invalid workflow validation response')
  }
  return { ok: true, ...parseWorkflowGraph(payload) }
}

/**
 * Apply one source-only operation and return the candidate YAML.
 * @param text - current draft source.
 * @param operation - node or edge edit to apply.
 * @param fetchImpl - fetch implementation, injectable for tests.
 * @returns the candidate source and graph, or structured operation issues.
 */
export async function editWorkflowSource(
  text: string,
  operation: WorkflowEditOperation,
  fetchImpl: typeof fetch = fetch,
): Promise<WorkflowEditResult> {
  const response = await fetchImpl('/api/agentops/workflow-edit', {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text, operation }),
  })
  const payload = await readJson(response)
  if (response.status === 400 || response.status === 422) {
    if (!isRecord(payload) || payload.ok !== false) throw unexpected(response)
    const text = payload.text
    if (text !== undefined && typeof text !== 'string') {
      throw new Error('invalid workflow edit response')
    }
    return {
      ok: false,
      ...(text === undefined ? {} : { text }),
      ...parseWorkflowGraph(payload),
    }
  }
  if (!response.ok) throw unexpected(response)
  if (!isRecord(payload) || payload.ok !== true || typeof payload.text !== 'string') {
    throw new Error('invalid workflow edit response')
  }
  return { ok: true, text: payload.text, ...parseWorkflowGraph(payload) }
}

/**
 * Save a draft through compare-and-swap.
 * @param workflowId - workflow identity.
 * @param text - exact draft source.
 * @param expectedDigest - digest the edit was based on, or null for a new workflow.
 * @param fetchImpl - fetch implementation, injectable for tests.
 * @returns a saved digest, a conflict with the current digest, or validation issues.
 */
export async function saveWorkflowSource(
  workflowId: string,
  text: string,
  expectedDigest: string | null,
  fetchImpl: typeof fetch = fetch,
): Promise<WorkflowSaveResult> {
  const response = await fetchImpl('/api/agentops/workflow-save', {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ workflowId, text, expectedDigest }),
  })
  const payload = await readJson(response)
  if (response.status === 409) {
    if (!isRecord(payload) || typeof payload.actualDigest !== 'string') throw unexpected(response)
    return { kind: 'conflict', actualDigest: payload.actualDigest }
  }
  if (response.status === 422) {
    if (!isRecord(payload) || payload.ok !== false) throw unexpected(response)
    return { kind: 'invalid', issues: parseIssues(payload.issues) }
  }
  if (!response.ok) throw unexpected(response)
  if (!isRecord(payload) || typeof payload.digest !== 'string') {
    throw new Error('invalid workflow save response')
  }
  return { kind: 'saved', digest: payload.digest }
}

/**
 * Create a workflow that must not already exist.
 * @param workflowId - workflow identity.
 * @param text - complete YAML source.
 * @param fetchImpl - fetch implementation, injectable for tests.
 * @returns a created digest, an existing-ID conflict, or validation issues.
 */
export async function createWorkflowSource(
  workflowId: string,
  text: string,
  fetchImpl: typeof fetch = fetch,
): Promise<WorkflowCreateResult> {
  const response = await fetchImpl('/api/agentops/workflow-create', {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ workflowId, text }),
  })
  if (response.status === 409) return { kind: 'conflict' }
  const payload = await readJson(response)
  if (response.status === 422) {
    if (!isRecord(payload) || payload.ok !== false) throw unexpected(response)
    return { kind: 'invalid', issues: parseIssues(payload.issues) }
  }
  if (!response.ok) throw unexpected(response)
  if (!isRecord(payload) || typeof payload.digest !== 'string') {
    throw new Error('invalid workflow create response')
  }
  return { kind: 'created', digest: payload.digest }
}

/**
 * Delete one workflow file from the host catalogue.
 * @param workflowId - workflow identity.
 * @param fetchImpl - fetch implementation, injectable for tests.
 * @returns nothing after the host confirms deletion.
 */
export async function deleteWorkflowSource(
  workflowId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const response = await fetchImpl('/api/agentops/workflow-delete', {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ workflowId }),
  })
  if (!response.ok) throw unexpected(response)
  const payload = await readJson(response)
  if (!isRecord(payload) || payload.ok !== true) {
    throw new Error('invalid workflow delete response')
  }
}

/**
 * Read the run instruction and declared inputs for one workflow.
 * @param workflowId - workflow identity.
 * @param fetchImpl - fetch implementation, injectable for tests.
 * @returns the parsed run hint used by the form and clipboard action.
 */
export async function loadWorkflowRunHint(
  workflowId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<WorkflowRunHint> {
  const response = await fetchImpl(
    `/api/agentops/workflow-run-hint?id=${encodeURIComponent(workflowId)}`,
    { credentials: 'include' },
  )
  if (!response.ok) throw unexpected(response)
  const payload = await readJson(response)
  if (
    !isRecord(payload)
    || typeof payload.workflowId !== 'string'
    || typeof payload.prompt !== 'string'
    || typeof payload.reason !== 'string'
  ) {
    throw new Error('invalid workflow run hint response')
  }
  return {
    workflowId: payload.workflowId,
    prompt: payload.prompt,
    reason: payload.reason,
    inputs: parseRunInputDefinitions(payload.inputs, 'invalid workflow run hint response'),
  }
}

/**
 * Ask the host to create the AgentOps session that runs one workflow.
 * @param workflowId - workflow identity.
 * @param inputs - validated run values in workflow declaration order.
 * @param fetchImpl - fetch implementation, injectable for tests.
 * @returns the created session identity or the host's failure reason.
 */
export async function startWorkflow(
  workflowId: string,
  inputs: Readonly<Record<string, unknown>>,
  fetchImpl: typeof fetch = fetch,
): Promise<WorkflowRunResult> {
  const response = await fetchImpl('/api/agentops/workflow-run', {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ workflowId, inputs }),
  })
  const payload = await readJson(response)
  if (!isRecord(payload) || typeof payload.ok !== 'boolean') {
    throw new Error('invalid workflow run response')
  }
  if (!payload.ok) {
    if (typeof payload.reason !== 'string') throw new Error('invalid workflow run response')
    if (payload.sessionId === undefined) return { ok: false, reason: payload.reason }
    if (typeof payload.sessionId !== 'string') throw new Error('invalid workflow run response')
    return { ok: false, reason: payload.reason, sessionId: payload.sessionId }
  }
  if (!response.ok) throw unexpected(response)
  if (typeof payload.sessionId !== 'string' || typeof payload.workflowId !== 'string') {
    throw new Error('invalid workflow run response')
  }
  return { ok: true, sessionId: payload.sessionId, workflowId: payload.workflowId }
}
