/**
 * 生成器：把旧项目 `config/tools/*.yaml` 与内置工具的元数据合进
 * `agentops/mappings/tool-map.yaml`，让权限矩阵能显示真实的工具名、说明、
 * 可用领域与是否需要人工审批。
 *
 * 人工标注（`mapped` / `used_by` / `note`）以磁盘上已有的文件为准，脚本只刷新
 * 元数据字段，绝不覆盖人工判断。旧项目没有对应定义时（DSH 自带工具），
 * 元数据留空并由 `note` 说明来源。
 *
 * 用法：
 *   node --import tsx agentops/scripts/gen-tool-catalogue.ts --check
 *   node --import tsx agentops/scripts/gen-tool-catalogue.ts --write
 *   node --import tsx agentops/scripts/gen-tool-catalogue.ts --write --legacy-root <旧项目目录>
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { load } from 'js-yaml'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(scriptDir, '..', '..')
const mapFile = join(repoRoot, 'agentops', 'mappings', 'tool-map.yaml')

/** 一个工具的元数据。字段与旧项目 `config/tools/*.yaml` 一致。 */
export interface ToolMetadata {
  display_name: string
  description: string
  allowed_domains: string[]
  requires_human_approval: boolean
}

/** 映射表里的一条记录：人工标注 + 生成的元数据。 */
export interface ToolMapEntry extends Partial<ToolMetadata> {
  mapped: { plugin: string; tool: string } | null
  used_by?: string[]
  note?: string
}

/** 映射表文件结构。 */
export interface ToolMapFile {
  version: number
  agents: string[]
  tools: Record<string, ToolMapEntry>
}

/**
 * 把多行文本压成一行，避免生成物里出现块标量。
 * @param value - 原始文本。
 * @returns 折叠空白后的单行文本。
 */
