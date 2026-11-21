/**
 * DSH plugin surface for the AgentOps DAG engine.
 *
 * Model-facing tools validate, run, and rerun workflows. A run spawns one
 * subagent per `agent` node through `ctx.subagents`; definitions come from
 * workflow YAML or the configured workflow catalog.
 *
 * @module @agentops/dsh-dag/dsh
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import { defineTool, isPlainJsonRecord, validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import type { ObjectJsonSchema, ParameterPropertySpec, ValueSchemaSpec } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SubagentRuntime, SubagentResult } from '@deepseek-ai/dsh-subagent'
import { delegationDepthOf } from '@deepseek-ai/dsh-subagent'

import { mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { DagEngine, invalidateRunForNode, RunMutationError } from './engine.ts'
import { registerRunActivityRoute, registerRunRoutes } from './runs.ts'
import { SqliteRunStore } from './run-store.ts'
import { registerWorkflowEditorRoutes } from './workflow-editor.ts'
import { registerWorkflowRerunRoute } from './workflow-rerun.ts'
import { registerWorkflowRoute, scanWorkflows } from './workflows.ts'
import {
  createWorkflowRunHandler,
  createWorkflowRunHintHandler,
  describeDeclaredInputs,
  resolveWorkflowRunInputs,
} from './workflow-run.ts'
import { parseWorkflowYaml } from './load.ts'
import { validateWorkflow } from './validate.ts'
import type { ValidationResult } from './validate.ts'
import type {
  NodeExecutor,
  RunState,
  WorkflowDefinition,
  WorkflowNode,
  WorkflowRunInputDefinition,
} from './types.ts'

export const name = 'agentops-dag'

/** 本插件会注册的工具名（`only` 的合法取值）。 */
export const TOOL_NAMES = ['dag_catalog', 'dag_validate', 'dag_run', 'dag_rerun', 'list_runs'] as const

/**
 * Root scope: `tools` is Agent-scoped, so the DAG tools are mounted by
 * `./tools.ts` from a preset.
 */
export const inject: string[] = []

/** Configuration of the DAG plugin: workflow directory, run database, and node limits. */
export interface DagPluginConfig {
  /** Directory holding legacy workflow YAML files, for the catalog route. */
  workflowDir?: string
  /** SQLite file holding run history. */
  runDbPath?: string
  /** Subagent provider used for `agent` nodes. Default `spawn`. */
  provider?: string
  /** Nodes executed at once. Default 4. */
  concurrency?: number
  /** Upstream JSON embedded in a node prompt, in characters. Default 8000. */
  maxUpstreamChars?: number
  /**
   * Workflow id this Agent preset owns; when set, `dag_run` runs only this
   * workflow and ignores a model-supplied `workflowId`. The pinning lives in
   * the preset that mounts the tool, so the model can never drive a workflow
   * its Agent does not own.
   */
  ownedWorkflowId?: string
  /** Agent preset every node subagent is forced to; omission is a configuration error for pinned tools. */
  ownerAgentPreset?: string
}


/** `only` 过滤器：undefined = 全注册；空数组 = 全禁；未知名字一律抛错（防拼错后静默失效）。 */
function onlyRegistrar(
  ctx: Context,
  only: readonly string[] | undefined,
  known: readonly string[],
): (definition: Parameters<Context['tools']['register']>[0]) => void {
  if (only !== undefined) {
    for (const name of only) {
      if (!known.includes(name)) {
        throw new Error(`only 含本插件不注册的工具 "${name}"；已知：${known.join(', ')}`)
      }
    }
  }
  const allow = only === undefined ? undefined : new Set(only)
  return (definition) => {
    if (allow === undefined || allow.has(definition.name)) ctx.tools.register(definition)
  }
}

/** Default DAG configuration, overridable from `cordis.yml`. */
export const DEFAULT_CONFIG: DagPluginConfig = {
  workflowDir: process.env.AGENTOPS_WORKFLOW_DIR ?? '',
  provider: 'spawn',
  concurrency: 4,
  maxUpstreamChars: 8000,
}

/**
 * Split the YAML document into definition and validation.
 * @param source - workflow YAML.
 * @returns the parsed definition together with its validation result.
 */
export function inspectWorkflow(source: string): { workflow: WorkflowDefinition; validation: ValidationResult } {
  const workflow = parseWorkflowYaml(source)
  return { workflow, validation: validateWorkflow(workflow) }
}

/**
 * Build the prompt for one agent node.
 * @param node - node being executed.
 * @param inputs - top-level workflow run inputs.
 * @param upstream - completed upstream outputs.
 * @param maxChars - shared cap for both embedded JSON payloads.
 * @returns prompt containing node identity, run inputs, and upstream outputs.
 */
