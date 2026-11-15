/**
 * YAML loader for legacy AgentOps workflow files.
 *
 * The old files describe nodes as a mapping and route outputs with
 * `to: "node.in:port"`. This loader normalizes that shape into the engine's
 * definition without executing anything, and rejects unknown node types
 * instead of silently treating them as agents.
 */

import { load } from 'js-yaml'

import type {
  NodeType,
  WorkflowDefinition,
  WorkflowNode,
  WorkflowRunInputDefinition,
  WorkflowRunInputType,
} from './types.js'

const NODE_TYPES: readonly NodeType[] = ['agent', 'command', 'gateway', 'parallel_branch', 'while']
const INPUT_TYPES: readonly WorkflowRunInputType[] = ['string', 'integer', 'number', 'boolean', 'array']
const INPUT_KEYS = new Set(['name', 'type', 'required', 'default', 'description'])

/** Raised when a workflow YAML document does not match the expected schema. */
export class WorkflowParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WorkflowParseError'
  }
}

type MutableNode = { -readonly [K in keyof WorkflowNode]: WorkflowNode[K] }

interface RawNode {
  name?: unknown
  type?: unknown
  agent?: unknown
  inline_agent?: unknown
  business_role?: unknown
  harness?: unknown
  model?: unknown
  role_prompt?: unknown
  timeout_seconds?: unknown
  timeout_ms?: unknown
  command_config?: unknown
  await_command_config?: unknown
  after?: unknown
  outputs?: unknown
  condition?: unknown
  branches?: unknown
  body?: unknown
  continue_if?: unknown
  max_iterations?: unknown
  while_config?: unknown
  skip_if?: unknown
}

interface RawInput {
  name?: unknown
  type?: unknown
  required?: unknown
  default?: unknown
  description?: unknown
}

/**
 * Parse one workflow YAML document.
 * @param source - file contents.
 * @returns normalized definition (not yet validated).
 * @throws WorkflowParseError when the shape is unusable.
 */
export function parseWorkflowYaml(source: string): WorkflowDefinition {
  const doc = load(source)
  if (doc === null || typeof doc !== 'object') throw new WorkflowParseError('YAML 根节点必须是对象')

  const root = doc as Record<string, unknown>
  const name = asString(root.name)
  const description = asString(root.description)
  const id = asString(root.workflow_id) ?? asString(root.id) ?? name
  if (id === undefined) throw new WorkflowParseError('缺少 workflow_id')

  const inputs = normalizeInputs(root.inputs)
  const rawNodes = root.nodes
  if (rawNodes === null || typeof rawNodes !== 'object') throw new WorkflowParseError('缺少 nodes')

  const nodes: WorkflowNode[] = []
  if (Array.isArray(rawNodes)) {
    for (const item of rawNodes) {
      if (item === null || typeof item !== 'object') throw new WorkflowParseError('节点必须是对象')
      const raw = item as RawNode & { id?: unknown }
      const nodeId = asString(raw.id)
      if (nodeId === undefined) throw new WorkflowParseError('列表形式的节点必须带 id')
      nodes.push(normalizeNode(nodeId, raw))
    }
  } else {
    for (const [nodeId, item] of Object.entries(rawNodes)) {
      if (item === null || typeof item !== 'object') throw new WorkflowParseError(`节点 ${nodeId} 必须是对象`)
      nodes.push(normalizeNode(nodeId, item as RawNode))
    }
  }

  return {
    id,
    ...(name === undefined ? {} : { name }),
    ...(description === undefined ? {} : { description }),
    inputs,
    nodes,
  }
}

