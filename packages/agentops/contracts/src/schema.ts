/**
 * Parsers and the two edge rules for Agent and workflow definitions.
 *
 * Everything here takes `unknown` because the input is a YAML file, an API
 * body, or a database row: the repo validates at durable and wire boundaries.
 *
 * The module exists to end a specific defect: the old system derived workflow
 * edges four different ways (editor, list summary, collaboration graph,
 * scheduler), so a dependency declared only through `outputs` ran in parallel
 * with its producer while the graph still drew an edge. Here `scheduleDependencies`
 * is the only scheduling input and `dataEdges` is the only data-flow input.
 *
 * @module @agentops/dsh-contracts/schema
 */

import { YAMLException, dump, load } from 'js-yaml'

import type {
  AgentDefinition,
  AgentExecution,
  AgentModel,
  ExecutionBackend,
  AwaitCommandConfig,
  Harness,
  InlineAgent,
  Tier,
  ValidationIssue,
  ValidationResult,
  WorkflowDefinition,
  WorkflowGraphResult,
  WorkflowNode,
  WorkflowNodeLevel,
  WorkflowNodeType,
  WorkflowRunInputDefinition,
  WorkflowRunInputType,
  WorkflowWidgetDefinition,
} from './types.js'

const TIERS: readonly Tier[] = ['T0', 'T1', 'T2', 'T3']
const HARNESSES: readonly Harness[] = ['local_llm', 'claude_sdk', 'codex', 'opencode', 'deterministic']
const EXECUTION_BACKENDS: readonly ExecutionBackend[] = ['dsh_native', 'codex', 'claude_code', 'auto']
const EXECUTIONS: readonly AgentExecution[] = ['skill', 'workflow']
const NODE_TYPES: readonly WorkflowNodeType[] = [
  'agent',
  'command',
  'await_command',
  'gateway',
  'parallel_branch',
  'while',
]
const INPUT_TYPES: readonly WorkflowRunInputType[] = ['string', 'integer', 'number', 'boolean', 'array']

/** Raised when a workflow's dependency edges contain a cycle. */
export class WorkflowCycleError extends Error {
  /** Node ids left unresolved when no dependency level could make progress. */
  public readonly cycle: readonly string[]

  /**
   * @param cycle - node ids left unresolved when no progress was possible.
   */
  constructor(cycle: readonly string[]) {
    super(`工作流依赖存在环：${cycle.join(' -> ')}`)
    this.name = 'WorkflowCycleError'
    this.cycle = cycle
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function readStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') return undefined
    out.push(item)
  }
  return out
}

function readStringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined
  const out: Record<string, string> = {}
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== 'string') return undefined
    out[key] = item
  }
  return out
}

/**
 * Reject an artifact template that could escape the workspace.
 *
 * Values are business-relative: no absolute prefix, no drive letter, no `..`
 * segment, no NUL. Enforced here as well as in the layout resolver so a bad
 * template fails at parse time rather than at write time.
 * @param template - the raw `outputFiles` value.
 * @returns true when the template is relative and stays inside its prefix.
 */
export function isRelativeArtifactPath(template: string): boolean {
  if (template.length === 0) return false
  if (template.includes('\0')) return false
  if (template.startsWith('/') || template.startsWith('\\')) return false
  if (/^[A-Za-z]:/.test(template)) return false
  return !template.split(/[/\\]/).some(segment => segment === '..')
}

/**
 * Check whether an agent id is safe to use as a file stem.
 *
 * Agent ids become `config/agents/<id>.yaml`; separators, traversal segments,
 * whitespace, and platform-special characters are rejected before any path is
 * resolved.
 * @param value - candidate agent id.
 * @returns true when the id consists of letters, digits, `_`, or `-`, starting with a letter or digit.
 */
export function isSafeAgentId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value)
}

function parseModel(value: unknown): AgentModel | 'auto' | undefined {
  if (value === undefined) return 'auto'
  if (value === 'auto') return 'auto'
  if (typeof value === 'string') {
    const separator = value.indexOf('/')
    if (separator <= 0 || separator === value.length - 1) return undefined
    return { provider: value.slice(0, separator), id: value.slice(separator + 1) }
  }
  if (!isRecord(value)) return undefined
  const provider = readString(value.provider)
  const id = readString(value.id)
  if (provider === undefined || id === undefined || provider === '' || id === '') return undefined
  return { provider, id }
}

function parseTier(value: unknown, issues: ValidationIssue[], path: string): Tier {
  if (value === undefined) {
    issues.push({ path, message: '缺少 tier，按 T2 处理' })
    return 'T2'
  }
  const raw = readString(value)
  const upper = raw?.toUpperCase()
  if (upper !== undefined && (TIERS as readonly string[]).includes(upper)) return upper as Tier
  issues.push({ path, message: `未知 tier：${String(value)}，按 T2 处理` })
  return 'T2'
}

/**
 * Parse one Agent definition.
 *
 * Defaults mirror the legacy loader so an existing YAML file parses unchanged:
 * a missing or unknown `tier` is T2, a missing model is `auto`, and missing
 * permission lists are empty.
 * @param input - parsed YAML, an API body, or a database row.
 * @returns the definition, or every issue found.
 */
