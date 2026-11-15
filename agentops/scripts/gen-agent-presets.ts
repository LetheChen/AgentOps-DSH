/**
 * 生成器：把 `agentops/agents/*.yaml`（作者面）编译成 DSH preset 行。
 *
 * 设计要点（对应 DESIGN v1.3）：
 * - 工具白名单 = 映射表里 `mapped` 非 null 的条目，按插件能力生成配置；
 * - 人设走 `@agentops/dsh-host/persona-static`（`interpolate:false` + 占 `deployment:persona-prefix`）；
 * - `denied_tools` 走 `@agentops/dsh-host/tool-policy`（guard），不生成 `restrict`；
 * - KB：`kb-map.yaml` 里 `space: null` 的一律不写进 `readableSpaces`（本期 KB 未迁移）；
 * - 工具名的合法性由自有插件导出和外部插件显式契约交叉校验（单一来源，防漂移）。
 *
 * 用法：
 *   node --import tsx agentops/scripts/gen-agent-presets.ts --check   # 只校验 + 打印差异
 *   node --import tsx agentops/scripts/gen-agent-presets.ts --write   # 写入 bundle 的 agents.generated.patch.yml
 */
import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { load } from 'js-yaml'

import { TOOL_NAMES as HOST_TOOLS } from '@agentops/dsh-host/tools'
import { TOOL_NAMES as KNOWLEDGE_TOOLS } from '@agentops/dsh-knowledge/tools'
import { TOOL_NAMES as DB_TOOLS } from '@agentops/dsh-db/tools'
import { TOOL_NAMES as TASK_V1_TOOLS } from '@agentops/dsh-task/tools-v1'
import { TOOL_NAMES as SECURITY_TOOLS } from '@agentops/dsh-security/tools'
import { TOOL_NAMES as LOG_COLLECTION_TOOLS } from '../../packages/agentops/log-collection/src/tools-plugin.ts'
import { TOOL_NAMES as DAG_TOOLS } from '@agentops/dsh-dag/tools'
import { TOOL_NAMES as CAPABILITY_NOTIFY_TOOLS } from '@agentops/dsh-capability/tools'

/** 已知插件 → 运行期会注册的工具名（直接从包导出，单一来源）。 */
export const KNOWN_TOOLS: Readonly<Record<string, readonly string[]>> = {
  '@agentops/dsh-host/tools': HOST_TOOLS,
  '@agentops/dsh-knowledge/tools': KNOWLEDGE_TOOLS,
  '@agentops/dsh-db/tools': DB_TOOLS,
  '@agentops/dsh-task/tools-v1': TASK_V1_TOOLS,
  '@agentops/dsh-security/tools': SECURITY_TOOLS,
  '@agentops/dsh-log-collection/tools': LOG_COLLECTION_TOOLS,
  '@agentops/dsh-dag/tools': DAG_TOOLS,
  '@agentops/dsh-capability/tools': CAPABILITY_NOTIFY_TOOLS,
}

/** DSH 外部插件 → 运行期会注册的工具名。外部插件不导出 `TOOL_NAMES`，在此维护显式契约。 */
export const EXTERNAL_PLUGIN_TOOLS: Readonly<Record<string, readonly string[]>> = {
  '@deepseek-ai/dsh-tool-fs': ['read', 'read_image', 'write', 'edit'],
  '@deepseek-ai/dsh-tool-pwsh': ['pwsh'],
  '@deepseek-ai/dsh-tool-skill': ['skill'],
  '@deepseek-ai/dsh-tool-todo': ['todo_write'],
  '@deepseek-ai/dsh-tool-subagent': ['subagent'],
  '@deepseek-ai/dsh-tool-subagent-control': ['send_message', 'interrupt_agent'],
}

interface ToolMapEntry {
  mapped: { plugin: string; tool: string } | null
  used_by?: string[]
  note?: string
}
interface ToolMap { tools: Record<string, ToolMapEntry> }
interface KbMapEntry { domain: string | null; space?: string | null; spaces?: readonly string[] | null }
interface KbMap { keys: Record<string, KbMapEntry> }