export function nodePrompt(
  node: WorkflowNode,
  inputs: Readonly<Record<string, unknown>>,
  upstream: Readonly<Record<string, unknown>>,
  maxChars: number,
): string {
  const embedded = boundedPayloads(safeJson(inputs), safeJson(upstream), maxChars)
  const ports = Object.keys(node.outputs ?? {})
  return [
    `你是工作流节点 ${node.id}。`,
    '只完成本节点职责，输出将作为上游结果传给下游。',
    ...(node.rolePrompt === undefined ? [] : [`节点职责：\n${node.rolePrompt}`]),
    ports.length === 0
      ? '输出端口：无。最终回复必须是一个 JSON 对象 `{}`。'
      : `输出端口：${ports.join(', ')}。最终回复必须是一个 JSON 对象，键必须严格等于这些端口名；不得包含 Markdown 代码块、解释文字或额外键。`,
    `运行输入（JSON${embedded.inputsTruncated ? '，已截断' : ''}）：${embedded.inputs}`,
    `上游输出（JSON${embedded.upstreamTruncated ? '，已截断' : ''}）：${embedded.upstream}`,
  ].join('\n')
}

/**
 * Build the object schema enforced on one agent node's output ports.
 * @param node - node whose declared output ports become required object keys.
 * @returns a strict object schema, or undefined when the node declares no ports.
 */
export function nodeOutputSchema(node: WorkflowNode): ObjectJsonSchema | undefined {
  const ports = Object.keys(node.outputs ?? {})
  if (ports.length === 0) return undefined
  return {
    type: 'object',
    properties: Object.fromEntries(ports.map(port => [port, {}])),
    required: ports,
    additionalProperties: false,
  }
}

function boundedPayloads(
  inputs: string,
  upstream: string,
  maxChars: number,
): { inputs: string; upstream: string; inputsTruncated: boolean; upstreamTruncated: boolean } {
  const limit = Number.isFinite(maxChars) ? Math.max(0, Math.floor(maxChars)) : 0
  if (inputs.length + upstream.length <= limit) {
    return { inputs, upstream, inputsTruncated: false, upstreamTruncated: false }
  }

  const firstHalf = Math.floor(limit / 2)
  let inputsBudget: number
  let upstreamBudget: number
  if (inputs.length <= firstHalf) {
    inputsBudget = inputs.length
    upstreamBudget = Math.min(upstream.length, limit - inputsBudget)
  } else if (upstream.length <= limit - firstHalf) {
    upstreamBudget = upstream.length
    inputsBudget = Math.min(inputs.length, limit - upstreamBudget)
  } else {
    inputsBudget = firstHalf
    upstreamBudget = limit - firstHalf
  }

  return {
    inputs: inputs.slice(0, inputsBudget),
    upstream: upstream.slice(0, upstreamBudget),
    inputsTruncated: inputsBudget < inputs.length,
    upstreamTruncated: upstreamBudget < upstream.length,
  }
}

/**
 * Create the subagent-backed node executor.
 * @param subagents - runtime seam from the host.
 * @param config - provider and prompt budget.
 * @param parentOf - resolves the agent the node's subagent is spawned from.
 * @param ownerAgentPreset - preset every node subagent runs under; overrides the node's own agent reference.
 * @returns executor usable by {@link DagEngine}.
 */
export function createSubagentExecutor(
  subagents: SubagentRuntime,
  config: DagPluginConfig = DEFAULT_CONFIG,
  parentOf: () => Agent | undefined = () => undefined,
  ownerAgentPreset?: string,
): NodeExecutor {
  const maxChars = config.maxUpstreamChars ?? 8000
  return async (node, context) => {
    if (node.type === 'command') {
      throw new Error(`command 节点 ${node.id} 尚未在 DSH 中执行；请改用原生工具（如 sql_query）`)
    }
    if (node.type !== 'agent') {
      throw new Error(`节点 ${node.id} 的 ${node.type} 类型没有子代理执行器`)
    }

    const parent = parentOf()
    if (parent === undefined) throw new Error('DAG 节点缺少父 Agent，无法派生子代理')
    const agentOptions = parseAgentOptions(node.model)
    const signal = combineSignals(context.signal, node.timeoutMs)
    const outputSchema = nodeOutputSchema(node)
    // Node subagents always run the owning Agent's preset. Falling back to the
    // caller's standing composition (the subagent runtime default) would give a
    // node whatever tools its caller holds — the exact permission leak the
    // workflow-ownership model exists to close — so a node without an explicit
    // owner fails loudly instead of inheriting silently.
    const agentPreset = ownerAgentPreset ?? node.agentRef
    if (agentPreset === undefined) {
      throw new Error(`节点 ${node.id} 既没有所属 Agent preset，也没有 agentRef：拒绝按调用方权限继承执行`)
    }
    const activation = await subagents.startActivation({
      provider: config.provider ?? 'spawn',
      label: node.businessRole === undefined ? node.id : `${node.businessRole} (${node.id})`,
      request: {
        prompt: [{ type: 'text', text: nodePrompt(node, context.inputs, context.upstream, maxChars) }],
        parent,
        agentPreset,
        ...(agentOptions === undefined ? {} : { agentOptions }),
        ...(outputSchema === undefined ? {} : { outputSchema }),
      },
      signal,
      delivery: 'caller',
    })
    try {
      const result: SubagentResult = await activation.result
      if (result.stopReason !== 'completed') {
        throw new Error(`子代理未完成：${result.stopReason}${result.diagnostic === undefined ? '' : ` ${result.diagnostic}`}`)
      }
      if (outputSchema === undefined) return {}
      const value = result.structured === undefined ? parseNodeJson(node, textOf(result)) : result.structured
      const violations = validateJsonSchemaValue(outputSchema, value, 'outputs')
      if (violations.length > 0) {
        throw new Error(`节点 ${node.id} 的输出不符合端口协议：${violations.join('; ')}`)
      }
      if (!isPlainJsonRecord(value)) {
        throw new Error(`节点 ${node.id} 的输出必须是 JSON 对象`)
      }
      return value
    } finally {
      await activation.dispose()
    }
  }
}