export function parseAgentDefinition(input: unknown): ValidationResult<AgentDefinition> {
  const issues: ValidationIssue[] = []
  if (!isRecord(input)) return { ok: false, issues: [{ path: '', message: 'Agent 定义必须是对象' }] }

  const rawAgentId = readString(input.agent_id) ?? readString(input.agentId)
  const agentId = rawAgentId?.trim()
  if (agentId === undefined || agentId === '') {
    issues.push({ path: 'agent_id', message: '缺少 agent_id' })
  } else if (!isSafeAgentId(agentId)) {
    issues.push({ path: 'agent_id', message: 'agent_id 只能包含字母、数字、下划线或连字符，且必须以字母或数字开头' })
  }

  const description = readString(input.description)
  if (input.description !== undefined && description === undefined) {
    issues.push({ path: 'description', message: 'description 必须是字符串' })
  }

  const systemPromptInput = readAlias(input, 'system_prompt', 'systemPrompt')
  const systemPrompt = readString(systemPromptInput)
  if (systemPromptInput !== undefined && systemPrompt === undefined) {
    issues.push({ path: 'system_prompt', message: 'system_prompt 必须是字符串' })
  }

  const harness = readString(input.harness)
  if (harness !== undefined && !(HARNESSES as readonly string[]).includes(harness)) {
    issues.push({ path: 'harness', message: `未知 harness：${harness}` })
  }

  const executionBackendInput = readAlias(input, 'execution_backend', 'executionBackend')
  const rawExecutionBackend = readString(executionBackendInput)
  if (executionBackendInput !== undefined && rawExecutionBackend === undefined) {
    issues.push({ path: 'execution_backend', message: 'execution_backend 必须是字符串' })
  }
  const executionBackend = rawExecutionBackend !== undefined
    && (EXECUTION_BACKENDS as readonly string[]).includes(rawExecutionBackend)
    ? rawExecutionBackend as ExecutionBackend
    : undefined
  if (rawExecutionBackend !== undefined && executionBackend === undefined) {
    issues.push({ path: 'execution_backend', message: `未知 execution_backend：${rawExecutionBackend}（可选：${EXECUTION_BACKENDS.join(' / ')}）` })
  }

  const model = parseModel(input.model)
  if (model === undefined) {
    issues.push({ path: 'model', message: 'model 必须是 auto、provider/id 或 {provider,id}' })
  }

  const rawPermissions = input.permissions
  if (rawPermissions !== undefined && !isRecord(rawPermissions)) {
    issues.push({ path: 'permissions', message: 'permissions 必须是对象' })
  }
  const permissions = isRecord(rawPermissions) ? rawPermissions : {}
  const allowedRaw = readAlias(permissions, 'allowed_tools', 'allowedTools')
  const deniedRaw = readAlias(permissions, 'denied_tools', 'deniedTools')
  const allowedTools = allowedRaw === undefined ? [] : readStringArray(allowedRaw)
  const deniedTools = deniedRaw === undefined ? [] : readStringArray(deniedRaw)
  if (allowedTools === undefined) issues.push({ path: 'permissions.allowed_tools', message: 'allowed_tools 必须是字符串数组' })
  if (deniedTools === undefined) issues.push({ path: 'permissions.denied_tools', message: 'denied_tools 必须是字符串数组' })

  const knowledgeInput = readAlias(input, 'knowledge_bases', 'knowledgeBases')
  const knowledgeBases = knowledgeInput === undefined ? undefined : readStringArray(knowledgeInput)
  if (knowledgeInput !== undefined && knowledgeBases === undefined) {
    issues.push({ path: 'knowledge_bases', message: 'knowledge_bases 必须是字符串数组' })
  }

  const executionInput = input.execution
  const rawExecution = readString(executionInput)
  if (executionInput !== undefined && rawExecution === undefined) {
    issues.push({ path: 'execution', message: 'execution 必须是字符串' })
  }
  const declaredExecution = rawExecution !== undefined && (EXECUTIONS as readonly string[]).includes(rawExecution)
    ? rawExecution as AgentExecution
    : undefined
  if (rawExecution !== undefined && declaredExecution === undefined) {
    issues.push({ path: 'execution', message: `未知 execution：${rawExecution}（可选：${EXECUTIONS.join(' / ')}）` })
  }
  const execution: AgentExecution = declaredExecution ?? 'skill'

  const workflowInput = input.workflow
  const workflow = readString(workflowInput)
  if (workflowInput !== undefined && workflow === undefined) {
    issues.push({ path: 'workflow', message: 'workflow 必须是字符串' })
  } else if (workflow !== undefined && !isSafeAgentId(workflow)) {
    issues.push({ path: 'workflow', message: 'workflow 只能包含字母、数字、下划线或连字符，且必须以字母或数字开头' })
  }
  // Ownership lives on the Agent alone, so the two fields have to agree: a
  // workflow declaration without `execution: workflow` would never be honoured,
  // and a workflow agent without an id would have nothing to run.
  if (workflow !== undefined && execution !== 'workflow') {
    issues.push({ path: 'workflow', message: '只有 execution: workflow 的 Agent 才能声明 workflow' })
  }
  if (execution === 'workflow' && workflow === undefined) {
    issues.push({ path: 'workflow', message: 'execution: workflow 的 Agent 必须声明 workflow' })
  }

  const timeoutInput = readAlias(input, 'timeout_seconds', 'timeoutSeconds')
  const timeoutSeconds = readPositiveNumber(timeoutInput)
  if (timeoutInput !== undefined && timeoutSeconds === undefined) {
    issues.push({ path: 'timeout_seconds', message: 'timeout_seconds 必须是正数' })
  }

  const concurrencyInput = readAlias(input, 'max_concurrent_runs', 'maxConcurrentRuns')
  const maxConcurrentRuns = readPositiveInteger(concurrencyInput)
  if (concurrencyInput !== undefined && maxConcurrentRuns === undefined) {
    issues.push({ path: 'max_concurrent_runs', message: 'max_concurrent_runs 必须是正整数' })
  }

  const costInput = readAlias(input, 'cost_limit_per_run', 'costLimitPerRun')
  const costLimitPerRun = costInput === undefined
    ? undefined
    : costInput === null
      ? null
      : readNonNegativeNumber(costInput)
  if (costInput !== undefined && costLimitPerRun === undefined) {
    issues.push({ path: 'cost_limit_per_run', message: 'cost_limit_per_run 必须是非负数或 null' })
  }

  const outputInput = readAlias(input, 'output_files', 'outputFiles')
  const outputFiles = outputInput === undefined ? {} : readStringRecord(outputInput)
  if (outputFiles === undefined) {
    issues.push({ path: 'output_files', message: 'output_files 必须是字符串映射' })
  } else {
    for (const [name, template] of Object.entries(outputFiles)) {
      if (!isRelativeArtifactPath(template)) {
        issues.push({ path: `output_files.${name}`, message: `产物路径必须是业务相对路径：${template}` })
      }
    }
  }

  if (issues.length > 0) return { ok: false, issues }

  // Tier degradation is reported but never fatal: an unknown or missing tier
  // falls back to T2 exactly as the legacy loader does, so an old file still
  // loads. Every other field above fails hard.
  const tier = parseTier(input.tier, issues, 'tier')

  return {
    ok: true,
    issues,
    value: {
      agentId: agentId ?? '',
      displayName: readString(input.display_name) ?? readString(input.displayName) ?? agentId ?? '',
      domain: readString(input.domain) ?? '',
      ...(description === undefined ? {} : { description }),
      harness: (harness ?? 'local_llm') as Harness,
      executionBackend: executionBackend ?? 'auto',
      model: model ?? 'auto',
      ...(systemPrompt === undefined ? {} : { systemPrompt }),
      tier,
      execution,
      ...(workflow === undefined ? {} : { workflow }),
      permissions: {
        allowedTools: allowedTools ?? [],
        deniedTools: deniedTools ?? [],
      },
      ...(knowledgeBases === undefined ? {} : { knowledgeBases }),
      ...(timeoutSeconds === undefined ? {} : { timeoutSeconds }),
      ...(maxConcurrentRuns === undefined ? {} : { maxConcurrentRuns }),
      ...(costLimitPerRun === undefined ? {} : { costLimitPerRun }),
      outputFiles: outputFiles ?? {},
    },
  }
}

function readAlias(input: Record<string, unknown>, snakeCase: string, camelCase: string): unknown {
  return input[snakeCase] !== undefined ? input[snakeCase] : input[camelCase]
}

function readPositiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

function readPositiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && Number.isInteger(value) ? value : undefined
}

function readNonNegativeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}
function parseInlineAgent(value: unknown, path: string): { agent?: InlineAgent; issues: readonly ValidationIssue[] } {
  if (!isRecord(value)) return { issues: [{ path, message: 'inline_agent 必须是对象' }] }
  const issues: ValidationIssue[] = []
  const roleInput = readAlias(value, 'role_prompt', 'rolePrompt')
  const rolePrompt = readString(roleInput) ?? ''
  if (roleInput !== undefined && readString(roleInput) === undefined) {
    issues.push({ path: `${path}.role_prompt`, message: 'role_prompt 必须是字符串' })
  }

  const harnessInput = readString(value.harness)
  if (harnessInput !== undefined && !(HARNESSES as readonly string[]).includes(harnessInput)) {
    issues.push({ path: `${path}.harness`, message: `未知 harness：${harnessInput}` })
  }

  const model = parseModel(value.model)
  if (model === undefined) {
    issues.push({ path: `${path}.model`, message: 'model 必须是 auto、provider/id 或 {provider,id}' })
  }

  const domainInput = readString(value.domain)
  if (value.domain !== undefined && domainInput === undefined) {
    issues.push({ path: `${path}.domain`, message: 'domain 必须是字符串' })
  }

  const allowedInput = readAlias(value, 'allowed_tools', 'allowedTools')
  const deniedInput = readAlias(value, 'denied_tools', 'deniedTools')
  const allowedTools = allowedInput === undefined ? [] : readStringArray(allowedInput)
  const deniedTools = deniedInput === undefined ? [] : readStringArray(deniedInput)
  if (allowedTools === undefined) issues.push({ path: `${path}.allowed_tools`, message: 'allowed_tools 必须是字符串数组' })
  if (deniedTools === undefined) issues.push({ path: `${path}.denied_tools`, message: 'denied_tools 必须是字符串数组' })

  const timeoutInput = readAlias(value, 'timeout_seconds', 'timeoutSeconds')
  const timeoutSeconds = readPositiveNumber(timeoutInput)
  if (timeoutInput !== undefined && timeoutSeconds === undefined) {
    issues.push({ path: `${path}.timeout_seconds`, message: 'timeout_seconds 必须是正数' })
  }

  if (issues.length > 0) return { issues }
  return {
    issues,
    agent: {
      rolePrompt,
      ...(harnessInput === undefined ? {} : { harness: harnessInput as Harness }),
      ...(model === undefined ? {} : { model }),
      ...(domainInput === undefined ? {} : { domain: domainInput }),
      allowedTools: allowedTools ?? [],
      deniedTools: deniedTools ?? [],
      ...(timeoutSeconds === undefined ? {} : { timeoutSeconds }),
    },
  }
}

function parseOutputTarget(value: unknown): string[] | undefined {
  if (typeof value === 'string') return [value]
  if (!isRecord(value)) return undefined
  if (typeof value.to === 'string') return [value.to]
  return readStringArray(value.to)
}

function normalizeOutputTarget(value: string): string | undefined {
  const trimmed = value.trim()
  if (trimmed === '') return undefined
  return trimmed.replace(/\.(?:in|out):.*$/, '').trim()
}

function parseOutputs(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
): Readonly<Record<string, readonly string[]>> {
  if (value === undefined) return {}
  if (!isRecord(value)) {
    issues.push({ path, message: 'outputs 必须是对象' })
    return {}
  }

  const outputs: Record<string, readonly string[]> = {}
  for (const [port, rawTargets] of Object.entries(value)) {
    const targetPath = `${path}.${port}`
    const candidates = Array.isArray(rawTargets) ? rawTargets : [rawTargets]
    const targets: string[] = []
    const seen = new Set<string>()
    for (const candidate of candidates) {
      const rawTargets = parseOutputTarget(candidate)
      if (rawTargets === undefined) {
        issues.push({ path: targetPath, message: '输出目标必须是字符串、字符串数组或 {to: string | string[]}' })
        continue
      }
      for (const rawTarget of rawTargets) {
        const target = normalizeOutputTarget(rawTarget)
        if (target === undefined || seen.has(target)) continue
        seen.add(target)
        targets.push(target)
      }
    }
    outputs[port] = targets
  }
  return outputs
}

