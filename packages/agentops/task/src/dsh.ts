/**
 * Task plugin entry: opens the business database and mounts the versioned
 * task surface.
 *
 * The plugin owns persistence and the HTTP/RPC surface; model tools live in
 * `./tools-v1.ts` and are mounted per Agent preset through
 * `@agentops/dsh-task/tools-v1`.
 *
 * @module @agentops/dsh-task/dsh
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'

import { createTaskExecutionHandler } from './execution.ts'
import type { TaskAgentRegistry, TaskPermissionController, TaskSessionController } from './execution.ts'
import { TaskHttpApi } from './http.ts'
import { registerTaskRpc } from './mount-rpc.ts'
import { assertSchemaVersion, createTaskSchema } from './schema.ts'
import { TaskService } from './service.ts'

export const name = 'agentops-task'

export const inject: string[] = []

/** Configuration of the task plugin. */
export interface TaskPluginConfig {
  /** SQLite file; omit to use `$DSH_HOME/agentops/agentops.db`. */
  dbPath?: string
  /** Workspace root for Markdown report documents; defaults beside the database. */
  exportRootDir?: string
  /** Source systems accepted for inbox captures. */
  allowedSourceSystems?: readonly string[]
  /** Directory holding Agent YAML definitions, used to resolve execution backend. */
  agentDir?: string
}

/** Default task configuration, overridable from `cordis.yml`. */
export const DEFAULT_CONFIG: TaskPluginConfig = {}

/**
 * Resolve the task database path: config, then `AGENTOPS_TASK_DB`, then
 * `$DSH_HOME/agentops/agentops.db`.
 * @param config - deployment configuration.
 * @param env - process environment.
 * @param home - home directory (injectable for tests).
 * @returns the resolved task database path.
 */
export function resolveTaskDbPath(
  config: TaskPluginConfig = DEFAULT_CONFIG,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  const explicit = config.dbPath?.trim()
  if (explicit !== undefined && explicit.length > 0) return explicit
  const fromEnv = env.AGENTOPS_TASK_DB?.trim()
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv
  return join(env.DSH_HOME?.trim() ?? join(home, '.dsh'), 'agentops', 'agentops.db')
}

/**
 * Mount the task capability at the root scope.
 *
 * A missing or empty database is initialised at `SCHEMA_VERSION`; any other
 * structure that is not the target version fails loudly instead of running
 * against a partial schema.
 * @param ctx - Cordis context.
 * @param config - database location, export root and source-system allowlist.
 */
export function apply(ctx: Context, config: TaskPluginConfig = DEFAULT_CONFIG): void {
  const path = resolveTaskDbPath(config)
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
  const existed = path === ':memory:' || existsSync(path)
  const db = new DatabaseSync(path)
  db.exec('PRAGMA foreign_keys = ON')
  if (path === ':memory:' || !existed || isEmptyDatabase(db)) {
    createTaskSchema(db)
  } else {
    try {
      assertSchemaVersion(db)
    } catch (error) {
      db.close()
      throw error
    }
  }
  const service = new TaskService(db, {
    ...(config.allowedSourceSystems === undefined ? {} : { allowedSourceSystems: config.allowedSourceSystems }),
  })
  const exportRootDir = config.exportRootDir ?? join(dirname(path), 'reports')
  const api = new TaskHttpApi(service, db, {
    exportRootDir,
    listWorkspaces: () => {
      // The workspace registry is an optional cross-package service; its typed key is not augmented in this package.
      const registry = (ctx.get as (name: string) => unknown)('workspaceRegistry') as { list(): readonly { id: string; title: string; path: string }[] } | undefined
      return registry?.list().map(workspace => ({ workspace_id: workspace.id, title: workspace.title, path: workspace.path })) ?? []
    },
  })
  ctx.inject(['connection'], (connectionCtx) => {
    registerTaskRpc(connectionCtx, api)
  })
  const agentDir = config.agentDir?.trim() ?? process.env.AGENTOPS_AGENT_DIR?.trim() ?? ''
  const resolveExecutionBackend = (agentPreset: string): 'dsh_native' | 'codex' | 'claude_code' | 'auto' => {
    if (agentDir === '') return 'auto'
    try {
      const source = readFileSync(join(agentDir, `${agentPreset}.yaml`), 'utf8')
      const match = /^execution_backend:[ \t]*(dsh_native|codex|claude_code|auto)[ \t]*$/m.exec(source)
      return (match?.[1] as 'dsh_native' | 'codex' | 'claude_code' | 'auto' | undefined) ?? 'auto'
    } catch {
      return 'auto'
    }
  }
  ctx.inject(['connection', 'sessionController', 'permissionPresets', 'agents'], (executionCtx) => {
    executionCtx.effect(() => executionCtx.connection.fetch.register({
      path: '/api/agentops/task-execute',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: createTaskExecutionHandler(
        service,
        (executionCtx.get as (name: string) => unknown)('sessionController') as TaskSessionController | undefined,
        (executionCtx.get as (name: string) => unknown)('permissionPresets') as TaskPermissionController | undefined,
        (executionCtx.get as (name: string) => unknown)('agents') as TaskAgentRegistry | undefined,
        resolveExecutionBackend,
      ),
    }), 'agentops-task: /api/agentops/task-execute')
  })
}

/**
 * Report whether a database has no user tables.
 * @param db - open handle.
 * @returns true when the file holds no application tables.
 */
function isEmptyDatabase(db: DatabaseSync): boolean {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .get() as { n: number }
  return row.n === 0
}