function parseNodeJson(node: WorkflowNode, text: string): unknown {
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new Error(`节点 ${node.id} 的最终输出不是合法 JSON：${errorMessage(error)}`)
  }
}

function parseAgentOptions(model: string | undefined): { provider?: string; model: string } | undefined {
  if (model === undefined) return undefined
  const marker = model.indexOf('/')
  if (marker === -1) return { model }
  const provider = model.slice(0, marker).trim()
  const name = model.slice(marker + 1).trim()
  if (provider.length === 0 || name.length === 0) throw new Error(`节点模型 "${model}" 必须使用 provider/model 格式`)
  return { provider, model: name }
}

function combineSignals(signal: AbortSignal | undefined, timeoutMs: number | undefined): AbortSignal {
  const timeout = timeoutMs === undefined ? undefined : AbortSignal.timeout(timeoutMs)
  if (signal === undefined) return timeout ?? new AbortController().signal
  return timeout === undefined ? signal : AbortSignal.any([signal, timeout])
}

/**
 * Root mount: catalog, history, editor, and run routes.
 * @param ctx - Cordis context.
 * @param config - workflow directory and run persistence.
 */
export function apply(ctx: Context, config: DagPluginConfig = DEFAULT_CONFIG): void {
  const dir = config.workflowDir?.trim() ?? ''
  const runDb = resolveRunDbPath(config)
  ctx.inject(['connection', 'workflowCatalog'], (editorCtx) => {
    registerWorkflowEditorRoutes(editorCtx)
  })

  ctx.inject(['connection'], (connectionCtx) => {
    if (dir.length > 0) registerWorkflowRoute(connectionCtx, dir)
    mkdirSync(dirname(runDb), { recursive: true })
    const store = new SqliteRunStore(runDb)
    connectionCtx.effect(() => () => { store.close() }, 'agentops-dag: close run store')
    registerRunRoutes(connectionCtx, store)

    if (dir.length > 0) {
      registerWorkflowRerunRoute(
        connectionCtx,
        dir,
        store,
        () => connectionCtx.get('sessionController'),
      )
    }

    connectionCtx.inject(['workflowCatalog'], (catalogCtx) => {
      registerRunActivityRoute(
        catalogCtx,
        store,
        id => catalogCtx.workflowCatalog.readSource(id),
      )
    })

    if (dir.length > 0) {
      connectionCtx.inject(['sessionController'], (sessionCtx) => {
        sessionCtx.effect(() => sessionCtx.connection.fetch.register({
          path: '/api/agentops/workflow-run',
          methods: ['POST'],
          requestBody: 'buffered',
          fetch: createWorkflowRunHandler(dir, sessionCtx.sessionController),
        }), 'agentops-dag: /api/agentops/workflow-run')
      })

      connectionCtx.effect(() => connectionCtx.connection.fetch.register({
        path: '/api/agentops/workflow-run-hint',
        methods: ['GET'],
        requestBody: 'buffered',
        fetch: createWorkflowRunHintHandler(dir),
      }), 'agentops-dag: /api/agentops/workflow-run-hint')
    }
  })
}
/**
 * Resolve the run-history database path: config, then `AGENTOPS_RUN_DB`, then
 * `$DSH_HOME/agentops/runs.db`.
 * @param config - plugin configuration.
 * @returns the resolved run-history database path.
 */
export function resolveRunDbPath(config: DagPluginConfig = DEFAULT_CONFIG): string {
  const explicit = config.runDbPath?.trim()
  if (explicit !== undefined && explicit.length > 0) return explicit
  const fromEnv = process.env.AGENTOPS_RUN_DB?.trim()
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv
  return join(process.env.DSH_HOME?.trim() ?? join(homedir(), '.dsh'), 'agentops', 'runs.db')
}

/** JSON data carried by a workflow input default. */
type JsonDefault = null | boolean | number | string | JsonDefault[] | { [key: string]: JsonDefault }

/**
 * Narrow a workflow input default to JSON data.
 *
 * The workflow parser rejects a default that is not lossless JSON, so this
 * restates that guarantee for the tool payload.
 * @param value - default value declared in the workflow source.
 * @returns the value when it is JSON data, otherwise undefined.
 */