function parseNode(
  value: unknown,
  index: number,
  mappingId?: string,
): { node?: WorkflowNode; issues: ValidationIssue[] } {
  const issues: ValidationIssue[] = []
  if (!isRecord(value)) return { issues: [{ path: mappingId === undefined ? `nodes[${index}]` : `nodes.${mappingId}`, message: '节点必须是对象' }] }

  const id = mappingId ?? readString(value.id)
  const path = id === undefined || id === '' ? `nodes[${index}]` : `nodes.${id}`
  if (id === undefined || id === '') issues.push({ path: `${path}.id`, message: '缺少节点 id' })

  const rawType = value.type === undefined ? 'agent' : readString(value.type)
  const type = rawType !== undefined && (NODE_TYPES as readonly string[]).includes(rawType)
    ? rawType as WorkflowNodeType
    : undefined
  if (type === undefined) {
    issues.push({ path: `${path}.type`, message: `不支持的节点类型：${String(value.type)}` })
  }

  const agentRef = readString(value.agent)
  if (value.agent !== undefined && agentRef === undefined) {
    issues.push({ path: `${path}.agent`, message: 'agent 必须是字符串引用' })
  }
  const parsedInline = value.inline_agent === undefined ? undefined : parseInlineAgent(value.inline_agent, `${path}.inline_agent`)
  const inlineAgent = parsedInline?.agent
  if (parsedInline !== undefined) issues.push(...parsedInline.issues)
  if (type === 'agent' && agentRef === undefined && inlineAgent === undefined) {
    issues.push({ path, message: '节点必须声明 agent 或 inline_agent' })
  }
  if (type === 'agent' && agentRef !== undefined && inlineAgent !== undefined) {
    issues.push({ path, message: 'agent 与 inline_agent 不能同时声明' })
  }

  const after = value.after === undefined ? [] : readStringArray(value.after)
  if (after === undefined) issues.push({ path: `${path}.after`, message: 'after 必须是字符串数组' })
  const inputs = value.inputs === undefined ? [] : readStringArray(value.inputs)
  if (inputs === undefined) issues.push({ path: `${path}.inputs`, message: 'inputs 必须是字符串数组' })
  const outputs = parseOutputs(value.outputs, `${path}.outputs`, issues)

  const timeoutSecondsInput = value.timeout_seconds === undefined ? undefined : readPositiveNumber(value.timeout_seconds)
  if (value.timeout_seconds !== undefined && timeoutSecondsInput === undefined) {
    issues.push({ path: `${path}.timeout_seconds`, message: 'timeout_seconds 必须是正数' })
  }
  const timeoutMsInput = readAlias(value, 'timeout_ms', 'timeoutMs')
  const timeoutMsDirect = timeoutMsInput === undefined ? undefined : readPositiveNumber(timeoutMsInput)
  if (timeoutMsInput !== undefined && timeoutMsDirect === undefined) {
    issues.push({ path: `${path}.timeout_ms`, message: 'timeout_ms 必须是正数' })
  }
  const timeoutMs = timeoutMsDirect ?? (timeoutSecondsInput === undefined ? undefined : timeoutSecondsInput * 1000)

  const commandConfig = readObjectAlias(value, 'command_config', 'commandConfig', issues, `${path}.command_config`)
  const awaitCommandConfig = parseAwaitCommandConfig(
    readAlias(value, 'await_command_config', 'awaitCommandConfig'),
    `${path}.await_command_config`,
    issues,
  )
  const whileConfig = readObjectAlias(value, 'while_config', 'whileConfig', issues, `${path}.while_config`)

  if (type === 'command') {
    if (commandConfig === undefined) {
      issues.push({ path: `${path}.command_config`, message: 'command 节点需要 command_config' })
    } else if (readString(commandConfig.cli_template) === undefined) {
      issues.push({ path: `${path}.command_config.cli_template`, message: 'command_config.cli_template 必须是非空字符串' })
    }
  }
  if (type === 'await_command' && awaitCommandConfig === undefined) {
    issues.push({ path: `${path}.await_command_config`, message: 'await_command 节点需要 await_command_config' })
  }

  const condition = readString(value.condition)
  if (value.condition !== undefined && condition === undefined) {
    issues.push({ path: `${path}.condition`, message: 'condition 必须是字符串' })
  }
  if (type === 'gateway') {
    if (condition === undefined || condition.trim() === '') issues.push({ path: `${path}.condition`, message: 'gateway 节点需要 condition' })
    if (Object.keys(outputs).length === 0) issues.push({ path: `${path}.outputs`, message: 'gateway 节点需要至少一个输出端口' })
  }

  const branches = value.branches === undefined ? undefined : readStringArray(value.branches)
  if (value.branches !== undefined && branches === undefined) {
    issues.push({ path: `${path}.branches`, message: 'branches 必须是字符串数组' })
  }
  if (type === 'parallel_branch' && (branches === undefined || branches.length === 0)) {
    issues.push({ path: `${path}.branches`, message: 'parallel_branch 节点需要非空 branches' })
  }

  const body = (value.body === undefined ? undefined : readStringArray(value.body)) ?? readStringArray(whileConfig?.body)
  if (value.body !== undefined && readStringArray(value.body) === undefined) {
    issues.push({ path: `${path}.body`, message: 'body 必须是字符串数组' })
  }
  const continueInput = readAlias(value, 'continue_if', 'continueIf') ?? whileConfig?.continue_if ?? whileConfig?.continueIf
  const continueIf = readString(continueInput)
  if (continueInput !== undefined && continueIf === undefined) {
    issues.push({ path: `${path}.continue_if`, message: 'continue_if 必须是字符串' })
  }
  const maxInput = readAlias(value, 'max_iterations', 'maxIterations') ?? whileConfig?.max_iterations ?? whileConfig?.maxIterations
  const maxIterations = readPositiveInteger(maxInput)
  if (maxInput !== undefined && maxIterations === undefined) {
    issues.push({ path: `${path}.max_iterations`, message: 'max_iterations 必须是正整数' })
  }
  if (type === 'while') {
    if (body === undefined || body.length === 0) issues.push({ path: `${path}.body`, message: 'while 节点需要非空 body' })
    if (continueIf === undefined || continueIf.trim() === '') {
      issues.push({ path: `${path}.continue_if`, message: 'while 节点需要 continue_if' })
    }
    if (maxIterations === undefined) issues.push({ path: `${path}.max_iterations`, message: 'while 节点需要正整数 max_iterations' })
  }

  const skipInput = readAlias(value, 'skip_if', 'skipIf')
  const skipIf = readString(skipInput)
  if (skipInput !== undefined && skipIf === undefined) {
    issues.push({ path: `${path}.skip_if`, message: 'skip_if 必须是字符串' })
  }

  const joinStrategyInput = readAlias(value, 'join_strategy', 'joinStrategy')
  const joinStrategy = readString(joinStrategyInput)
  if (joinStrategyInput !== undefined && joinStrategy === undefined) {
    issues.push({ path: `${path}.join_strategy`, message: 'join_strategy 必须是字符串' })
  }
  const cancelInput = readAlias(value, 'cancel_on_first_fail', 'cancelOnFirstFail')
  if (cancelInput !== undefined && typeof cancelInput !== 'boolean') {
    issues.push({ path: `${path}.cancel_on_first_fail`, message: 'cancel_on_first_fail 必须是布尔值' })
  }
  const gatewayKindInput = readAlias(value, 'gateway_kind', 'gatewayKind')
  const gatewayKind = readString(gatewayKindInput)
  if (gatewayKindInput !== undefined && gatewayKind === undefined) {
    issues.push({ path: `${path}.gateway_kind`, message: 'gateway_kind 必须是字符串' })
  }

  const modelInput = value.model
  const model = typeof modelInput === 'string'
    ? readString(modelInput)
    : modelInput === undefined
      ? undefined
      : parseModel(modelInput)
  if (modelInput !== undefined && model === undefined) {
    issues.push({ path: `${path}.model`, message: 'model 必须是字符串、auto 或 {provider,id}' })
  }

  if (id === undefined || id === '' || type === undefined) return { issues }

  const displayName = readString(value.name) ?? readString(value.display_name) ?? readString(value.displayName)
  const businessRole = readString(value.business_role) ?? readString(value.businessRole)
  const harness = readString(value.harness)
  const knownFields = new Set([
    'id', 'type', 'name', 'display_name', 'displayName', 'agent', 'inline_agent',
    'role_prompt', 'rolePrompt', 'business_role', 'businessRole', 'harness', 'model',
    'after', 'inputs', 'outputs', 'timeout_seconds', 'timeout_ms', 'timeoutMs',
    'condition', 'branches', 'body', 'continue_if', 'continueIf', 'max_iterations',
    'maxIterations', 'skip_if', 'skipIf', 'join_strategy', 'joinStrategy',
    'cancel_on_first_fail', 'cancelOnFirstFail', 'gateway_kind', 'gatewayKind',
    'command_config', 'commandConfig', 'await_command_config', 'awaitCommandConfig',
    'while_config', 'whileConfig',
  ])
  const rawFields = Object.fromEntries(Object.entries(value).filter(([field]) => !knownFields.has(field)))

  return {
    issues,
    node: {
      id,
      type,
      ...(displayName === undefined ? {} : { displayName }),
      ...(agentRef === undefined ? {} : { agentRef }),
      ...(inlineAgent === undefined ? {} : { inlineAgent }),
      rolePrompt: readString(value.role_prompt) ?? readString(value.rolePrompt) ?? inlineAgent?.rolePrompt ?? '',
      ...(businessRole === undefined ? {} : { businessRole }),
      ...(harness === undefined ? {} : { harness }),
      ...(model === undefined ? {} : { model }),
      after: after ?? [],
      inputs: inputs ?? [],
      outputs,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
      ...(condition === undefined ? {} : { condition }),
      ...(branches === undefined ? {} : { branches }),
      ...(body === undefined ? {} : { body }),
      ...(continueIf === undefined ? {} : { continueIf }),
      ...(maxIterations === undefined ? {} : { maxIterations }),
      ...(skipIf === undefined ? {} : { skipIf }),
      ...(joinStrategy === undefined ? {} : { joinStrategy }),
      ...(cancelInput === undefined || typeof cancelInput !== 'boolean' ? {} : { cancelOnFirstFail: cancelInput }),
      ...(gatewayKind === undefined ? {} : { gatewayKind }),
      ...(commandConfig === undefined ? {} : { commandConfig }),
      ...(awaitCommandConfig === undefined ? {} : { awaitCommandConfig }),
      ...(whileConfig === undefined ? {} : { whileConfig }),
      ...(Object.keys(rawFields).length === 0 ? {} : { rawFields }),
    },
  }
}

