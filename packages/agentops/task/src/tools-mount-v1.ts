/**
 * Preset-mounted task tools backed by `TaskService`.
 *
 * This is the entry a preset lists when it should use the versioned task
 * database instead of the legacy three-table store. It refuses to mount on a
 * database that is not at `SCHEMA_VERSION`; run `pnpm migrate:task` first.
 *
 * @module @agentops/dsh-task/tools-v1
 */

import { existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

import type { Context } from '@deepseek-ai/cordis'
import { DatabaseSync } from 'node:sqlite'

import { createTaskSchema, assertSchemaVersion } from './schema.ts'
import { DEFAULT_SOURCE_SYSTEMS, TaskService } from './service.ts'
import { createServiceTaskTools } from './tools-v1.ts'

export const name = 'agentops-task-tools-v1'

export const inject = ['tools']

/** Tool names this plugin registers; the `only` list may reference these. */
export const TOOL_NAMES = [
  'task_list',
  'task_get',
  'candidate_create',
  'task_advance',
  'task_claim',
  'task_comment',
  'task_validate',
  'task_report_submit',
  'task_rollback',
  'task_execute',
  'idea_capture',
  'idea_list',
  'idea_triage',
  'decision_propose',
  'decision_revise',
  'decision_search',
  'decision_get',
] as const

/** Configuration of the preset-mounted task tools. */
export interface Config {
  /** SQLite file; omit to use the deployment default. */
  dbPath?: string
  /** Source systems accepted for inbox captures; unknown values are rejected. */
  allowedSourceSystems?: readonly string[]
  /** Register only these tool names; an unknown name fails the mount. */
  only?: readonly string[]
}

/**
 * Resolve the database path: config, then `AGENTOPS_TASK_DB`, then
 * `$DSH_HOME/agentops/agentops.db`.
 * @param config - deployment configuration.
 * @param env - process environment.
 * @returns the resolved path.
 */
export function resolveTaskDbPathV1(config: Config = {}, env: NodeJS.ProcessEnv = process.env): string {
  const explicit = config.dbPath?.trim()
  if (explicit !== undefined && explicit.length > 0) return explicit
  const fromEnv = env.AGENTOPS_TASK_DB?.trim()
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv
  const home = env.DSH_HOME?.trim()
  return `${home === undefined || home === '' ? `${env.USERPROFILE ?? env.HOME ?? '.'}/.dsh` : home}/agentops/agentops.db`
}

/**
 * Mount the service-backed task tools in one Agent preset.
 * @param ctx - Agent-scoped context carrying the tool registry.
 * @param config - database path, source-system allowlist and `only` filter.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const path = resolveTaskDbPathV1(config)
  const memory = path === ':memory:'
  if (!memory) mkdirSync(dirname(path), { recursive: true })
  const existed = memory || existsSync(path)
  const db = new DatabaseSync(path)
  db.exec('PRAGMA foreign_keys = ON')
  if (memory) createTaskSchema(db)
  else if (!existed) createTaskSchema(db)
  else assertSchemaVersion(db)
  const service = new TaskService(db, {
    allowedSourceSystems: config.allowedSourceSystems ?? DEFAULT_SOURCE_SYSTEMS,
  })
  const only = config.only
  if (only !== undefined) {
    for (const tool of only) {
      if (!(TOOL_NAMES as readonly string[]).includes(tool)) {
        throw new Error(`only contains ${tool}, which this plugin does not register`)
      }
    }
  }
  const allow = only === undefined ? undefined : new Set(only)
  for (const tool of createServiceTaskTools(service)) {
    if (allow === undefined || allow.has(tool.name)) ctx.tools.register(tool)
  }
}
