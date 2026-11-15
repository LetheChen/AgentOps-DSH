/**
 * T7-1 迁移脚本：把原 AgentOps 仓库的作者面 YAML 迁进 DSH 的 `agentops/` 树。
 *
 * 用法：
 *   node --import tsx agentops/scripts/migrate-legacy-assets.ts --check
 *   node --import tsx agentops/scripts/migrate-legacy-assets.ts --write
 *
 * `--source <dir>` 指向原仓库根目录；默认取 DSH 仓库的同级目录 `../AgentOps`。
 *
 * 迁移规则（每条都对应一处 DSH 与原项目的差异，改动必须同步更新本文件的表格）：
 *
 * | 规则 | 对象 | 说明 |
 * |---|---|---|
 * | R1 文本规范 | 两者 | 去 BOM、CRLF→LF、结尾恰好一个换行 |
 * | R2 harness 白名单 | agent | `claude_code` / `claude_sdk` → `local_llm`；`codex` 保留 |
 * | R3 model id | agent | `MiniMax-M3.1-Flash` → `MiniMax-M3` |
 * | R4 tier 显式化 | agent | 缺 `tier` 时补 `tier: T2`，位置在 `agent_id:` 之后 |
 * | R5 业务分类下线 | workflow | 删除顶层 `business_category:`（DSH 契约无此字段） |
 *
 * R2 与 R3 是硬失败兜底：契约校验会把未知 harness / 缺失 model 判为非法，
 * 与其在运行时失败，不如在迁移期就改写成 DSH 认的值。
 *
 * 工具清单不做删改（R6）：没有 DSH 映射的工具保留在 YAML 里并由
 * `verify-migration.ts` 汇总进不兼容清单，避免迁移期静默丢失授权语义。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(scriptDir, '..', '..')

/** 原仓库的 harness 名 → DSH 契约接受的 harness。 */
const HARNESS_MAP: Readonly<Record<string, string>> = {
  claude_code: 'local_llm',
  claude_sdk: 'local_llm',
}

/** 原仓库的 model id → DSH 侧可用的 model id。 */
const MODEL_ID_MAP: Readonly<Record<string, string>> = {
  'MiniMax-M3.1-Flash': 'MiniMax-M3',
}

/** 一次迁移的全部改动，用于 `--check` 输出与不兼容清单。 */
export interface MigrationChange {
  readonly asset: string
  readonly rule: string
  readonly detail: string
}

/** 一份资产迁移后的结果。 */
export interface MigrationResult {
  readonly asset: string
  readonly kind: 'agent' | 'workflow'
  readonly text: string
  readonly changes: readonly MigrationChange[]
}

/**
 * 规范化文本编码与行尾。
 * @param raw - 原始文件内容。
 * @returns 去 BOM、CRLF→LF、结尾恰好一个换行的文本。
 */
export function normalizeText(raw: string): string {
  const withoutBom = raw.startsWith('\uFEFF') ? raw.slice(1) : raw
  const lf = withoutBom.replace(/\r\n/g, '\n')
  return `${lf.replace(/\n+$/, '')}\n`
}

/**
 * 把一段 agent YAML 迁到 DSH 作者面。
 * @param text - 原 agent YAML 文本。
 * @param asset - 资产名，用于生成变更记录。
 * @returns 迁移后的文本与逐条变更。
 */
export function migrateAgent(text: string, asset: string): MigrationResult {
  const changes: MigrationChange[] = []
  let out = normalizeText(text)

  const harness = /^harness:[ \t]*(\S+)[ \t]*$/m.exec(out)?.[1]
  const mappedHarness = harness === undefined ? undefined : HARNESS_MAP[harness]
  if (mappedHarness !== undefined) {
    out = out.replace(/^harness:[ \t]*\S+[ \t]*$/m, `harness: ${mappedHarness}`)
    changes.push({ asset, rule: 'R2 harness 白名单', detail: `${harness} → ${mappedHarness}` })
  }

  for (const [legacy, current] of Object.entries(MODEL_ID_MAP)) {
    const pattern = new RegExp(`^([ \\t]*id:[ \\t]*)${legacy.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[ \\t]*$`, 'm')
    if (pattern.test(out)) {
      out = out.replace(pattern, `$1${current}`)
      changes.push({ asset, rule: 'R3 model id', detail: `${legacy} → ${current}` })
    }
  }

  if (!/^tier:[ \t]*\S+[ \t]*$/m.test(out)) {
    out = out.replace(/^(agent_id:.*)$/m, `$1\ntier: T2`)
    changes.push({ asset, rule: 'R4 tier 显式化', detail: '补 tier: T2（与旧加载器兜底一致）' })
  }

  return { asset, kind: 'agent', text: out, changes }
}