function parseAwaitCommandConfig(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
): AwaitCommandConfig | undefined {
  if (value === undefined || value === null) return undefined
  if (!isRecord(value)) {
    issues.push({ path, message: 'await_command_config 必须是对象' })
    return undefined
  }

  const targetInput = readAlias(value, 'target_actors', 'targetActors')
  let targetActors: readonly string[] = []
  if (targetInput !== undefined) {
    const parsed = readStringArray(targetInput)
    if (parsed === undefined) {
      issues.push({ path: `${path}.target_actors`, message: 'target_actors 必须是字符串数组' })
    } else {
      targetActors = parsed
    }
  }

  const portInput = readAlias(value, 'command_port', 'commandPort')
  let commandPort = 'command'
  if (portInput !== undefined) {
    const parsed = readString(portInput)
    if (parsed === undefined || parsed.length === 0) {
      issues.push({ path: `${path}.command_port`, message: 'command_port 必须是非空字符串' })
    } else {
      commandPort = parsed
    }
  }

  const expiryInput = readAlias(value, 'expiry_seconds', 'expirySeconds')
  let expirySeconds = 86400
  if (expiryInput !== undefined) {
    const parsed = readPositiveInteger(expiryInput)
    if (parsed === undefined) {
      issues.push({ path: `${path}.expiry_seconds`, message: 'expiry_seconds 必须是正整数' })
    } else {
      expirySeconds = parsed
    }
  }

  const maxInput = readAlias(value, 'max_commands', 'maxCommands')
  let maxCommands = 10
  if (maxInput !== undefined) {
    const parsed = readPositiveInteger(maxInput)
    if (parsed === undefined) {
      issues.push({ path: `${path}.max_commands`, message: 'max_commands 必须是正整数' })
    } else {
      maxCommands = parsed
    }
  }

  return { targetActors, commandPort, expirySeconds, maxCommands }
}

function readObjectAlias(
  input: Record<string, unknown>,
  snakeCase: string,
  camelCase: string,
  issues: ValidationIssue[],
  path: string,
): Record<string, unknown> | undefined {
  const value = readAlias(input, snakeCase, camelCase)
  if (value === undefined || value === null) return undefined
  if (!isRecord(value)) {
    issues.push({ path, message: `${snakeCase} 必须是对象` })
    return undefined
  }
  return { ...value }
}

function parseWorkflowNodes(input: unknown, issues: ValidationIssue[]): WorkflowNode[] {
  const nodes: WorkflowNode[] = []
  if (Array.isArray(input)) {
    if (input.length === 0) issues.push({ path: 'nodes', message: '工作流至少需要一个节点' })
    for (const [index, raw] of input.entries()) {
      const parsed = parseNode(raw, index)
      issues.push(...parsed.issues)
      if (parsed.node !== undefined) nodes.push(parsed.node)
    }
    return nodes
  }

  if (isRecord(input)) {
    const entries = Object.entries(input)
    if (entries.length === 0) issues.push({ path: 'nodes', message: '工作流至少需要一个节点' })
    for (const [index, [id, raw]] of entries.entries()) {
      const parsed = parseNode(raw, index, id)
      issues.push(...parsed.issues)
      if (parsed.node !== undefined) nodes.push(parsed.node)
    }
    return nodes
  }

  issues.push({ path: 'nodes', message: 'nodes 必须是节点数组或映射' })
  return nodes
}

interface DependencyCycle {
  readonly path: string
  readonly cycle: readonly string[]
}

function findDependencyCycle(nodes: readonly WorkflowNode[]): DependencyCycle | undefined {
  const byId = new Map(nodes.map(node => [node.id, node]))
  const state = new Map<string, 'visiting' | 'visited'>()
  const stack: string[] = []

  function visit(id: string): DependencyCycle | undefined {
    state.set(id, 'visiting')
    stack.push(id)
    for (const dependency of byId.get(id)?.after ?? []) {
      if (!byId.has(dependency)) continue
      const dependencyState = state.get(dependency)
      if (dependencyState === 'visiting') {
        const start = stack.indexOf(dependency)
        const cycle = [...stack.slice(start), dependency]
        return { path: `nodes.${id}.after`, cycle }
      }
      if (dependencyState !== 'visited') {
        const found = visit(dependency)
        if (found !== undefined) return found
      }
    }
    stack.pop()
    state.set(id, 'visited')
    return undefined
  }

  for (const node of nodes) {
    if (state.get(node.id) === undefined) {
      const found = visit(node.id)
      if (found !== undefined) return found
    }
  }
  return undefined
}

interface SourcePosition {
  readonly line: number
  readonly column: number
}

interface SourceLine {
  readonly index: number
  readonly indent: number
  readonly text: string
}

function sourceLinesOf(source: string): readonly SourceLine[] {
  return source.split(/\r?\n/).map((text, index) => ({ index, indent: /^ */.exec(text)?.[0].length ?? 0, text }))
}

function isBlankSourceLine(line: SourceLine): boolean {
  return line.text.trim() === ''
}