function normalizeInputs(raw: unknown): WorkflowRunInputDefinition[] {
  if (raw === undefined) return []
  if (!Array.isArray(raw)) throw new WorkflowParseError('inputs 必须是数组')

  const names = new Set<string>()
  return raw.map((item, index) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      throw new WorkflowParseError(`inputs[${index}] 必须是对象`)
    }
    const input = item as RawInput
    for (const key of Object.keys(input)) {
      if (!INPUT_KEYS.has(key)) throw new WorkflowParseError(`输入参数含未知字段：${key}`)
    }

    const name = asString(input.name)
    if (name === undefined) throw new WorkflowParseError(`inputs[${index}] 缺少 name`)
    if (names.has(name)) throw new WorkflowParseError(`输入参数重复：${name}`)
    names.add(name)

    const type = asString(input.type)
    if (type === undefined || !INPUT_TYPES.includes(type as WorkflowRunInputType)) {
      throw new WorkflowParseError(`输入参数 ${name} 的 type 不支持：${type ?? '(缺失)'}`)
    }
    const inputType = type as WorkflowRunInputType

    let required = false
    if (input.required !== undefined) {
      if (typeof input.required !== 'boolean') {
        throw new WorkflowParseError(`输入参数 ${name} 的 required 必须是布尔值`)
      }
      required = input.required
    }

    let description: string | undefined
    if (input.description !== undefined) {
      if (typeof input.description !== 'string') {
        throw new WorkflowParseError(`输入参数 ${name} 的 description 必须是字符串`)
      }
      const trimmed = input.description.trim()
      if (trimmed.length > 0) description = trimmed
    }

    const definition: WorkflowRunInputDefinition = { name, type: inputType, required }
    if (Object.hasOwn(input, 'default')) {
      definition.default = normalizeDefault(name, inputType, input.default)
    }
    if (description !== undefined) definition.description = description
    return definition
  })
}

function normalizeDefault(
  name: string,
  type: WorkflowRunInputType,
  value: unknown,
): unknown {
  switch (type) {
    case 'string':
      if (typeof value === 'string') return value
      break
    case 'integer': {
      const number = numericDefault(value)
      if (number !== undefined && Number.isSafeInteger(number)) return number
      break
    }
    case 'number': {
      const number = numericDefault(value)
      if (number !== undefined) return number
      break
    }
    case 'boolean':
      if (typeof value === 'boolean') return value
      if (typeof value === 'string') {
        const normalized = value.trim()
        if (normalized === 'true') return true
        if (normalized === 'false') return false
      }
      break
    case 'array': {
      const candidate = typeof value === 'string' ? parseJsonArray(value) : value
      if (Array.isArray(candidate) && candidate.every(isJsonValue)) return candidate
      break
    }
  }
  throw new WorkflowParseError(`输入参数 ${name} 的默认值不符合 ${type} 类型`)
}

function numericDefault(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value !== 'string' || value.trim().length === 0) return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function parseJsonArray(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return undefined
  }
}

function isJsonValue(value: unknown): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(isJsonValue)
  if (typeof value !== 'object') return false
  const prototype = Reflect.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return false
  return Object.values(value).every(isJsonValue)
}