/** 作者面 agent 定义里本生成器读取的字段。 */
export interface AgentYaml {
  agent_id: string
  display_name?: string
  description?: string
  system_prompt?: string
  /** Real execution backend selected for this Agent. */
  execution_backend?: 'dsh_native' | 'codex' | 'claude_code' | 'auto'
  model?: { provider?: string; id?: string } | string
  /** 执行方式：skill（自持手册）或 workflow（独占一条工作流）。缺省按 contracts 解析为 skill。 */
  execution?: 'skill' | 'workflow'
  /** execution=workflow 时必填：本 Agent 拥有的工作流 id。 */
  workflow?: string
  permissions?: { allowed_tools?: string[]; denied_tools?: string[] }
  /** Internal preset hidden from user-facing pickers; manager defaults visible. */
  hidden?: boolean
  knowledge_bases?: string[]
  timeout_seconds?: number
  max_concurrent_runs?: number
  cost_limit_per_run?: number | null
}

/** 生成结果：一个 preset 声明 + 生成期告警。 */
export interface GeneratedPreset {
  presetId: string
  rows: { id: string; name: string; config?: Record<string, unknown> }[]
  warnings: string[]
}

const PLUGIN_LABEL: Record<string, string> = {
  '@agentops/dsh-host/tools': 'host-tools',
  '@agentops/dsh-knowledge/tools': 'knowledge-tools',
  '@agentops/dsh-db/tools': 'db-tools',
  '@agentops/dsh-task/tools': 'task-tools',
  '@agentops/dsh-security/tools': 'security-tools',
  '@agentops/dsh-dag/tools': 'dag-tools',
  '@deepseek-ai/dsh-tool-fs': 'fs-tools',
  '@deepseek-ai/dsh-tool-pwsh': 'pwsh-tool',
  '@deepseek-ai/dsh-tool-skill': 'tool-skill',
  '@deepseek-ai/dsh-tool-todo': 'todo-tool',
  '@deepseek-ai/dsh-tool-subagent': 'subagent-tool',
  '@deepseek-ai/dsh-tool-subagent-control': 'subagent-control-tools',
}

/** 按插件的真实 Config 契约渲染工具行；不会把 `only` 写进不支持它的插件。 */
function renderPluginConfig(
  plugin: string,
  tools: string[],
  spaces: Set<string>,
  delegablePresets: readonly string[],
  agentPresetId: string,
): Record<string, unknown> | undefined {
  if (plugin === '@agentops/dsh-log-collection/tools') {
    return { tenantKey: 'default', agentPreset: agentPresetId, only: tools }
  }
  if (plugin === '@agentops/dsh-capability/tools') {
    return { agentPreset: agentPresetId, only: tools }
  }
  if (plugin === '@agentops/dsh-knowledge/tools') {
    return { readableSpaces: [...spaces], allowedImportRoots: [], only: tools }
  }
  if (plugin === '@deepseek-ai/dsh-tool-fs') {
    return {
      read: tools.includes('read'),
      readImage: tools.includes('read_image'),
      write: tools.includes('write'),
      edit: tools.includes('edit'),
    }
  }
  if (plugin === '@deepseek-ai/dsh-tool-pwsh' || plugin === '@deepseek-ai/dsh-tool-skill') {
    return undefined
  }
  if (plugin === '@deepseek-ai/dsh-tool-todo') {
    // The todo plugin requires the deployment choice; a single active todo matches the legacy flow.
    return { allowParallelInProgress: false }
  }
  if (plugin === '@deepseek-ai/dsh-tool-subagent') {
    // Preset choices are the business Agent catalogue: every non-dispatcher
    // workflow or skill agent is delegable, the dispatcher itself is not.
    return { provider: 'spawn', allowedAgentPresets: [...delegablePresets], maxDepth: 1 }
  }
  if (plugin === '@deepseek-ai/dsh-tool-subagent-control') {
    return undefined
  }
  return { only: tools }
}

/**
 * 把一份作者面 yaml + 两张映射表编译成一个 preset 声明。
 * @param agent - 作者面定义。
 * @param toolMap - 旧工具名 → 插件/工具。
 * @param kbMap - KB 键 → space。
 * @returns preset 行与告警（未映射工具、未建 space 等）。
 */