function unquoteYamlScalar(value: string): string {
  const trimmed = value.trim()
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

function nodeLineIndex(lines: readonly SourceLine[], nodesIndex: number, nodeId: string): number | undefined {
  const nodesLine = lines[nodesIndex]
  if (nodesLine === undefined) return undefined
  for (const line of lines) {
    if (line.index <= nodesIndex || isBlankSourceLine(line)) continue
    if (line.indent <= nodesLine.indent) break
    const trimmed = line.text.trimStart()
    if (trimmed.startsWith(`${nodeId}:`) || trimmed.startsWith(`"${nodeId}":`) || trimmed.startsWith(`'${nodeId}':`)) {
      return line.index
    }
    const sequenceId = /^-\s*id\s*:\s*(.*?)\s*(?:#.*)?$/.exec(trimmed)
    if (sequenceId !== null && unquoteYamlScalar(sequenceId[1] ?? '') === nodeId) return line.index
  }
  return undefined
}

function fieldLineIndex(lines: readonly SourceLine[], nodeIndex: number, field: string): number | undefined {
  const nodeIndent = lines[nodeIndex]?.indent ?? 0
  for (const line of lines) {
    if (line.index <= nodeIndex || isBlankSourceLine(line)) continue
    if (line.indent <= nodeIndent) break
    if (line.text.trimStart().startsWith(`${field}:`)) return line.index
  }
  return undefined
}

function sourcePositionOf(source: string, path: string): SourcePosition | undefined {
  if (path === '') return undefined
  const lines = sourceLinesOf(source)
  const tokens = path.split('.').filter(token => token !== '')
  const first = tokens[0]
  if (first === undefined) return undefined

  if (first === 'nodes') {
    const nodesIndex = lines.findIndex(line => line.text.trimStart().startsWith('nodes:'))
    if (nodesIndex < 0) return undefined
    if (tokens.length === 1) return { line: nodesIndex + 1, column: (lines[nodesIndex]?.indent ?? 0) + 1 }
    const nodeId = tokens[1]
    if (nodeId === undefined) return undefined
    const nodeIndex = nodeLineIndex(lines, nodesIndex, nodeId)
    if (nodeIndex === undefined) return undefined
    if (tokens.length === 2) return { line: nodeIndex + 1, column: (lines[nodeIndex]?.indent ?? 0) + 1 }
    const field = tokens[2]
    if (field === undefined) return undefined
    const fieldIndex = fieldLineIndex(lines, nodeIndex, field)
    if (fieldIndex === undefined) return undefined
    return { line: fieldIndex + 1, column: (lines[fieldIndex]?.indent ?? 0) + 1 }
  }

  const directIndex = lines.findIndex(line => line.text.trimStart().startsWith(`${first}:`))
  if (directIndex < 0) return undefined
  return { line: directIndex + 1, column: (lines[directIndex]?.indent ?? 0) + 1 }
}

function locateIssues(source: string, issues: readonly ValidationIssue[]): readonly ValidationIssue[] {
  return issues.map((issue) => {
    const position = sourcePositionOf(source, issue.path)
    if (position === undefined) return issue
    return { ...issue, line: position.line, column: position.column }
  })
}

/**
 * Parse one workflow definition and reject structural defects.
 *
 * Checks identity, per-node shape, dependency references, self-dependencies,
 * output targets, and cycles. `after` is the scheduling edge; `outputs` is the
 * data edge and never creates a dependency. Missing `business_id` is a warning
 * because legacy files predate the workspace layout; every execution-node
 * mismatch fails.
 * @param input - parsed YAML, an API body, or a database row.
 * @returns the definition plus non-fatal issues, or every issue found.
 */
function inputValueMatchesType(value: unknown, type: WorkflowRunInputType): boolean {
  switch (type) {
    case 'string':
      return typeof value === 'string'
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value)
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
    case 'boolean':
      return typeof value === 'boolean'
    case 'array':
      return Array.isArray(value)
  }
}

function parseWorkflowInputs(input: unknown): {
  readonly inputs: WorkflowRunInputDefinition[]
  readonly issues: ValidationIssue[]
} {
  if (input === undefined || input === null) return { inputs: [], issues: [] }
  if (!Array.isArray(input)) return { inputs: [], issues: [{ path: 'inputs', message: 'inputs 必须是数组' }] }

  const inputs: WorkflowRunInputDefinition[] = []
  const issues: ValidationIssue[] = []
  const names = new Set<string>()
  for (const [index, raw] of input.entries()) {
    const path = `inputs[${index}]`
    if (!isRecord(raw)) {
      issues.push({ path, message: '工作流输入必须是对象' })
      continue
    }

    const name = readString(raw.name)?.trim()
    if (name === undefined || name === '') issues.push({ path: `${path}.name`, message: '缺少输入名称' })
    else if (names.has(name)) issues.push({ path: `${path}.name`, message: `输入名称重复：${name}` })
    else names.add(name)

    const typeValue = readString(raw.type)
    const type = typeValue !== undefined && (INPUT_TYPES as readonly string[]).includes(typeValue)
      ? typeValue as WorkflowRunInputType
      : undefined
    if (type === undefined) {
      issues.push({ path: `${path}.type`, message: `输入类型必须是 ${INPUT_TYPES.join(' / ')}` })
    }

    const required = raw.required === undefined ? false : raw.required
    if (typeof required !== 'boolean') issues.push({ path: `${path}.required`, message: 'required 必须是布尔值' })

    const description = readString(raw.description)
    if (raw.description !== undefined && description === undefined) {
      issues.push({ path: `${path}.description`, message: 'description 必须是字符串' })
    }

    const hasDefault = Object.prototype.hasOwnProperty.call(raw, 'default')
    if (hasDefault && type !== undefined && !inputValueMatchesType(raw.default, type)) {
      issues.push({ path: `${path}.default`, message: `默认值必须符合 ${type} 类型` })
    }
    if (name === undefined || name === '' || type === undefined || typeof required !== 'boolean') continue

    inputs.push({
      name,
      type,
      required,
      ...(hasDefault ? { default: raw.default } : {}),
      ...(description === undefined ? {} : { description }),
    })
  }
  return { inputs, issues }
}

function parseWorkflowWidgets(input: unknown): {
  readonly widgets: WorkflowWidgetDefinition[]
  readonly issues: ValidationIssue[]
} {
  if (input === undefined || input === null) return { widgets: [], issues: [] }
  if (!Array.isArray(input)) return { widgets: [], issues: [{ path: 'widgets', message: 'widgets 必须是数组' }] }

  const widgets: WorkflowWidgetDefinition[] = []
  const issues: ValidationIssue[] = []
  const ids = new Set<string>()
  for (const [index, raw] of input.entries()) {
    const path = `widgets[${index}]`
    if (!isRecord(raw)) {
      issues.push({ path, message: 'widget 必须是对象' })
      continue
    }

    const id = readString(raw.id)?.trim()
    if (id === undefined || id === '') issues.push({ path: `${path}.id`, message: '缺少 widget id' })
    else if (ids.has(id)) issues.push({ path: `${path}.id`, message: `widget id 重复：${id}` })
    else ids.add(id)

    const type = readString(raw.type)?.trim()
    if (type === undefined || type === '') issues.push({ path: `${path}.type`, message: '缺少 widget type' })
    const title = readString(raw.title)?.trim()
    if (title === undefined || title === '') issues.push({ path: `${path}.title`, message: '缺少 widget title' })

    const emitOn = isRecord(raw.emit_on) ? raw.emit_on : undefined
    const emitOnNode = readString(raw.emit_on_node) ?? readString(raw.emitOnNode) ?? readString(emitOn?.node)
    const emitOnEvent = readString(raw.emit_on_event) ?? readString(raw.emitOnEvent) ?? readString(emitOn?.event)
    if (emitOnNode === undefined || emitOnNode.trim() === '') {
      issues.push({ path: `${path}.emit_on_node`, message: '缺少 widget emit_on_node' })
    }
    if (emitOnEvent === undefined || emitOnEvent.trim() === '') {
      issues.push({ path: `${path}.emit_on_event`, message: '缺少 widget emit_on_event' })
    }

    const props = raw.props
    if (props !== undefined && !isRecord(props)) {
      issues.push({ path: `${path}.props`, message: 'widget props 必须是对象' })
    }
    if (
      id === undefined || id === '' || type === undefined || type === '' || title === undefined || title === ''
      || emitOnNode === undefined || emitOnNode.trim() === '' || emitOnEvent === undefined || emitOnEvent.trim() === ''
      || (props !== undefined && !isRecord(props))
    ) continue

    widgets.push({
      id,
      type,
      title,
      emitOnNode,
      emitOnEvent,
      ...(isRecord(props) ? { props: { ...props } } : {}),
    })
  }
  return { widgets, issues }
}
function parseWorkflowCandidate(input: unknown): {
  readonly ok: boolean
  readonly value: WorkflowDefinition | null
  readonly issues: readonly ValidationIssue[]
} {
  const issues: ValidationIssue[] = []
  let hasFatalIssue = false
  const reportFatal = (issue: ValidationIssue): void => {
    issues.push(issue)
    hasFatalIssue = true
  }

  if (!isRecord(input)) return { ok: false, value: null, issues: [{ path: '', message: '工作流定义必须是对象' }] }

  const workflowId = readString(input.workflow_id) ?? readString(input.workflowId)
  if (workflowId === undefined || workflowId.trim() === '') reportFatal({ path: 'workflow_id', message: '缺少 workflow_id' })

  const rawName = readString(input.name)
  if (input.name !== undefined && (rawName === undefined || rawName.trim() === '')) {
    reportFatal({ path: 'name', message: 'name 必须是非空字符串' })
  }
  const name = rawName?.trim() ?? workflowId?.trim() ?? ''

  const rawDescription = readString(input.description)
  if (input.description !== undefined && rawDescription === undefined) {
    reportFatal({ path: 'description', message: 'description 必须是字符串' })
  }

  const businessId = readString(input.business_id) ?? readString(input.businessId)
  if (businessId === undefined || businessId === '') {
    issues.push({ path: 'business_id', message: '缺少 business_id，使用产物路径前需要补齐' })
  } else if (!isRelativeArtifactPath(`${businessId}/x`) || businessId.includes('/') || businessId.includes('\\')) {
    reportFatal({ path: 'business_id', message: `business_id 必须是单段相对名：${businessId}` })
  }

  const version = typeof input.version === 'number' && Number.isFinite(input.version) && input.version >= 1 ? input.version : 1
  if (input.version !== undefined && (typeof input.version !== 'number' || !Number.isFinite(input.version) || input.version < 1)) {
    reportFatal({ path: 'version', message: 'version 必须是大于等于 1 的有限数字' })
  }

  const parsedInputs = parseWorkflowInputs(input.inputs)
  for (const issue of parsedInputs.issues) reportFatal(issue)
  const parsedWidgets = parseWorkflowWidgets(input.widgets)
  for (const issue of parsedWidgets.issues) reportFatal(issue)

  const nodes = parseWorkflowNodes(input.nodes, issues)
  if (issues.some(issue => issue.path === 'nodes' || issue.path.startsWith('nodes.') || issue.path.startsWith('nodes['))) {
    hasFatalIssue = true
  }

  const ids = new Set<string>()
  let hasAwaitCommand = false
  for (const node of nodes) {
    if (ids.has(node.id)) reportFatal({ path: `nodes.${node.id}`, message: '节点 id 重复' })
    ids.add(node.id)
    if (node.type === 'await_command') {
      if (hasAwaitCommand) {
        reportFatal({
          path: `nodes.${node.id}.await_command_config`,
          message: '整个工作流最多只能有一个 await_command 节点',
        })
      }
      hasAwaitCommand = true
    }
  }
  for (const node of nodes) {
    for (const upstream of scheduleDependencies(node)) {
      if (upstream === node.id) reportFatal({ path: `nodes.${node.id}.after`, message: '节点不能依赖自身' })
      else if (!ids.has(upstream)) reportFatal({ path: `nodes.${node.id}.after`, message: `依赖不存在的节点：${upstream}` })
    }
  }
  for (const edge of dataEdges(nodes)) {
    if (!ids.has(edge.to)) reportFatal({ path: `nodes.${edge.from}.outputs`, message: `输出指向不存在的节点：${edge.to}` })
  }

  const dependencyCycle = findDependencyCycle(nodes)
  if (dependencyCycle !== undefined) {
    const { cycle } = dependencyCycle
    reportFatal({
      path: dependencyCycle.path,
      message: `依赖存在环：${cycle.join(' -> ')}`,
      kind: 'cycle',
      cycle,
      nodeIds: [...new Set(cycle.slice(0, -1))],
    })
  }

  const value: WorkflowDefinition = {
    workflowId: workflowId?.trim() ?? '',
    name,
    ...(rawDescription === undefined ? {} : { description: rawDescription }),
    version,
    ...(businessId === undefined || businessId === '' ? {} : { businessId }),
    inputs: parsedInputs.inputs,
    nodes,
    widgets: parsedWidgets.widgets,
  }
  return { ok: !hasFatalIssue, value, issues }
}

/**
 * Parse one workflow definition strictly.
 * @param input - YAML root or decoded wire value.
 * @returns the definition only when every fatal issue is absent.
 */
export function parseWorkflowDefinition(input: unknown): ValidationResult<WorkflowDefinition> {
  const candidate = parseWorkflowCandidate(input)
  return candidate.ok && candidate.value !== null
    ? { ok: true, value: candidate.value, issues: candidate.issues }
    : { ok: false, issues: candidate.issues }
}

/**
 * Parse as much of a workflow graph as possible for the visual editor.
 * @param input - YAML root or decoded wire value.
 * @returns the candidate definition when the root is an object, plus every issue.
 */
export function parseWorkflowGraph(input: unknown): WorkflowGraphResult {
  const candidate = parseWorkflowCandidate(input)
  return {
    ...(candidate.value === null ? {} : { value: candidate.value }),
    issues: candidate.issues,
  }
}
/**
 * The only scheduling edge rule: a node runs after its `after` list.
 * @param node - any node carrying the scheduling field.
 * @returns upstream node ids, in declaration order.
 */
export function scheduleDependencies(node: Pick<WorkflowNode, 'after'>): readonly string[] {
  return node.after
}

/**
 * The only data-flow edge rule: `outputs` maps a port to one or more receivers.
 * A data edge never delays execution; use {@link scheduleDependencies} for that.
 * @param nodes - every node in one workflow.
 * @returns one entry per declared output target.
 */
export function dataEdges(
  nodes: readonly {
    readonly id: string
    readonly outputs?: Readonly<Record<string, string | readonly string[]>>
  }[],
): readonly { readonly from: string; readonly to: string; readonly port: string }[] {
  const edges: { from: string; to: string; port: string }[] = []
  for (const node of nodes) {
    for (const [port, targets] of Object.entries(node.outputs ?? {})) {
      for (const to of typeof targets === 'string' ? [targets] : targets) edges.push({ from: node.id, to, port })
    }
  }
  return edges
}

/**
 * Group nodes into execution layers by `after` alone.
 *
 * Nodes in one layer have no dependency between them and may run in parallel;
 * a later layer starts only after the previous one settles.
 * @param nodes - every parsed node in one workflow.
 * @returns layers of node ids, source layer first.
 * @throws WorkflowCycleError when the dependency graph has a cycle.
 */
export function topoLayers(nodes: readonly WorkflowNode[]): readonly (readonly string[])[] {
  const pending = new Map(nodes.map(node => [node.id, new Set(scheduleDependencies(node))]))
  const layers: string[][] = []

  while (pending.size > 0) {
    const ready = [...pending.entries()].filter(([, deps]) => deps.size === 0).map(([id]) => id)
    if (ready.length === 0) throw new WorkflowCycleError([...pending.keys()])
    layers.push(ready)
    for (const id of ready) pending.delete(id)
    for (const deps of pending.values()) for (const id of ready) deps.delete(id)
  }
  return layers
}

/**
 * Assign schedule levels without failing on cycles.
 *
 * Nodes reachable only through a cycle receive `-1`, including their
 * downstream nodes. Independent acyclic components keep their normal levels so
 * the canvas can still display and highlight the broken region.
 * @param nodes - every parsed node in one workflow.
 * @returns one level entry per node, in declaration order.
 */
export function topoLevelsLenient(nodes: readonly WorkflowNode[]): readonly WorkflowNodeLevel[] {
  const byId = new Map(nodes.map(node => [node.id, node]))
  const state = new Map<string, 'visiting' | 'visited'>()
  const levels = new Map<string, number>()

  const visit = (id: string): number => {
    const known = state.get(id)
    if (known === 'visiting') return -1
    if (known === 'visited') return levels.get(id) ?? -1
    const node = byId.get(id)
    if (node === undefined) return -1
    state.set(id, 'visiting')
    let level = 0
    for (const dependency of node.after) {
      if (!byId.has(dependency)) continue
      const dependencyLevel = visit(dependency)
      if (dependencyLevel < 0) {
        level = -1
        break
      }
      level = Math.max(level, dependencyLevel + 1)
    }
    state.set(id, 'visited')
    levels.set(id, level)
    return level
  }

  return nodes.map(node => ({ id: node.id, level: visit(node.id) }))
}

/**
 * Serialize an Agent definition back to YAML.
 *
 * Every field is written, `tier` included. Dropping a field here is the defect
 * that silently changed an agent's tier on save, so the round-trip test asserts
 * full fidelity rather than key presence.
 * @param definition - a parsed definition.
 * @returns YAML text ending in one newline.
 */
export function serializeAgentDefinition(definition: AgentDefinition): string {
  return dump(
    {
      agent_id: definition.agentId,
      display_name: definition.displayName,
      domain: definition.domain,
      ...(definition.description === undefined ? {} : { description: definition.description }),
      harness: definition.harness,
      execution_backend: definition.executionBackend,
      model: definition.model === 'auto' ? 'auto' : { provider: definition.model.provider, id: definition.model.id },
      ...(definition.systemPrompt === undefined ? {} : { system_prompt: definition.systemPrompt }),
      tier: definition.tier,
      execution: definition.execution,
      ...(definition.workflow === undefined ? {} : { workflow: definition.workflow }),
      permissions: {
        allowed_tools: [...definition.permissions.allowedTools],
        denied_tools: [...definition.permissions.deniedTools],
      },
      ...(definition.knowledgeBases === undefined ? {} : { knowledge_bases: [...definition.knowledgeBases] }),
      ...(definition.timeoutSeconds === undefined ? {} : { timeout_seconds: definition.timeoutSeconds }),
      ...(definition.maxConcurrentRuns === undefined ? {} : { max_concurrent_runs: definition.maxConcurrentRuns }),
      ...(definition.costLimitPerRun === undefined ? {} : { cost_limit_per_run: definition.costLimitPerRun }),
      output_files: { ...definition.outputFiles },
    },
    { lineWidth: 120, noRefs: true, sortKeys: false },
  )
}
/**
 * Parse YAML text into an Agent definition.
 * @param text - the file contents.
 * @returns the definition, or every issue found.
 */
export function loadAgentDefinition(text: string): ValidationResult<AgentDefinition> {
  return parseAgentDefinition(load(text))
}

/**
 * Parse YAML text into a workflow definition.
 * @param text - the file contents.
 * @returns the definition, or every issue found.
 */
export function loadWorkflowDefinition(text: string): ValidationResult<WorkflowDefinition> {
  let input: unknown
  try {
    input = load(text)
  } catch (reason) {
    if (reason instanceof YAMLException) {
      return {
        ok: false,
        issues: [{
          path: '',
          message: reason.reason,
          kind: 'yaml',
          line: reason.mark.line + 1,
          column: reason.mark.column + 1,
        }],
      }
    }
    throw reason
  }

  const parsed = parseWorkflowDefinition(input)
  const issues = locateIssues(text, parsed.issues)
  return parsed.ok ? { ok: true, value: parsed.value, issues } : { ok: false, issues }
}

/**
 * Parse YAML into the largest usable workflow graph.
 * @param text - the file contents or editor draft.
 * @returns the candidate definition when recoverable, plus source-located issues.
 */
export function loadWorkflowGraph(text: string): WorkflowGraphResult {
  let input: unknown
  try {
    input = load(text)
  } catch (reason) {
    if (reason instanceof YAMLException) {
      return {
        issues: [{
          path: '',
          message: reason.reason,
          kind: 'yaml',
          line: reason.mark.line + 1,
          column: reason.mark.column + 1,
        }],
      }
    }
    throw reason
  }

  const parsed = parseWorkflowGraph(input)
  const issues = locateIssues(text, parsed.issues)
  return {
    ...(parsed.value === undefined ? {} : { value: parsed.value }),
    issues,
  }
}