function jsonDefault(value: unknown): JsonDefault | undefined {
  if (value === null) return null
  if (typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') return value
  if (!Array.isArray(value)) return undefined
  const items: JsonDefault[] = []
  for (const item of value) {
    const narrowed = jsonDefault(item)
    if (narrowed === undefined) return undefined
    items.push(narrowed)
  }
  return items
}

/**
 * Run inputs declared by the workflow this tool is pinned to.
 *
 * A pinned tool knows its workflow when the preset mounts, so the model can be
 * told the real input names and requiredness instead of guessing at an opaque
 * object. The snapshot is taken at mount time: changing a workflow's input
 * declarations needs a restart before the tool schema follows.
 * @param config - plugin configuration carrying the owned workflow id and directory.
 * @returns the declared inputs, or undefined when the tool is not pinned.
 */
function ownedRunInputs(config: DagPluginConfig): readonly WorkflowRunInputDefinition[] | undefined {
  const ownedWorkflowId = config.ownedWorkflowId
  const dir = config.workflowDir?.trim() ?? ''
  if (ownedWorkflowId === undefined || dir.length === 0) return undefined
  const entry = scanWorkflows(dir).entries.find(item => item.id === ownedWorkflowId)
  return entry?.inputs
}

/**
 * Project one declared run input onto a tool parameter schema.
 * @param type - declared input type.
 * @returns the matching value schema.
 */
function inputValueSchema(type: WorkflowRunInputDefinition['type']): ValueSchemaSpec {
  switch (type) {
    case 'string': return { type: 'string' }
    case 'integer': return { type: 'integer' }
    case 'number': return { type: 'number' }
    case 'boolean': return { type: 'boolean' }
    case 'array': return { type: 'array', items: { type: 'json' } }
  }
}

/**
 * Build the `inputs` parameter of `dag_run`.
 * @param inputs - declared inputs of the pinned workflow, when the tool is pinned.
 * @returns a closed object schema for a pinned workflow, otherwise an open one.
 */
export function inputsParameter(inputs: readonly WorkflowRunInputDefinition[] | undefined): ParameterPropertySpec {
  if (inputs === undefined) {
    return {
      type: 'object',
      additionalProperties: true,
      description: '工作流顶层输入声明的取值；未声明的名字会被拒绝。',
    }
  }
  const properties: Record<string, ParameterPropertySpec> = {}
  for (const input of inputs) {
    properties[input.name] = {
      ...inputValueSchema(input.type),
      ...(input.required ? { required: true as const } : {}),
      ...(input.description === undefined ? {} : { description: input.description }),
    }
  }
  return {
    type: 'object',
    additionalProperties: false,
    description: describeDeclaredInputs({ inputs }),
    properties,
  }
}

/**
 * Render terminal node deliveries as text for the model.
 *
 * `dag_run` returns statuses and deliveries; a render that printed only the
 * status line left the caller without the answer the run existed to produce.
 * String ports (an `answer`) are printed as-is; anything else is JSON.
 * @param outputs - terminal node outputs keyed by node id, then by port.
 * @returns the delivery block, or a note when the run delivered nothing.
 */
export function deliveryText(outputs: Record<string, JsonValue>): string {
  const parts: string[] = []
  for (const [nodeId, ports] of Object.entries(outputs)) {
    if (!isPlainJsonRecord(ports)) {
      parts.push(`[${nodeId}]\n${safeJson(ports)}`)
      continue
    }
    for (const [port, payload] of Object.entries(ports)) {
      parts.push(`[${nodeId}.${port}]\n${typeof payload === 'string' ? payload : safeJson(payload)}`)
    }
  }
  return parts.length === 0 ? '本次运行没有产生终结节点交付。' : parts.join('\n\n')
}

/**
 * Render one run's node states and deliveries for a tool result.
 * @param head - first line naming the run and its status.
 * @param nodes - node states as reported by the tool.
 * @param error - run-level error, when the run failed.
 * @param historyError - run-history persistence problem, when one occurred.
 * @param outputs - terminal node outputs.
 * @returns one text block.
 */
function runReport(
  head: string,
  nodes: readonly { readonly id?: unknown; readonly status?: unknown; readonly error?: unknown }[],
  error: string | undefined,
  historyError: string | undefined,
  outputs: Record<string, JsonValue>,
): { type: 'text'; text: string } {
  const failures = nodes
    .filter(node => node.status === 'failed' || typeof node.error === 'string')
    .map(node => `  ${String(node.id)} ${String(node.status)}${typeof node.error === 'string' ? `：${node.error}` : ''}`)
  const lines = [head]
  if (error !== undefined) lines.push(`Error: ${error}`)
  if (historyError !== undefined) lines.push(`History: ${historyError}`)
  if (failures.length > 0) lines.push(`失败节点：\n${failures.join('\n')}`)
  lines.push('', deliveryText(outputs))
  return { type: 'text', text: lines.join('\n') }
}

/**
 * Mount the DAG tools (Agent scope only).
 * @param ctx - Cordis context.
 * @param config - provider, concurrency and prompt budget.
 */
export function applyDagTools(ctx: Context, config: DagPluginConfig = DEFAULT_CONFIG): void {
  const reg = onlyRegistrar(ctx, (config as { only?: readonly string[] }).only, TOOL_NAMES)
  reg(defineTool({
    name: 'dag_catalog',
    description:
      'List the workflows in the configured AgentOps workflow directory with their identity, '
      + 'description, declared run inputs, node count, and validation state. Read-only. '
      + 'Call this before choosing a workflowId for dag_run.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          workflowDir: { type: 'string', required: true },
          workflows: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                name: { type: 'string', required: true },
                description: { type: 'string' },
                nodeCount: { type: 'number', required: true },
                ok: { type: 'boolean', required: true },
                status: { type: 'string', required: true },
                errors: { type: 'array', required: true, items: { type: 'string' } },
                inputs: {
                  type: 'array',
                  required: true,
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      name: { type: 'string', required: true },
                      type: { type: 'string', required: true },
                      required: { type: 'boolean', required: true },
                      default: { type: 'json' },
                      description: { type: 'string' },
                    },
                  },
                },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.workflows.length === 0
          ? `工作流目录 ${value.workflowDir} 为空`
          : value.workflows.map((workflow) => {
            const inputs = workflow.inputs.map(input => input.name)
            return `${workflow.id} | ${workflow.name} | ${workflow.nodeCount} 节点 | ${workflow.ok ? '有效' : '无效'} | 输入：${inputs.join(', ') || '无'}`
          }).join('\n'),
      }],
    },
    execute() {
      const dir = config.workflowDir?.trim() ?? ''
      if (dir.length === 0) throw new Error('dag_catalog 必须配置 workflowDir')
      const catalog = scanWorkflows(dir)
      if (catalog.missing) throw new Error(`工作流目录不存在：${dir}`)
      const workflows = catalog.entries.map(entry => ({
        id: entry.id,
        name: entry.name,
        ...(entry.description === undefined ? {} : { description: entry.description }),
        nodeCount: entry.nodeCount,
        ok: entry.ok,
        status: entry.status,
        errors: [...entry.errors],
        inputs: entry.inputs.map((input) => {
          const defaultValue = input.default === undefined ? undefined : jsonDefault(input.default)
          return {
            name: input.name,
            type: input.type,
            required: input.required,
            ...(defaultValue === undefined ? {} : { default: defaultValue }),
            ...(input.description === undefined ? {} : { description: input.description }),
          }
        }),
      }))
      return Promise.resolve({ workflowDir: dir, workflows })
    },
  }))

  reg(defineTool({
    name: 'dag_validate',
    description:
      'Validate an AgentOps workflow YAML (legacy format) and return its execution levels. '
      + 'Read-only; use it before running or after editing a workflow.',
    parameters: {
      yaml: { type: 'string', required: true, description: 'Workflow YAML source.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          errors: { type: 'array', required: true, items: { type: 'string' } },
          levels: { type: 'array', required: true, items: { type: 'array', items: { type: 'string' } } },
          nodeCount: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.ok
          ? `Workflow valid: ${value.nodeCount} nodes, ${value.levels.length} levels.`
          : `Workflow invalid: ${value.errors.join('; ')}`,
      }],
    },
    execute(args) {
      try {
        const { workflow, validation } = inspectWorkflow(args.yaml)
        return Promise.resolve({
          ok: validation.ok,
          errors: [...validation.errors],
          levels: validation.levels.map(level => [...level]),
          nodeCount: workflow.nodes.length,
        })
      } catch (error) {
        return Promise.resolve({
          ok: false,
          errors: [error instanceof Error ? error.message : String(error)],
          levels: [],
          nodeCount: 0,
        })
      }
    },
  }))

  reg(defineTool({
    name: 'dag_run',
    description:
      'Run an AgentOps workflow by workflowId or YAML. Each agent node spawns one subagent; '
      + 'gateway/parallel/while are handled by the engine. Returns the runId and per-node status. '
      + 'Expensive: confirm with the user before running a long chain.',
    parameters: {
      workflowId: {
        type: 'string',
        description: config.ownedWorkflowId === undefined
          ? 'Workflow identity in the configured catalog.'
          : `本工具已绑定 ${config.ownedWorkflowId}，此参数可省略且会被忽略。`,
      },
      yaml: {
        type: 'string',
        description: config.ownedWorkflowId === undefined
          ? 'Workflow YAML source; mutually exclusive with workflowId.'
          : '本工具已绑定工作流，此参数可省略且会被忽略。',
      },
      inputs: inputsParameter(ownedRunInputs(config)),
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          runId: { type: 'string', required: true },
          status: { type: 'string', required: true },
          nodes: { type: 'array', required: true, items: { type: 'json' } },
          outputs: { type: 'object', required: true, additionalProperties: true },
          error: { type: 'string' },
          historyError: { type: 'string' },
        },
      },
      render: (_args, value) => {
        const nodes = value.nodes as { id?: unknown; status?: unknown; error?: unknown }[]
        const completed = nodes.filter(node => node.status === 'completed').length
        return [runReport(
          `Run ${value.runId} ${value.status}: ${completed}/${nodes.length} nodes completed.`,
          nodes,
          value.error,
          value.historyError,
          value.outputs,
        )]
      },
    },
    async execute(args, exec) {
      // A pinned tool (mounted by a workflow-owning Agent preset) resolves the
      // workflow from its configuration, so the model cannot drive another
      // Agent's workflow, and node subagents inherit the owning Agent preset
      // instead of whatever composition happens to hold at call time.
      const workflow = config.ownedWorkflowId !== undefined
        ? resolveRunWorkflow(config, config.ownedWorkflowId, undefined)
        : resolveRunWorkflow(config, args.workflowId, args.yaml)
      const pinned = config.ownerAgentPreset
      const subagents = ctx.get('subagents')
      if (subagents === undefined) throw new Error('缺少 subagents 服务，无法执行 agent 节点')
      if (exec.agent === undefined) throw new Error('dag_run 必须在会话轮次内调用（缺少父 Agent）')
      // A node inherits its owning Agent's preset, which carries this tool, so
      // recursion is reachable by construction unless it is refused here. The
      // depth gate is the only place that sees the calling Agent.
      //
      // The dispatching Agent is itself a delegated child (the dispatcher calls
      // it through `subagent`), so depth 1 is the legitimate case: dispatcher →
      // workflow Agent → nodes. A node sits at depth 2 and must not re-enter.
      if (delegationDepthOf(exec.agent) > 1) {
        throw new Error('dag_run 不能在工作流节点内调用：节点继承所属 Agent 的权限，不允许再启动工作流')
      }
      const resolution = resolveWorkflowRunInputs(workflow, args.inputs ?? {})
      if (!resolution.ok) throw new Error(`运行输入无效：${resolution.reason}`)

      const executor = createSubagentExecutor(subagents, config, () => exec.agent, pinned)
      const runId = `${workflow.id}@${new Date().toISOString()}`
      const actors = Object.fromEntries(
        workflow.nodes
          .filter(node => node.businessRole !== undefined)
          .map(node => [node.id, node.businessRole as string]),
      )
      const attribution = {
        agentId: pinned ?? workflow.id,
        sessionId: exec.agent.session.header.id,
        actors,
      }
      // One store for the whole run: a live run records its row before the
      // first node settles, then each settle updates that node, so supervision
      // can show progress instead of only a terminal snapshot.
      const history = openRunStore(config)
      let historyError = history.error
      try {
        try {
          history.store?.beginRun(runId, workflow.id, new Date().toISOString(), resolution.values, attribution)
        } catch (error) {
          historyError ??= `运行历史写入失败：${errorMessage(error)}`
        }
        const state = await new DagEngine().run(workflow, executor, {
          runId,
          inputs: resolution.values,
          concurrency: config.concurrency ?? 4,
          signal: exec.signal,
          onNodeSettled: (nodeId, nodeState) => {
            try {
              history.store?.saveNode(runId, nodeId, nodeState, actors[nodeId])
            } catch (error) {
              historyError ??= `运行历史写入失败：${errorMessage(error)}`
            }
          },
        })
        try {
          history.store?.save(state, workflow.id, attribution)
        } catch (error) {
          historyError ??= `运行历史保存失败：${errorMessage(error)}`
        }
        return {
          runId: state.runId,
          status: state.status,
          nodes: Object.entries(state.nodes).map(([id, node]) => ({
            id,
            status: node.status,
            attempts: node.attempts,
            ...(node.chosenPort === undefined ? {} : { chosenPort: node.chosenPort }),
            ...(node.error === undefined ? {} : { error: node.error }),
            ...(actors[id] === undefined ? {} : { actor: actors[id] }),
          })),
          // The caller is the Agent that owns this workflow, so it needs the
          // delivery of the nodes that end the graph — otherwise it can only see
          // statuses and has to guess the answer.
          outputs: terminalOutputs(workflow, state, config.maxUpstreamChars ?? 8000),
          ...(state.error === undefined ? {} : { error: state.error }),
          ...(historyError === undefined ? {} : { historyError }),
        }
      } finally {
        historyError ??= closeRunStore(history.store)
      }
    },
    presentCall: () => ({ card: 'generic', title: 'Run workflow', kind: 'other' }),
  }))

  reg(defineTool({
    name: 'dag_rerun',
    description:
      'Rerun one node of a persisted AgentOps workflow run. By default the node and every '
      + 'transitive downstream node run again; set onlyNode to preserve downstream results. '
      + 'Uses the original runId and the supplied run inputs.',
    parameters: {
      runId: { type: 'string', required: true, description: 'Persisted run identity.' },
      workflowId: { type: 'string', required: true, description: 'Workflow identity expected by the stored run.' },
      nodeId: { type: 'string', required: true, description: 'Node to execute again.' },
      onlyNode: { type: 'boolean', required: true, description: 'Preserve completed downstream nodes when true.' },
      inputs: { type: 'object', additionalProperties: true, required: true, description: 'Validated workflow run inputs.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          runId: { type: 'string', required: true },
          workflowId: { type: 'string', required: true },
          nodeId: { type: 'string', required: true },
          onlyNode: { type: 'boolean', required: true },
          status: { type: 'string', required: true },
          nodes: { type: 'array', required: true, items: { type: 'json' } },
          outputs: { type: 'object', required: true, additionalProperties: true },
          error: { type: 'string' },
          historyError: { type: 'string' },
        },
      },
      render: (_args, value) => {
        const nodes = value.nodes as { id?: unknown; status?: unknown; error?: unknown }[]
        return [runReport(
          `Rerun ${value.runId} node ${value.nodeId} (${value.onlyNode ? 'node only' : 'node and downstream'}) ${value.status}`,
          nodes,
          value.error,
          value.historyError,
          value.outputs,
        )]
      },
    },
    async execute(args, exec) {
      const subagents = ctx.get('subagents')
      if (subagents === undefined) throw new Error('缺少 subagents 服务，无法执行 agent 节点')
      if (exec.agent === undefined) throw new Error('dag_rerun 必须在会话轮次内调用（缺少父 Agent）')

      const runId = args.runId.trim()
      const workflowId = args.workflowId.trim()
      const nodeId = args.nodeId.trim()
      if (runId.length === 0) throw new Error('runId 不能为空')
      if (workflowId.length === 0) throw new Error('workflowId 不能为空')
      if (nodeId.length === 0) throw new Error('nodeId 不能为空')

      let store: SqliteRunStore | undefined
      let result: {
        runId: string
        workflowId: string
        nodeId: string
        onlyNode: boolean
        status: RunState['status']
        nodes: { id: string; status: string; attempts: number; chosenPort?: string; error?: string }[]
        outputs: Record<string, JsonValue>
        error?: string
        historyError?: string
      } | undefined
      let closeError: string | undefined
      try {
        store = new SqliteRunStore(resolveRunDbPath(config))
        const record = store.loadRecord(runId)
        if (record === null) throw new Error(`未知运行：${runId}`)
        if (record.workflowId !== workflowId) {
          throw new Error(`运行记录 workflowId ${record.workflowId} 与请求的 workflowId ${workflowId} 不匹配`)
        }

        const workflow = resolveRunWorkflow(config, workflowId, undefined)
        const resolution = resolveWorkflowRunInputs(workflow, args.inputs)
        if (!resolution.ok) throw new Error(`运行输入无效：${resolution.reason}`)

        let resumed: RunState
        try {
          resumed = invalidateRunForNode(record.state, workflow, nodeId, args.onlyNode)
        } catch (error) {
          if (error instanceof RunMutationError) throw new Error(error.message)
          throw error
        }

        try {
          store.save(resumed, workflowId)
        } catch (error) {
          throw new Error(`无法保存重跑中的运行历史：${errorMessage(error)}`)
        }

        const executor = createSubagentExecutor(subagents, config, () => exec.agent)
        const state = await new DagEngine().run(workflow, executor, {
          resume: resumed,
          inputs: resolution.values,
          concurrency: config.concurrency ?? 4,
          signal: exec.signal,
        })

        let historyError: string | undefined
        try {
          store.save(state, workflowId)
        } catch (error) {
          historyError = `运行历史保存失败：${errorMessage(error)}`
        }
        result = {
          runId: state.runId,
          workflowId,
          nodeId,
          onlyNode: args.onlyNode,
          status: state.status,
          nodes: nodeResults(state),
          outputs: terminalOutputs(workflow, state, config.maxUpstreamChars ?? 8000),
          ...(state.error === undefined ? {} : { error: state.error }),
          ...(historyError === undefined ? {} : { historyError }),
        }
      } finally {
        try {
          store?.close()
        } catch (error) {
          closeError = `运行历史关闭失败：${errorMessage(error)}`
        }
      }

      if (closeError === undefined) return result
      return {
        ...result,
        historyError: result.historyError === undefined
          ? closeError
          : `${result.historyError}；${closeError}`,
      }
    },
    presentCall: () => ({ card: 'generic', title: 'Rerun workflow node', kind: 'other' }),
  }))

  reg(defineTool({
    name: 'list_runs',
    description:
      'List recent workflow runs with their node statuses. Read-only. Use it to check whether a '
      + 'workflow actually started and how far it got, instead of inferring that from a reply. '
      + 'An empty list means no run has been recorded yet — it says nothing about whether the '
      + 'workflow exists. A pinned Agent preset sees only its own workflow.',
    parameters: {
      limit: { type: 'integer', description: 'How many runs to return; default 5, maximum 20.' },
      status: { type: 'string', description: 'Only runs in this state: running, completed, failed, cancelled.' },
      agentId: { type: 'string', description: 'Only runs owned by this Agent preset. A pinned preset always filters to itself.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          runs: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                runId: { type: 'string', required: true },
                workflowId: { type: 'string', required: true },
                status: { type: 'string', required: true },
                startedAt: { type: 'string', required: true },
                finishedAt: { type: 'string' },
                error: { type: 'string' },
                agentId: { type: 'string' },
                nodes: { type: 'array', required: true, items: { type: 'json' } },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: (value.runs as { runId: string; status: string }[]).length === 0
          ? 'No runs recorded.'
          : `Runs: ${(value.runs as { runId: string; status: string }[]).map(run => `${run.runId} ${run.status}`).join('; ')}`,
      }],
    },
    execute(args) {
      const limit = Math.min(Math.max(args.limit ?? 5, 1), 20)
      const history = openRunStore(config)
      if (history.store === undefined) throw new Error(history.error ?? '运行历史不可用')
      try {
        const summaries = history.store.listPage(limit, {
          ...(config.ownedWorkflowId === undefined ? {} : { workflowId: config.ownedWorkflowId }),
          ...(args.status === undefined ? {} : { status: args.status as RunState['status'] }),
          ...(args.agentId === undefined ? {} : { agentId: args.agentId }),
        })
        const runs = summaries.map((summary) => {
          const state = history.store?.load(summary.runId)
          return {
            runId: summary.runId,
            workflowId: summary.workflowId,
            status: summary.status,
            startedAt: summary.startedAt,
            ...(summary.finishedAt === undefined ? {} : { finishedAt: summary.finishedAt }),
            ...(summary.error === undefined ? {} : { error: summary.error }),
            ...(summary.agentId === undefined ? {} : { agentId: summary.agentId }),
            nodes: state === null || state === undefined
              ? []
              : Object.entries(state.nodes).map(([id, node]) => ({
                id,
                status: node.status,
                attempts: node.attempts,
                ...(node.error === undefined ? {} : { error: node.error }),
              })),
          }
        })
        return Promise.resolve({ runs })
      } finally {
        closeRunStore(history.store)
      }
    },
    presentCall: () => ({ card: 'generic', title: 'List workflow runs', kind: 'read' }),
  }))
}

