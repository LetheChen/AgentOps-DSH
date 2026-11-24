/**
 * T7-1 校验脚本：检查迁进 `agentops/` 的作者面资产在 DSH 契约与 DAG 引擎下都成立，
 * 并把不能平迁的部分汇总成不兼容清单。
 *
 * 用法：
 *   node --import tsx agentops/scripts/verify-migration.ts            # 打印报告
 *   node --import tsx agentops/scripts/verify-migration.ts --strict   # 有不兼容项就退出码 1
 *
 * 检查项：
 *
 * | 层 | 检查 | 失败后果 |
 * |---|---|---|
 * | agent | `loadAgentDefinition` 契约解析 + 产物路径合法 | 硬失败 |
 * | workflow | `parseWorkflowYaml` + `validateWorkflow` | 硬失败 |
 * | 交叉 | 工作流节点的 `agent` 引用能找到对应 agent | 不兼容项 |
 * | 交叉 | agent 的工具在 `tool-map.yaml` 里有条目 | 不兼容项 |
 * | 交叉 | agent 的 KB 键在 `kb-map.yaml` 里有条目 | 不兼容项 |
 *
 * 硬失败说明资产本身在 DSH 侧不可用；不兼容项说明资产能读但能力有缺口。
 * 两类都由本脚本的输出报告，修复前不得视为通过。
 */