export function buildPreset(
  agent: AgentYaml,
  toolMap: ToolMap,
  kbMap: KbMap,
  config: { workflowDir?: string; provider?: string; concurrency?: number; maxUpstreamChars?: number } = {},
  delegable: readonly string[] = [],
): GeneratedPreset {
  const warnings: string[] = []
  const allowed = agent.permissions?.allowed_tools ?? []
  const denied = agent.permissions?.denied_tools ?? []

  const byPlugin = new Map<string, string[]>()
  for (const legacy of allowed) {
    const entry = toolMap.tools[legacy]
    if (entry === undefined) {
      warnings.push(`工具 "${legacy}" 不在映射表里（按未迁移处理）`)
      continue
    }
    if (entry.mapped === null) {
      warnings.push(`工具 "${legacy}" 尚未迁移，未写入 only`)
      continue
    }
    const known = KNOWN_TOOLS[entry.mapped.plugin] ?? EXTERNAL_PLUGIN_TOOLS[entry.mapped.plugin]
    if (known === undefined) {
      throw new Error(`映射表指向未知插件 "${entry.mapped.plugin}"（工具 ${legacy}）`)
    } else if (!known.includes(entry.mapped.tool)) {
      throw new Error(`映射表把 "${legacy}" 映射到 "${entry.mapped.plugin}" 不注册的工具 "${entry.mapped.tool}"；已知：${known.join(', ')}`)
    }
    const list = byPlugin.get(entry.mapped.plugin) ?? []
    if (!list.includes(entry.mapped.tool)) list.push(entry.mapped.tool)
    byPlugin.set(entry.mapped.plugin, list)
  }

  const spaces = new Set<string>()
  for (const key of agent.knowledge_bases ?? []) {
    const entry = kbMap.keys[key]
    if (entry === undefined) {
      warnings.push(`KB 键 "${key}" 不在 kb-map 里`)
      continue
    }
    const mapped = entry.spaces ?? (entry.space === undefined || entry.space === null ? [] : [entry.space])
    if (mapped.length === 0) {
      warnings.push(`KB 键 "${key}" 未映射 space（本期不绑，页面标「KB 未迁移」）`)
      continue
    }
    for (const space of mapped) spaces.add(space)
  }

  // Workflow ownership is compiled, not left to the model: the dag tool row
  // pins the workflow id and the owning preset, so a workflow agent can only
  // ever run its own workflow with its own nodes. Generator-time validation
  // mirrors the contracts rules so an authoring mistake surfaces here first.
  const execution = agent.execution ?? 'skill'
  if (agent.execution === undefined && agent.workflow !== undefined) {
    warnings.push(`声明了 workflow "${agent.workflow}" 但未声明 execution，该声明不会被任何行实现`)
  }
  if (agent.workflow !== undefined && execution !== 'workflow') {
    warnings.push(`Agent 不是 workflow 型，workflow "${agent.workflow}" 声明被忽略`)
  }
  const dagRow: GeneratedPreset['rows'][number] | undefined = (() => {
    if (execution !== 'workflow') return undefined
    if (agent.workflow === undefined) {
      throw new Error(`Agent ${agent.agent_id} 声明 execution: workflow 但缺少 workflow id`)
    }
    const dagConfig: Record<string, unknown> = {
      ownedWorkflowId: agent.workflow,
      ownerAgentPreset: agent.agent_id,
      // A workflow Agent executes and supervises its own workflow; catalog and
      // authoring tools belong to operators, not to the Agent under test.
      only: ['dag_run', 'list_runs'],
    }
    if (config.workflowDir !== undefined) dagConfig.workflowDir = config.workflowDir as unknown as string
    if (config.provider !== undefined) dagConfig.provider = config.provider
    if (config.concurrency !== undefined) dagConfig.concurrency = config.concurrency
    if (config.maxUpstreamChars !== undefined) dagConfig.maxUpstreamChars = config.maxUpstreamChars
    return { id: PLUGIN_LABEL['@agentops/dsh-dag/tools'] ?? 'dag-tools', name: '@agentops/dsh-dag/tools', config: dagConfig }
  })()

  const rows: GeneratedPreset['rows'] = [
    { id: 'persona', name: '@agentops/dsh-host/persona-static', config: { text: agent.system_prompt ?? '' } },
    { id: 'agent-instructions', name: '@deepseek-ai/dsh-agent-instructions', config: { maxBytes: 65536 } },
  ]
  const executionBackend = agent.execution_backend ?? 'auto'
  if (agent.agent_id === 'coding_agent') {
    // Mount both external providers once. `execution_backend` selects the
    // actual path at task launch time, so changing the selection does not
    // require recompiling the preset or restarting the host.
    rows.push({ id: 'subagent-codex', name: '@deepseek-ai/dsh-subagent-codex' })
    rows.push({ id: 'tool-subagent-codex', name: '@deepseek-ai/dsh-tool-subagent', config: { provider: 'codex', toolName: 'subagent_codex', maxDepth: 'provider-managed' } })
    rows.push({ id: 'subagent-claude-code', name: '@deepseek-ai/dsh-subagent-claude-code' })
    rows.push({ id: 'tool-subagent-claude-code', name: '@deepseek-ai/dsh-tool-subagent', config: { provider: 'claude-code', toolName: 'subagent_claude_code', maxDepth: 'provider-managed' } })
  } else if (executionBackend !== 'auto') {
    warnings.push(`execution_backend=${executionBackend} 目前只对 coding_agent 接线，本 Agent 按 DSH 原生执行`)
  }
  if (dagRow !== undefined) rows.push(dagRow)

  for (const [plugin, tools] of [...byPlugin.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    // The `skill` loader is useless without a provider: the web app disables the
    // host-level `skill-filesystem` row so presets own local discovery, and an
    // agent whose preset mounts only `tool-skill` gets an empty catalog — every
    // `skill(name=…)` call then answers "unknown or no longer available".
    if (plugin === '@deepseek-ai/dsh-tool-skill') {
      rows.push({ id: 'skill-filesystem', name: '@deepseek-ai/dsh-skill-filesystem' })
    }
    const config = renderPluginConfig(plugin, tools, spaces, delegable, agent.agent_id)
    rows.push(config === undefined
      ? { id: PLUGIN_LABEL[plugin] ?? plugin, name: plugin }
      : { id: PLUGIN_LABEL[plugin] ?? plugin, name: plugin, config })
  }

  if (spaces.size === 0) {
    warnings.push('readableSpaces 为空：该 agent 目前检索不到任何知识空间')
  }

  // Guard 按运行期工具名匹配。旧名映射到新工具时，两者都保留：旧名用于留痕，
  // 新名确保实际注册的工具也被拒绝。
  const deny = new Set(denied)
  for (const legacy of denied) {
    const entry = toolMap.tools[legacy]
    if (entry === undefined) {
      warnings.push(`禁止工具 "${legacy}" 不在映射表里（保留原名，按未迁移处理）`)
      continue
    }
    if (entry.mapped === null) {
      warnings.push(`禁止工具 "${legacy}" 尚未迁移（保留原名）`)
      continue
    }
    const known = KNOWN_TOOLS[entry.mapped.plugin] ?? EXTERNAL_PLUGIN_TOOLS[entry.mapped.plugin]
    if (known === undefined) {
      throw new Error(`禁止工具映射指向未知插件 "${entry.mapped.plugin}"（工具 ${legacy}）`)
    } else if (!known.includes(entry.mapped.tool)) {
      throw new Error(`禁止工具映射把 "${legacy}" 指向 "${entry.mapped.plugin}" 不注册的工具 "${entry.mapped.tool}"；已知：${known.join(', ')}`)
    }
    deny.add(entry.mapped.tool)
  }

  if (deny.size > 0) {
    rows.push({ id: 'tool-policy', name: '@agentops/dsh-host/tool-policy', config: { deny: [...deny] } })
  }

  return { presetId: agent.agent_id, rows, warnings }
}

/** 渲染成 Cordis patch 条目（`- insert: [...]`）。 */
export function renderPatch(presets: GeneratedPreset[], base: { agents: AgentYaml[] }): string {
  const header = [
    '# GENERATED - DO NOT EDIT',
    `# 源：agentops/agents/{${base.agents.map(agent => agent.agent_id).join(', ')}}.yaml`,
    '# 重新生成：node --import tsx agentops/scripts/gen-agent-presets.ts --write',
    '',
  ]
  const lines = [...header, '- insert:']
  for (const [index, preset] of presets.entries()) {
    const agent = base.agents[index]
    lines.push(`    - id: preset-agent-${preset.presetId}`)
    lines.push("      name: '@deepseek-ai/dsh-agent-preset'")
    lines.push('      config:')
    lines.push(`        id: ${preset.presetId}`)
    if (agent?.display_name !== undefined) lines.push(`        name: ${JSON.stringify(agent.display_name)}`)
    if (agent?.description !== undefined) lines.push(`        description: ${JSON.stringify(agent.description)}`)
    lines.push(`        order: ${120 + 10 * index}`)
    if (agent?.hidden ?? agent.agent_id !== 'manager') lines.push('        hidden: true')
    lines.push('        plugins:')
    for (const row of preset.rows) {
      lines.push(`          - id: '${row.id}'`)
      lines.push(`            name: '${row.name}'`)
      if (row.config !== undefined) {
        lines.push('            config:')
        for (const [key, value] of Object.entries(row.config)) {
          // workflowDir must resolve at boot inside the profile, so it renders
          // as a `!!js` expression like the bundle's own patch rows do.
          lines.push(key === 'workflowDir' && typeof value === 'object' && value !== null && '__js' in value
            ? `              ${key}: !!js ${(value as { __js: string }).__js}`
            : `              ${key}: ${JSON.stringify(value)}`)
        }
      }
    }
  }
  return lines.join('\n') + '\n'
}

function main(): void {
  const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
  const agentsDir = join(root, 'agents')
  const outFile = join(root, '..', 'packages', 'agentops', 'bundle', 'presets', 'agents.generated.patch.yml')
  const toolMap = load(readFileSync(join(root, 'mappings', 'tool-map.yaml'), 'utf8')) as ToolMap
  const kbMap = load(readFileSync(join(root, 'mappings', 'kb-map.yaml'), 'utf8')) as KbMap
  const agents = readdirSync(agentsDir)
    .filter(name => name.endsWith('.yaml'))
    .map(name => load(readFileSync(join(agentsDir, name), 'utf8')) as AgentYaml)

  // The delegation allowlist is derived, not hand-maintained: every Agent whose
  // id differs from the dispatcher's is delegable. Adding a business Agent
  // therefore never edits the dispatcher definition.
  const dispatcherId = 'manager'
  const delegablePresets = agents.map(agent => agent.agent_id).filter(id => id !== dispatcherId)

  const presets = agents.map(agent => buildPreset(agent, toolMap, kbMap, {
    workflowDir: { __js: "dshHomePath('agentops', 'workflows')" } as unknown as string,
    provider: 'spawn',
    concurrency: 4,
  }, delegablePresets))
  const rendered = renderPatch(presets, { agents })

  for (const preset of presets) {
    process.stdout.write(`\n${preset.presetId}: ${preset.rows.length} 行\n`)
    for (const row of preset.rows) process.stdout.write(`  - ${row.id} (${row.name})\n`)
    for (const warning of preset.warnings) process.stdout.write(`  ⚠ ${warning}\n`)
  }

  // 生成物必须是合法 YAML（否则 Loader 会在挂载时才炸）。`!!js` 标签由 Cordis
  // Loader 的 schema 支持，本脚本只需校验结构：把所有 !!js 行替换为占位符再加载。
  load(rendered.replace(/^(\s*[\w-]+: )!!js .*$/gm, '$1"__js_placeholder__"'))

  const write = process.argv.includes('--write')
  if (write) {
    mkdirSync(dirname(outFile), { recursive: true })
    writeFileSync(outFile, rendered, 'utf8')
    process.stdout.write(`\n已写入 ${outFile}\n`)
    return
  }
  const existing = existsSync(outFile) ? readFileSync(outFile, 'utf8') : ''
  if (existing !== rendered) {
    process.stderr.write('\n--check 失败：生成物与磁盘不一致（跑 --write 重新生成）\n')
    process.exit(1)
  }
  process.stdout.write('\n--check 通过：生成物与磁盘一致\n')
}

if (process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].replaceAll('\\', '/'))) main()