function nodeResults(
  state: RunState,
): { id: string; status: string; attempts: number; chosenPort?: string; error?: string }[] {
  return Object.entries(state.nodes).map(([id, node]) => ({
    id,
    status: node.status,
    attempts: node.attempts,
    ...(node.chosenPort === undefined ? {} : { chosenPort: node.chosenPort }),
    ...(node.error === undefined ? {} : { error: node.error }),
  }))
}

function resolveRunWorkflow(
  config: DagPluginConfig,
  requestedId: string | undefined,
  yaml: string | undefined,
): WorkflowDefinition {
  const workflowId = requestedId?.trim() ?? ''
  if (workflowId.length > 0 && yaml !== undefined) {
    throw new Error('workflowId 与 yaml 只能提供一个')
  }
  if (workflowId.length > 0) {
    const dir = config.workflowDir?.trim() ?? ''
    if (dir.length === 0) throw new Error('按 workflowId 运行前必须配置 workflowDir')
    const summary = scanWorkflows(dir).entries.find(entry => entry.id === workflowId)
    if (summary === undefined) throw new Error(`未知工作流：${workflowId}`)
    if (!summary.ok) throw new Error(`工作流校验失败：${summary.errors.join('；')}`)
    const inspected = inspectWorkflow(readFileSync(join(dir, summary.file), 'utf8'))
    if (!inspected.validation.ok) {
      throw new Error(`工作流校验失败：${inspected.validation.errors.join('；')}`)
    }
    return inspected.workflow
  }
  if (yaml === undefined) throw new Error('必须提供 workflowId 或 yaml')
  const inspected = inspectWorkflow(yaml)
  if (!inspected.validation.ok) {
    throw new Error(`工作流校验失败：${inspected.validation.errors.join('；')}`)
  }
  return inspected.workflow
}