export function collapse(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

/**
 * 读取旧项目 `config/tools/` 下的工具定义。
 * @param legacyRoot - 旧项目根目录。
 * @returns 以 tool_id 为键的元数据。
 */
export function readLegacyToolMetadata(legacyRoot: string): Map<string, ToolMetadata> {
  const dir = join(legacyRoot, 'config', 'tools')
  if (!existsSync(dir)) {
    throw new Error(`旧项目缺少工具定义目录：${dir}`)
  }
  const metadata = new Map<string, ToolMetadata>()
  for (const name of readdirSync(dir).filter(file => file.endsWith('.yaml')).sort()) {
    const document = load(readFileSync(join(dir, name), 'utf8')) as Record<string, unknown> | null
    if (document === null || typeof document !== 'object') {
      throw new Error(`工具定义不是映射：${join(dir, name)}`)
    }
    const toolId = typeof document.tool_id === 'string' && document.tool_id.length > 0
      ? document.tool_id
      : name.replace(/\.yaml$/, '')
    metadata.set(toolId, {
      display_name: typeof document.display_name === 'string' ? collapse(document.display_name) : toolId,
      description: typeof document.description === 'string' ? collapse(document.description) : '',
      allowed_domains: Array.isArray(document.allowed_domains)
        ? document.allowed_domains.filter((domain): domain is string => typeof domain === 'string')
        : [],
      requires_human_approval: document.requires_human_approval === true,
    })
  }
  return metadata
}

/**
 * 解析旧项目 `api/server.py` 里的 `_BUILTIN_TOOLS` 列表。
 *
 * 内置工具没有 yaml 定义，元数据只存在于这段 Python 字面量里；解析失败就报错，
 * 不允许静默丢工具。
 * @param legacyRoot - 旧项目根目录。
 * @returns 以 tool_id 为键的内置工具元数据。
 */
export function readBuiltinToolMetadata(legacyRoot: string): Map<string, ToolMetadata> {
  const file = join(legacyRoot, 'api', 'server.py')
  if (!existsSync(file)) throw new Error(`旧项目缺少 API 服务文件：${file}`)
  const text = readFileSync(file, 'utf8')
  const start = text.indexOf('_BUILTIN_TOOLS')
  if (start === -1) throw new Error(`${file} 里找不到 _BUILTIN_TOOLS`)
  const open = text.indexOf('= [', start) + 2
  const close = closingBracket(text, open)
  if (open === -1 || close === -1) throw new Error(`${file} 里 _BUILTIN_TOOLS 不是列表字面量`)

  const metadata = new Map<string, ToolMetadata>()
  for (const match of text.slice(open, close).matchAll(/\{[^{}]*\}/g)) {
    const literal = match[0]
    const toolId = readStringField(literal, 'tool_id')
    if (toolId === undefined) throw new Error(`_BUILTIN_TOOLS 里有一条没有 tool_id：${literal}`)
    metadata.set(toolId, {
      display_name: readStringField(literal, 'display_name') ?? toolId,
      description: readStringField(literal, 'description') ?? '',
      allowed_domains: readStringListField(literal, 'allowed_domains'),
      requires_human_approval: readBooleanField(literal, 'requires_human_approval'),
    })
  }
  if (metadata.size === 0) throw new Error(`${file} 里 _BUILTIN_TOOLS 解析结果为空`)
  return metadata
}

function closingBracket(text: string, open: number): number {
  let depth = 0
  for (let index = open; index < text.length; index += 1) {
    const char = text[index]
    if (char === '[') depth += 1
    else if (char === ']') {
      depth -= 1
      if (depth === 0) return index
    }
  }
  throw new Error('括号未闭合')
}

function readStringField(literal: string, field: string): string | undefined {
  const match = new RegExp(`"${field}":\\s*"([^"]*)"`).exec(literal)
  return match?.[1]
}

function readStringListField(literal: string, field: string): string[] {
  const match = new RegExp(`"${field}":\\s*\\[([^\\]]*)\\]`).exec(literal)
  if (match === null) return []
  return [...match[1].matchAll(/"([^"]*)"/g)].map(item => item[1] ?? '').filter(item => item.length > 0)
}

function readBooleanField(literal: string, field: string): boolean {
  return new RegExp(`"${field}":\\s*True`).test(literal)
}

/**
 * 把旧项目元数据合进映射表。
 *
 * 人工标注优先：磁盘上已有的 `mapped` / `used_by` / `note` 原样保留。旧项目里
 * 不存在的工具（DSH 自带工具）保留已有标注，元数据留空。
 * @param existing - 磁盘上已有的映射表。
 * @param metadata - 旧项目元数据（yaml 工具 + 内置工具）。
 * @returns 合好的映射表。
 */
export function mergeToolMetadata(existing: ToolMapFile, metadata: Map<string, ToolMetadata>): ToolMapFile {
  const tools: Record<string, ToolMapEntry> = {}
  const names = [...new Set([...Object.keys(existing.tools), ...metadata.keys()])].sort()
  for (const name of names) {
    const entry = existing.tools[name]
    const found = metadata.get(name)
    if (entry === undefined) {
      tools[name] = {
        mapped: null,
        used_by: [],
        note: '旧项目工具，本批 20 个 agent 未引用',
        display_name: found?.display_name ?? name,
        description: found?.description ?? '',
        allowed_domains: found?.allowed_domains ?? [],
        requires_human_approval: found?.requires_human_approval ?? false,
      }
      continue
    }
    tools[name] = {
      mapped: entry.mapped,
      ...(entry.used_by === undefined ? {} : { used_by: entry.used_by }),
      ...(entry.note === undefined ? {} : { note: entry.note }),
      display_name: found?.display_name ?? entry.display_name ?? name,
      description: found?.description ?? entry.description ?? '',
      allowed_domains: found?.allowed_domains ?? entry.allowed_domains ?? [],
      requires_human_approval: found?.requires_human_approval ?? entry.requires_human_approval ?? false,
    }
  }
  return { version: 3, agents: existing.agents, tools }
}

/**
 * 渲染映射表文本。字段顺序固定，便于人工比对。
 * @param file - 映射表内容。
 * @returns YAML 文本。
 */
export function renderToolMap(file: ToolMapFile): string {
  const lines = [
    '# 旧工具目录与 DSH 映射表。',
    '#',
    '# 元数据（display_name / description / allowed_domains / requires_human_approval）',
    '# 由旧项目 config/tools/*.yaml 与 api/server.py 的 _BUILTIN_TOOLS 刷新：',
    '#   node --import tsx agentops/scripts/gen-tool-catalogue.ts --write',
    '# mapped / used_by / note 是人工标注，脚本只刷新元数据，不覆盖人工判断。',
    '# mapped: 插件包 + 工具名（运行期真实存在）；null = 尚未迁移，页面标「未迁移」。',
    '# 用法：生成器据此产出 preset 行的 only 列表；`mapped: null` 的条目一律不写进 only。',
    `version: ${file.version}`,
    `agents: [${file.agents.join(', ')}]`,
    'tools:',
  ]
  for (const [name, entry] of Object.entries(file.tools)) {
    lines.push(`  ${name}:`)
    lines.push(`    display_name: ${JSON.stringify(entry.display_name ?? name)}`)
    lines.push(`    description: ${JSON.stringify(entry.description ?? '')}`)
    lines.push(`    allowed_domains: [${(entry.allowed_domains ?? []).join(', ')}]`)
    lines.push(`    requires_human_approval: ${entry.requires_human_approval === true}`)
    lines.push(entry.mapped === null
      ? '    mapped: null'
      : `    mapped: { plugin: ${JSON.stringify(entry.mapped.plugin)}, tool: ${JSON.stringify(entry.mapped.tool)} }`)
    lines.push(`    used_by: [${(entry.used_by ?? []).join(', ')}]`)
    if (entry.note !== undefined && entry.note !== '') {
      lines.push(`    note: ${JSON.stringify(entry.note)}`)
    }
  }
  return lines.join('\n') + '\n'
}

/**
 * 生成映射表文本。
 * @param legacyRoot - 旧项目根目录。
 * @returns 与磁盘内容对应的映射表文本。
 */
export function generateToolMap(legacyRoot: string): string {
  const existing = load(readFileSync(mapFile, 'utf8')) as ToolMapFile
  const metadata = new Map([
    ...readLegacyToolMetadata(legacyRoot),
    ...readBuiltinToolMetadata(legacyRoot),
  ])
  return renderToolMap(mergeToolMetadata(existing, metadata))
}

function main(): void {
  const legacyIndex = process.argv.indexOf('--legacy-root')
  const legacyRoot = legacyIndex === -1
    ? join(repoRoot, '..', 'AgentOps')
    : resolve(process.argv[legacyIndex + 1] ?? '')
  const rendered = generateToolMap(legacyRoot)
  load(rendered)

  if (process.argv.includes('--write')) {
    writeFileSync(mapFile, rendered, 'utf8')
    process.stdout.write(`已写入 ${mapFile}\n`)
    return
  }
  const existing = readFileSync(mapFile, 'utf8')
  if (existing !== rendered) {
    process.stderr.write('--check 失败：映射表与旧项目元数据不一致（跑 --write 重新生成）\n')
    process.exit(1)
  }
  process.stdout.write('--check 通过：映射表与旧项目元数据一致\n')
}

if (process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].replaceAll('\\', '/'))) main()