function normalizeNode(id: string, raw: RawNode): WorkflowNode {
  const declaredType = asString(raw.type)
  // A node that only declares `inline_agent` must not silently degrade into an
  // agent node with no preset: that path makes it inherit the caller's whole
  // composition, which is the permission leak the workflow-ownership model
  // closes. Failing loud keeps the "one workflow, one Agent" rule enforceable.
  if (raw.inline_agent !== undefined && declaredType === undefined) {
    throw new WorkflowParseError(
      `节点 ${id} 声明了 inline_agent 但未声明 type；工作流节点不允许 inline_agent（权限由所属 Agent 统一定义）`,
    )
  }
  if (raw.inline_agent !== undefined) {
    throw new WorkflowParseError(
      `节点 ${id} 声明了 inline_agent；工作流节点不允许 inline_agent（权限由所属 Agent 统一定义）`,
    )
  }
  const type = declaredType ?? 'agent'
  if (!NODE_TYPES.includes(type as NodeType)) {
    throw new WorkflowParseError(`节点 ${id} 的 type 不支持：${type}`)
  }
  if (type === 'agent' && raw.agent === undefined) {
    // Legacy files may omit `agent` when they meant inline execution; under the
    // ownership model that is unsatisfiable, so it fails at parse time instead
    // of inheriting the caller's tools at run time.
    throw new WorkflowParseError(`agent 节点 ${id} 缺少 agent 引用（节点权限由所属 Agent 统一定义，不允许内联或继承）`)
  }

  const node: MutableNode = {
    id,
    type: type as NodeType,
    after: asStringArray(raw.after),
  }

  const displayName = asString(raw.name)
  if (displayName !== undefined) node.displayName = displayName

  const agentRef = asString(raw.agent)
  if (agentRef !== undefined) node.agentRef = agentRef

  const businessRole = asString(raw.business_role)
  if (businessRole !== undefined) node.businessRole = businessRole

  const harness = asString(raw.harness)
  if (harness !== undefined) node.harness = harness

  const model = asString(raw.model)
  if (model !== undefined) node.model = model

  const rolePrompt = asString(raw.role_prompt)
  if (rolePrompt !== undefined) node.rolePrompt = rolePrompt

  const timeoutSeconds = readPositiveNumber(raw.timeout_seconds, `节点 ${id} 的 timeout_seconds`)
  const timeoutMs = readPositiveNumber(raw.timeout_ms, `节点 ${id} 的 timeout_ms`)
  if (timeoutSeconds !== undefined && timeoutMs !== undefined) {
    throw new WorkflowParseError(`节点 ${id} 不能同时声明 timeout_seconds 与 timeout_ms`)
  }
  if (timeoutSeconds !== undefined) node.timeoutMs = timeoutSeconds * 1000
  if (timeoutMs !== undefined) node.timeoutMs = timeoutMs

  const commandConfig = asRecord(raw.command_config, `节点 ${id} 的 command_config`)
  if (commandConfig !== undefined) node.commandConfig = commandConfig
  const awaitCommandConfig = asRecord(raw.await_command_config, `节点 ${id} 的 await_command_config`)
  if (awaitCommandConfig !== undefined) node.awaitCommandConfig = awaitCommandConfig

  const outputs = normalizeOutputs(raw.outputs)
  if (outputs !== undefined) node.outputs = outputs

  const condition = asString(raw.condition)
  if (condition !== undefined) node.condition = condition

  const branches = asStringArray(raw.branches)
  if (branches.length > 0) node.branches = branches

  const skipIf = asString(raw.skip_if)
  if (skipIf !== undefined) node.skipIf = skipIf

  if (type === 'while') {
    const config = asRecord(raw.while_config, `节点 ${id} 的 while_config`) ?? {}
    if (raw.while_config !== undefined && raw.while_config !== null) node.whileConfig = config
    const body = asStringArray(raw.body).length > 0 ? asStringArray(raw.body) : asStringArray(config.body)
    const continueIf = asString(raw.continue_if) ?? asString(config.continue_if)
    const maxIterations = asNumber(raw.max_iterations) ?? asNumber(config.max_iterations)
    if (body.length > 0) node.body = body
    if (continueIf !== undefined) node.continueIf = continueIf
    if (maxIterations !== undefined) node.maxIterations = maxIterations
  }

  return node
}

function normalizeOutputs(raw: unknown): Record<string, string[]> | undefined {
  if (raw === null || typeof raw !== 'object') return undefined
  const outputs: Record<string, string[]> = {}
  for (const [port, spec] of Object.entries(raw as Record<string, unknown>)) {
    // A port with no target is still a port: it is how a terminal node declares
    // what it delivers. Dropping it would leave the last node with no output
    // schema, so its answer could only come back as an empty object.
    if (spec === undefined || spec === null) continue
    outputs[port] = targetsOf(spec)
  }
  return Object.keys(outputs).length === 0 ? undefined : outputs
}

function targetsOf(spec: unknown): string[] {
  if (typeof spec === 'string') {
    const id = nodeIdOf(spec)
    return id.length === 0 ? [] : [id]
  }
  if (Array.isArray(spec)) return spec.flatMap(item => targetsOf(item))
  if (spec !== null && typeof spec === 'object') {
    const to = (spec as { to?: unknown }).to
    if (to !== undefined) return targetsOf(to)
  }
  return []
}

/** `"step2.in:fetched"` → `"step2"`; plain ids pass through. */
function nodeIdOf(target: string): string {
  const marker = target.indexOf('.in:')
  return (marker === -1 ? target : target.slice(0, marker)).trim()
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

function asStringArray(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string')
}

function readPositiveNumber(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null) return undefined
  const number = typeof value === 'number' ? value : Number.NaN
  if (!Number.isFinite(number) || number <= 0) {
    throw new WorkflowParseError(`${label} 必须是正数`)
  }
  return number
}

function asRecord(value: unknown, label: string): Record<string, unknown> | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new WorkflowParseError(`${label} 必须是对象`)
  }
  return value as Record<string, unknown>
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}