import { readFileSync, readdirSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { load } from 'js-yaml'

import { isRelativeArtifactPath, loadAgentDefinition } from '../../packages/agentops/contracts/src/schema.ts'
import { parseWorkflowYaml } from '../../packages/agentops/dag/src/load.ts'
import { validateWorkflow } from '../../packages/agentops/dag/src/validate.ts'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(scriptDir, '..', '..')
const agentsDir = join(repoRoot, 'agentops', 'agents')
const workflowsDir = join(repoRoot, 'agentops', 'workflows')

/** 一条硬失败：资产在 DSH 侧读不出来或读出来不合法。 */
interface HardFailure {
  readonly asset: string
  readonly kind: 'agent' | 'workflow'
  readonly detail: string
}

/** 一条不兼容项：资产能读，但能力或引用在 DSH 侧有缺口。 */
interface Incompatibility {
  readonly category:
    | 'missing-agent'
    | 'unmapped-tool'
    | 'missing-kb'
    | 'command-node'
    | 'implicit-tier'
    | 'legacy-workflow'
    | 'unowned-workflow'
  readonly asset: string
  readonly detail: string
}

/** 校验的完整结果。 */
export interface VerifyResult {
  readonly agents: number
  readonly workflows: number
  readonly failures: readonly HardFailure[]
  readonly incompatibilities: readonly Incompatibility[]
}

interface ToolMapFile {
  tools: Record<string, { mapped: unknown }>
}
interface KbMapFile {
  keys: Record<string, { domain: string | null; space: string | null }>
}

/**
 * 校验全部已迁资产。
 * @returns 资产数量、硬失败与不兼容项。
 */
export function verifyMigration(): VerifyResult {
  const toolMap = load(readFileSync(join(repoRoot, 'agentops', 'mappings', 'tool-map.yaml'), 'utf8')) as ToolMapFile
  const kbMap = load(readFileSync(join(repoRoot, 'agentops', 'mappings', 'kb-map.yaml'), 'utf8')) as KbMapFile

  const failures: HardFailure[] = []
  const incompatibilities: Incompatibility[] = []

  const agentFiles = readdirSync(agentsDir).filter(name => name.endsWith('.yaml')).sort()
  const agentIds = new Set<string>()

  for (const file of agentFiles) {
    const asset = basename(file, '.yaml')
    const text = readFileSync(join(agentsDir, file), 'utf8')
    const parsed = loadAgentDefinition(text)
    if (!parsed.ok) {
      failures.push({ asset, kind: 'agent', detail: parsed.issues.map(issue => `${issue.path}：${issue.message}`).join('；') })
      continue
    }
    const definition = parsed.value
    agentIds.add(definition.agentId)

    for (const issue of parsed.issues) {
      incompatibilities.push({ category: 'implicit-tier', asset, detail: `${issue.path}：${issue.message}` })
    }
    for (const [name, template] of Object.entries(definition.outputFiles)) {
      if (!isRelativeArtifactPath(template)) {
        failures.push({ asset, kind: 'agent', detail: `产物路径越界 ${name}：${template}` })
      }
    }
    for (const tool of definition.permissions.allowedTools) {
      if (!(tool in toolMap.tools)) {
        incompatibilities.push({ category: 'unmapped-tool', asset, detail: `allowed_tools：${tool}` })
      }
    }
    for (const tool of definition.permissions.deniedTools) {
      if (!(tool in toolMap.tools)) {
        incompatibilities.push({ category: 'unmapped-tool', asset, detail: `denied_tools：${tool}` })
      }
    }
    for (const key of definition.knowledgeBases ?? []) {
      if (!(key in kbMap.keys)) {
        incompatibilities.push({ category: 'missing-kb', asset, detail: `knowledge_bases：${key}` })
      }
    }
  }

  const workflowFiles = readdirSync(workflowsDir).filter(name => name.endsWith('.yaml')).sort()
  const ownedWorkflows = new Set<string>()
  for (const file of agentFiles) {
    const parsed = loadAgentDefinition(readFileSync(join(agentsDir, file), 'utf8'))
    if (parsed.ok && parsed.value.workflow !== undefined) ownedWorkflows.add(parsed.value.workflow)
  }

  for (const file of workflowFiles) {
    const asset = basename(file, '.yaml')
    const text = readFileSync(join(workflowsDir, file), 'utf8')
    // A `legacy:` marker is the author's explicit statement that this topology
    // is kept for reference and is not executable under the ownership model.
    // Its parse/validation errors are therefore documented incompatibilities,
    // not hard failures.
    const legacy = isLegacyWorkflow(text)
    let workflow
    try {
      workflow = parseWorkflowYaml(text)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      if (legacy) incompatibilities.push({ category: 'legacy-workflow', asset, detail })
      else failures.push({ asset, kind: 'workflow', detail })
      continue
    }
    const validation = validateWorkflow(workflow)
    for (const error of validation.errors) {
      if (legacy) incompatibilities.push({ category: 'legacy-workflow', asset, detail: error })
      else failures.push({ asset, kind: 'workflow', detail: error })
    }
    for (const node of workflow.nodes) {
      if (node.type === 'command') {
        incompatibilities.push({ category: 'command-node', asset, detail: `节点 ${node.id} 的 type=command（DSH 执行器不跑命令节点）` })
      }
      if (node.agentRef !== undefined && !agentIds.has(node.agentRef)) {
        incompatibilities.push({ category: 'missing-agent', asset, detail: `节点 ${node.id} 引用 ${node.agentRef}` })
      }
    }
    if (!ownedWorkflows.has(workflow.id)) {
      incompatibilities.push({
        category: 'unowned-workflow',
        asset,
        detail: '没有 Agent 声明该工作流（执行方式未声明，不可由 Agent 启动）',
      })
    }
  }

  return {
    agents: agentFiles.length,
    workflows: workflowFiles.length,
    failures,
    incompatibilities,
  }
}

/**
 * Detect the `legacy:` marker a retired topology carries.
 *
 * The marker is read from the raw YAML because the parse step is exactly what
 * may fail for these files; a document that does not parse still has to be
 * attributable to its author's intent.
 * @param text - workflow YAML source.
 * @returns true when the document declares itself retired.
 */
function isLegacyWorkflow(text: string): boolean {
  try {
    const doc = load(text)
    return isRecord(doc) && doc.legacy !== undefined && doc.legacy !== null
  } catch {
    // Unparseable YAML cannot carry a readable marker; treat it as a hard
    // failure so a corrupt file is never retired by accident.
    return false
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function main(): void {
  const result = verifyMigration()
  const strict = process.argv.includes('--strict')

  process.stdout.write(`资产：agent ${result.agents} 份 / workflow ${result.workflows} 份\n\n`)

  if (result.failures.length === 0) {
    process.stdout.write('硬失败：无\n')
  } else {
    process.stdout.write(`硬失败 ${result.failures.length} 条：\n`)
    for (const failure of result.failures) {
      process.stdout.write(`  [${failure.kind}] ${failure.asset}：${failure.detail}\n`)
    }
  }

  const grouped = new Map<string, Incompatibility[]>()
  for (const item of result.incompatibilities) {
    const list = grouped.get(item.category) ?? []
    list.push(item)
    grouped.set(item.category, list)
  }
  process.stdout.write('\n不兼容项：\n')
  if (grouped.size === 0) {
    process.stdout.write('  无\n')
  } else {
    for (const [category, items] of grouped) {
      process.stdout.write(`  ${category}（${items.length}）：\n`)
      for (const item of items) {
        process.stdout.write(`    ${item.asset}：${item.detail}\n`)
      }
    }
  }

  if (result.failures.length > 0) {
    process.stderr.write('\n校验失败：存在硬失败\n')
    process.exit(1)
  }
  if (strict && result.incompatibilities.length > 0) {
    process.stderr.write('\n校验失败（--strict）：存在不兼容项\n')
    process.exit(1)
  }
  process.stdout.write('\n校验通过\n')
}

if (process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].replaceAll('\\', '/'))) main()