/**
 * 把一段 workflow YAML 迁到 DSH 作者面。
 * @param text - 原 workflow YAML 文本。
 * @param asset - 资产名，用于生成变更记录。
 * @returns 迁移后的文本与逐条变更。
 */
export function migrateWorkflow(text: string, asset: string): MigrationResult {
  const changes: MigrationChange[] = []
  let out = normalizeText(text)

  if (/^business_category:.*$/m.test(out)) {
    out = out.replace(/^business_category:.*$\n?/m, '')
    changes.push({ asset, rule: 'R5 业务分类下线', detail: '删除 business_category' })
  }

  return { asset, kind: 'workflow', text: out, changes }
}

/** 一条待迁移资产的定位信息。 */
interface LegacyAsset {
  readonly kind: 'agent' | 'workflow'
  readonly sourcePath: string
  readonly targetPath: string
  readonly name: string
}

/**
 * 列出原仓库里待迁移的全部资产。
 * @param sourceRoot - 原仓库根目录。
 * @param targetRoot - DSH 仓库根目录。
 * @returns 资产清单，按名称排序。
 */
export function listAssets(sourceRoot: string, targetRoot: string): LegacyAsset[] {
  const assets: LegacyAsset[] = []
  const agentDir = join(sourceRoot, 'config', 'agents')
  if (existsSync(agentDir)) {
    for (const file of readdirSync(agentDir).filter(name => name.endsWith('.yaml')).sort()) {
      assets.push({
        kind: 'agent',
        sourcePath: join(agentDir, file),
        targetPath: join(targetRoot, 'agentops', 'agents', file),
        name: basename(file, '.yaml'),
      })
    }
  }
  const workflowDir = join(sourceRoot, 'workflows')
  if (existsSync(workflowDir)) {
    for (const file of readdirSync(workflowDir).filter(name => name.endsWith('.yaml')).sort()) {
      assets.push({
        kind: 'workflow',
        sourcePath: join(workflowDir, file),
        targetPath: join(targetRoot, 'agentops', 'workflows', file),
        name: basename(file, '.yaml'),
      })
    }
  }
  return assets
}

function main(): void {
  const argv = process.argv.slice(2)
  const sourceArg = argv.indexOf('--source')
  const sourceRoot = sourceArg >= 0 && argv[sourceArg + 1] !== undefined
    ? resolve(argv[sourceArg + 1]!)
    : resolve(repoRoot, '..', 'AgentOps')
  const write = argv.includes('--write')

  if (!existsSync(sourceRoot)) {
    process.stderr.write(`原仓库不存在：${sourceRoot}\n用 --source <dir> 指定。\n`)
    process.exit(2)
  }

  const assets = listAssets(sourceRoot, repoRoot)
  if (assets.length === 0) {
    process.stderr.write(`原仓库里没找到资产：${sourceRoot}\n`)
    process.exit(2)
  }

  const allChanges: MigrationChange[] = []
  let drift = 0

  for (const asset of assets) {
    const raw = readFileSync(asset.sourcePath, 'utf8')
    const result = asset.kind === 'agent'
      ? migrateAgent(raw, asset.name)
      : migrateWorkflow(raw, asset.name)
    allChanges.push(...result.changes)

    const existing = existsSync(asset.targetPath) ? readFileSync(asset.targetPath, 'utf8') : undefined
    if (existing === result.text) continue
    drift += 1
    if (write) {
      mkdirSync(dirname(asset.targetPath), { recursive: true })
      writeFileSync(asset.targetPath, result.text, 'utf8')
      process.stdout.write(`写入 ${asset.targetPath}\n`)
    } else {
      process.stdout.write(`待更新 ${asset.targetPath}\n`)
    }
  }

  for (const change of allChanges) {
    process.stdout.write(`  [${change.rule}] ${change.asset}：${change.detail}\n`)
  }
  process.stdout.write(`\n资产 ${assets.length} 份（agent ${assets.filter(a => a.kind === 'agent').length} / workflow ${assets.filter(a => a.kind === 'workflow').length}），规则命中 ${allChanges.length} 处\n`)

  if (write) {
    process.stdout.write(`--write 完成：更新 ${drift} 份\n`)
    return
  }
  if (drift > 0) {
    process.stderr.write(`\n--check 失败：${drift} 份与迁移结果不一致（跑 --write 写入）\n`)
    process.exit(1)
  }
  process.stdout.write('--check 通过：磁盘内容与迁移结果一致\n')
}

if (process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].replaceAll('\\', '/'))) main()