/**
 * Open the run-history store for one run, reporting an unopenable store as a
 * value instead of throwing: a broken history database must not abort a
 * workflow that would otherwise complete.
 * @param config - plugin configuration carrying the database path.
 * @returns the open store or the reason it could not be opened.
 */
function openRunStore(config: DagPluginConfig): { store?: SqliteRunStore; error?: string } {
  try {
    return { store: new SqliteRunStore(resolveRunDbPath(config)) }
  } catch (error) {
    return { error: `运行历史打开失败：${errorMessage(error)}` }
  }
}

/**
 * Close a run-history store, reporting a failed close.
 * @param store - store to close, when one was opened.
 * @returns the close failure message, if any.
 */
function closeRunStore(store: SqliteRunStore | undefined): string | undefined {
  try {
    store?.close()
    return undefined
  } catch (error) {
    return `运行历史关闭失败：${errorMessage(error)}`
  }
}

/**
 * Collect the outputs of the nodes that end the graph.
 *
 * A terminal node has no outgoing target, so its ports carry the run's answer.
 * Values are bounded per node: a large result set must not silently truncate the
 * whole payload, and the caller has to be able to tell that it was cut.
 * @param workflow - definition the run executed.
 * @param state - settled run state.
 * @param maxChars - per-node character budget.
 * @returns terminal node id to bounded outputs.
 */
function terminalOutputs(
  workflow: WorkflowDefinition,
  state: RunState,
  maxChars: number,
): Record<string, JsonValue> {
  const result: Record<string, JsonValue> = {}
  for (const node of workflow.nodes) {
    const targets = Object.values(node.outputs ?? {}).flatMap(target => typeof target === 'string' ? [target] : [...target])
    if (targets.length > 0) continue
    const outputs = state.nodes[node.id]?.outputs
    if (outputs === undefined) continue
    // A skipped node still records `{skipped:true}`; it delivered nothing, so it
    // must not appear beside the real answer.
    if (outputs.skipped === true) continue
    const encoded = safeJson(outputs)
    result[node.id] = encoded.length <= maxChars
      ? JSON.parse(encoded) as JsonValue
      : { truncated: true, note: `输出超过 ${maxChars} 字符，已截断`, preview: encoded.slice(0, maxChars) }
  }
  return result
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function textOf(result: SubagentResult): string {
  return result.output
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map(block => block.text)
    .join('\n')
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return '{}'
  }
}
