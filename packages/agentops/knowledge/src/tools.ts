/**
 * Knowledge tools, mounted inside an Agent preset.
 *
 * Opens the same SQLite file as the root plugin; the registry is Agent-scoped,
 * so registration must happen here rather than at the root.
 *
 * @module @agentops/dsh-knowledge/tools
 */

import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

import type { Context } from '@deepseek-ai/cordis'

import {
  createImportPlanTool,
  createSearchTool,
  createWikiCategoriesTool,
  createWikiCheckTool,
  createWikiDraftTool,
  createWikiPublishTool,
  resolveKnowledgeDbPath,
  DEFAULT_CONFIG,
} from './dsh.ts'
import type { KnowledgeConfig } from './dsh.ts'
import { KnowledgeService } from './service.ts'
import { SqliteKnowledgeRepository } from './sqlite.ts'
import { WikiService } from './wiki-service.ts'

export const name = 'agentops-knowledge-tools'

export const inject = ['tools']

/** 本插件会注册的工具名（`only` 的合法取值）。 */
export const TOOL_NAMES = [
  'knowledge_search',
  'knowledge_import_plan',
  'knowledge_wiki_categories',
  'knowledge_wiki_draft',
  'knowledge_wiki_check',
  'knowledge_wiki_publish',
] as const

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

/**
 * Register `knowledge_search` and `knowledge_import_plan`.
 * @param ctx - Agent-scoped context carrying the tool registry.
 * @param config - database path and visibility policy.
 */
export function apply(ctx: Context, config: KnowledgeConfig = DEFAULT_CONFIG): void {
  const reg = onlyRegistrar(ctx, (config as { only?: readonly string[] }).only, TOOL_NAMES)
  const dbPath = resolveKnowledgeDbPath(config)
  if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true })
  const repository = new SqliteKnowledgeRepository(dbPath)
  const service = KnowledgeService.open(repository)
  const wiki = new WikiService(service, repository)
  reg(createSearchTool(service, config))
  reg(createImportPlanTool(service, config))
  reg(createWikiCategoriesTool(wiki, config))
  reg(createWikiDraftTool(wiki, config))
  reg(createWikiCheckTool(wiki, config))
  reg(createWikiPublishTool(wiki, config))
}
