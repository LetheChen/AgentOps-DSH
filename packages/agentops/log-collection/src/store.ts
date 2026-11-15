/**
 * SQLite-backed log collection task registry.
 * @module @agentops/dsh-log-collection/store
 */

import { randomUUID } from 'node:crypto'
import { isAbsolute, join, relative, resolve } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'

import {
  LOG_COLLECTION_SCHEMA_VERSION,
  createLogCollectionSchema,
  readLogCollectionSchemaVersion,
} from './schema.ts'
import { LOG_COLLECTION_RUN_SCHEMA_VERSION, createLogCollectionRunSchema, LogCollectionRuns } from './schema-runs.ts'
import { LOG_COLLECTION_STATE_SCHEMA_VERSION, createLogCollectionStateSchema, migrateLogCollectionAnalysisSchema, LogCollectionFileStates } from './schema-state.ts'
import {
  LogCollectionError,
  type CreateLogCollectionTaskInput,
  type LogCollectionTask,
  type LogCollectionTaskAcl,
  type UpdateLogCollectionTaskInput,
} from './types.ts'

interface TaskRow {
  task_uid: string
  tenant_key: string
  task_id: string
  name: string
  owner_domain: string
  ssh_instance_id: string
  remote_paths_json: string
  storage_key: string
  local_subdir: string
  local_max_days: number
  enabled: number
  revision: number
  created_at: string
  updated_at: string
}

interface AclRow {
  agent_preset: string
  can_pull: number
  can_query: number
  revoked_at: string | null
}

const TASK_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/
const TENANT_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i

/** Options for one registry instance. */
export interface LogCollectionStoreOptions {
  readonly localRoot: string
}

/** Task registry and authorization service. */
export class LogCollectionStore {
  readonly #db: DatabaseSync
  readonly #localRoot: string
  /** Append-only pull run evidence. */
  readonly runs: LogCollectionRuns
  /** Per-file incremental checkpoints. */
  readonly fileStates: LogCollectionFileStates

  /**
   * @param db - open SQLite database.
   * @param options - local collection root.
   */
  constructor(db: DatabaseSync, options: LogCollectionStoreOptions) {
    if (!isAbsolute(options.localRoot)) {
      throw new LogCollectionError('LOG_LOCAL_ROOT_INVALID', 'localRoot must be absolute')
    }
    this.#db = db
    this.#localRoot = resolve(options.localRoot)
    db.exec('PRAGMA foreign_keys = ON')
    const version = readLogCollectionSchemaVersion(db)
    if (version === 0) createLogCollectionSchema(db)
    // v1 databases upgrade in place; run history is additive and never rewrites tasks.
    if (readLogCollectionSchemaVersion(db) === LOG_COLLECTION_SCHEMA_VERSION) {
      createLogCollectionRunSchema(db)
    }
    if (readLogCollectionSchemaVersion(db) === LOG_COLLECTION_RUN_SCHEMA_VERSION) {
      createLogCollectionStateSchema(db)
    }
    if (readLogCollectionSchemaVersion(db) === 3) {
      migrateLogCollectionAnalysisSchema(db)
    }
    if (readLogCollectionSchemaVersion(db) !== LOG_COLLECTION_STATE_SCHEMA_VERSION) {
      throw new LogCollectionError('LOG_TASK_INVALID', `unsupported log collection schema ${version}`)
    }
    this.runs = new LogCollectionRuns(db)
    this.fileStates = new LogCollectionFileStates(db)
  }

  /**
   * Create one task.
   * @param input - task fields; tenant and domain come from authorization context.
   * @returns the created task.
   */
  create(input: CreateLogCollectionTaskInput): LogCollectionTask {
    const tenantKey = normalizeTenant(input.tenantKey)
    const taskId = normalizeTaskId(input.taskId ?? input.name)
    const remotePaths = normalizeRemotePaths(input.remotePaths)
    assertCommonInput(input.name, input.ownerDomain, input.sshInstanceId, input.actor, input.localMaxDays)
    const revision = 1
    const enabled = input.enabled ?? true
    const now = new Date().toISOString()
    const taskUid = randomUUID()
    const storageKey = `${tenantKey}/${taskId}`
    const localSubdir = normalizeLocalSubdir(input.localSubdir ?? '')
    try {
      this.#transaction(() => {
        this.#db.prepare(`
          INSERT INTO log_collection_tasks(
            task_uid, tenant_key, task_id, task_id_normalized, name, owner_domain,
            ssh_instance_id, remote_paths_json, storage_key, local_subdir, local_max_days, enabled,
            revision, created_by, updated_by, created_at, updated_at
          ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        `).run(
          taskUid, tenantKey, taskId, taskId, input.name.trim(), input.ownerDomain.trim(),
          input.sshInstanceId.trim(), JSON.stringify(remotePaths), storageKey, localSubdir,
          input.localMaxDays, enabled ? 1 : 0, revision, input.actor.trim(), input.actor.trim(), now, now,
        )
      })
    } catch (error) {
      // A soft-deleted task keeps its id reserved; surface that as a conflict
      // rather than leaking the raw SQLite constraint text.
      if (error instanceof Error && /UNIQUE constraint failed/.test(error.message)) {
        throw new LogCollectionError('LOG_TASK_CONFLICT', `task id ${taskId} is already taken`)
      }
      throw error
    }
    return this.get(tenantKey, taskId)
  }

  /**
   * List live tasks in one tenant.
   * @param tenantKey - authenticated tenant.
   * @returns tasks ordered by task id.
   */
  list(tenantKey: string): readonly LogCollectionTask[] {
    const tenant = normalizeTenant(tenantKey)
    const rows = this.#db.prepare(`
      SELECT task_uid, tenant_key, task_id, name, owner_domain, ssh_instance_id,
             remote_paths_json, storage_key, local_subdir, local_max_days, enabled, revision,
             created_at, updated_at
      FROM log_collection_tasks
      WHERE tenant_key = ? AND deleted_at IS NULL
      ORDER BY task_id_normalized
    `).all(tenant) as unknown as TaskRow[]
    return rows.map(toTask)
  }

  /**
   * Read one live task.
   * @param tenantKey - authenticated tenant.
   * @param taskId - canonical business task id.
   * @returns the task.
   */
  get(tenantKey: string, taskId: string): LogCollectionTask {
    const tenant = normalizeTenant(tenantKey)
    const id = normalizeTaskId(taskId)
    const row = this.#db.prepare(`
      SELECT task_uid, tenant_key, task_id, name, owner_domain, ssh_instance_id,
             remote_paths_json, storage_key, local_subdir, local_max_days, enabled, revision,
             created_at, updated_at
      FROM log_collection_tasks
      WHERE tenant_key = ? AND task_id_normalized = ? AND deleted_at IS NULL
    `).get(tenant, id) as TaskRow | undefined
    if (row === undefined) throw new LogCollectionError('LOG_TASK_NOT_FOUND', `task ${id} not found`)
    return toTask(row)
  }

  /**
   * Update one task with optimistic revision checking.
   * @param input - changed fields and expected revision.
   * @returns updated task.
   */
  update(input: UpdateLogCollectionTaskInput): LogCollectionTask {
    const tenant = normalizeTenant(input.tenantKey)
    const id = normalizeTaskId(input.taskId)
    const current = this.get(tenant, id)
    if (current.revision !== input.expectedRevision) {
      throw new LogCollectionError('LOG_TASK_CONFLICT', `expected revision ${input.expectedRevision}, got ${current.revision}`)
    }
    const name = input.name?.trim() ?? current.name
    const sshInstanceId = input.sshInstanceId?.trim() ?? current.sshInstanceId
    const remotePaths = input.remotePaths === undefined ? current.remotePaths : normalizeRemotePaths(input.remotePaths)
    const localSubdir = input.localSubdir === undefined ? current.localSubdir : normalizeLocalSubdir(input.localSubdir)
    const localMaxDays = input.localMaxDays ?? current.localMaxDays
    const actor = input.actor.trim()
    assertCommonInput(name, current.ownerDomain, sshInstanceId, actor, localMaxDays)
    this.#db.prepare(`
      UPDATE log_collection_tasks
      SET name = ?, ssh_instance_id = ?, remote_paths_json = ?, local_subdir = ?, local_max_days = ?,
          enabled = ?, revision = revision + 1, updated_by = ?, updated_at = ?
      WHERE tenant_key = ? AND task_id_normalized = ? AND revision = ? AND deleted_at IS NULL
    `).run(
      name, sshInstanceId, JSON.stringify(remotePaths), localSubdir, localMaxDays,
      (input.enabled ?? current.enabled) ? 1 : 0, actor, new Date().toISOString(),
      tenant, id, input.expectedRevision,
    )
    // Moving the business directory invalidates the old checkpoints: without this
    // the next pull would see unchanged size/mtime and leave the new directory empty.
    if (localSubdir !== current.localSubdir) {
      this.#db.prepare('DELETE FROM log_collection_file_state WHERE tenant_key = ? AND task_id = ?')
        .run(tenant, id)
    }
    return this.get(tenant, id)
  }

  /**
   * Soft-delete one task. Task ids are never reused.
   * @param tenantKey - authenticated tenant.
   * @param taskId - canonical task id.
   * @param actor - deleting principal.
   */
  delete(tenantKey: string, taskId: string, actor: string): void {
    const tenant = normalizeTenant(tenantKey)
    const id = normalizeTaskId(taskId)
    const task = this.get(tenant, id)
    const now = new Date().toISOString()
    this.#db.prepare(`
      UPDATE log_collection_tasks
      SET enabled = 0, deleted_at = ?, deleted_by = ?, updated_by = ?, updated_at = ?,
          revision = revision + 1
      WHERE tenant_key = ? AND task_id_normalized = ? AND revision = ?
    `).run(now, actor.trim(), actor.trim(), now, tenant, id, task.revision)
  }

  /**
   * Grant pull/query access to one Agent preset.
   * @param tenantKey - authenticated tenant.
   * @param taskId - canonical task id.
   * @param preset - Agent preset id.
   * @param permissions - requested permissions.
   * @param actor - granting principal.
   */
  grantAccess(
    tenantKey: string,
    taskId: string,
    preset: string,
    permissions: { readonly canPull: boolean; readonly canQuery: boolean },
    actor: string,
  ): void {
    const task = this.get(tenantKey, taskId)
    if (!permissions.canPull && !permissions.canQuery) {
      throw new LogCollectionError('LOG_TASK_INVALID', 'at least one ACL permission is required')
    }
    const row = this.#db.prepare(`
      SELECT COALESCE(MAX(generation), 0) AS generation
      FROM log_collection_task_acl WHERE task_uid = ?
    `).get(task.taskUid) as { generation: number }
    this.#db.prepare(`
      INSERT INTO log_collection_task_acl(
        tenant_key, task_uid, agent_preset, generation, can_pull, can_query, granted_by, granted_at
      ) VALUES (?,?,?,?,?,?,?,?)
    `).run(
      task.tenantKey, task.taskUid, preset.trim(), row.generation + 1,
      permissions.canPull ? 1 : 0, permissions.canQuery ? 1 : 0,
      actor.trim(), new Date().toISOString(),
    )
  }

  /**
   * Revoke the active ACL grant for one preset.
   * @param tenantKey - authenticated tenant.
   * @param taskId - canonical task id.
   * @param preset - Agent preset id.
   * @param actor - revoking principal.
   */
  revokeAccess(tenantKey: string, taskId: string, preset: string, actor: string): void {
    const task = this.get(tenantKey, taskId)
    const now = new Date().toISOString()
    const result = this.#db.prepare(`
      UPDATE log_collection_task_acl
      SET revoked_at = ?, revoked_by = ?
      WHERE task_uid = ? AND agent_preset = ? AND revoked_at IS NULL
    `).run(now, actor.trim(), task.taskUid, preset.trim())
    if (result.changes === 0) throw new LogCollectionError('LOG_TASK_ACCESS_DENIED', 'active ACL grant not found')
  }

  /**
   * List active ACL entries for one task.
   * @param tenantKey - authenticated tenant.
   * @param taskId - canonical task id.
   * @returns active grants.
   */
  listAccess(tenantKey: string, taskId: string): readonly LogCollectionTaskAcl[] {
    const task = this.get(tenantKey, taskId)
    const rows = this.#db.prepare(`
      SELECT agent_preset, can_pull, can_query, revoked_at
      FROM log_collection_task_acl WHERE task_uid = ? AND revoked_at IS NULL
      ORDER BY agent_preset
    `).all(task.taskUid) as unknown as AclRow[]
    return rows.map(row => ({
      agentPreset: row.agent_preset,
      canPull: row.can_pull === 1,
      canQuery: row.can_query === 1,
      revoked: row.revoked_at !== null,
    }))
  }

  /**
   * Authorize one preset for pull or query.
   * @param tenantKey - authenticated tenant.
   * @param taskId - canonical task id.
   * @param preset - Agent preset id.
   * @param permission - requested operation.
   * @returns the authorized task.
   */
  authorize(tenantKey: string, taskId: string, preset: string, permission: 'pull' | 'query'): LogCollectionTask {
    const task = this.get(tenantKey, taskId)
    if (!task.enabled) throw new LogCollectionError('LOG_TASK_DISABLED', `task ${task.taskId} is disabled`)
    const row = this.#db.prepare(`
      SELECT agent_preset, can_pull, can_query, revoked_at
      FROM log_collection_task_acl
      WHERE task_uid = ? AND agent_preset = ? AND revoked_at IS NULL
    `).get(task.taskUid, preset.trim()) as AclRow | undefined
    if (row === undefined || (permission === 'pull' ? row.can_pull : row.can_query) !== 1) {
      throw new LogCollectionError('LOG_TASK_ACCESS_DENIED', `preset ${preset} cannot ${permission} task ${task.taskId}`)
    }
    return task
  }

  /**
   * Resolve the task directory beneath the configured local root.
   * @param task - task to resolve.
   * @returns absolute task directory.
   */
  resolveTaskDirectory(task: Pick<LogCollectionTask, 'storageKey' | 'localSubdir'>): string {
    const target = resolve(join(this.#localRoot, task.localSubdir === '' ? task.storageKey : task.localSubdir))
    const rel = relative(this.#localRoot, target)
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
      throw new LogCollectionError('LOG_LOCAL_ROOT_INVALID', 'task storage escapes local root')
    }
    return target
  }

  #transaction<T>(operation: () => T): T {
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      const result = operation()
      this.#db.exec('COMMIT')
      return result
    } catch (error) {
      this.#db.exec('ROLLBACK')
      throw error
    }
  }
}

function toTask(row: TaskRow): LogCollectionTask {
  return {
    taskUid: row.task_uid,
    tenantKey: row.tenant_key,
    taskId: row.task_id,
    name: row.name,
    ownerDomain: row.owner_domain,
    sshInstanceId: row.ssh_instance_id,
    remotePaths: JSON.parse(row.remote_paths_json) as string[],
    storageKey: row.storage_key,
    localSubdir: row.local_subdir,
    localMaxDays: row.local_max_days,
    enabled: row.enabled === 1,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/** Business-local subdirectory: relative, POSIX separators, contained by the root. */
function normalizeLocalSubdir(value: string): string {
  const trimmed = value.trim().replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '')
  if (trimmed === '') return ''
  if (trimmed.includes('\0') || /^[A-Za-z]:/.test(trimmed) || trimmed.startsWith('/')) {
    throw new LogCollectionError('LOG_LOCAL_ROOT_INVALID', 'local subdirectory must be relative')
  }
  const parts = trimmed.split('/')
  if (parts.some(part => part === '' || part === '.' || part === '..')) {
    throw new LogCollectionError('LOG_LOCAL_ROOT_INVALID', 'local subdirectory must not contain . or ..')
  }
  return parts.join('/')
}

function normalizeTenant(value: string): string {
  const tenant = value.trim().toLowerCase()
  if (!TENANT_ID.test(tenant) || WINDOWS_RESERVED.test(tenant)) {
    throw new LogCollectionError('LOG_TASK_INVALID', 'invalid tenant key')
  }
  return tenant
}

function normalizeTaskId(value: string): string {
  const id = value.trim().toLowerCase().replace(/\s+/g, '-')
  if (!TASK_ID.test(id) || WINDOWS_RESERVED.test(id)) {
    throw new LogCollectionError('LOG_TASK_INVALID', 'invalid task id')
  }
  return id
}

function normalizeRemotePaths(paths: readonly string[]): readonly string[] {
  const normalized = paths.map(path => path.trim())
  if (normalized.length === 0) throw new LogCollectionError('LOG_TASK_INVALID', 'at least one remote path is required')
  const seen = new Set<string>()
  for (const path of normalized) {
    if (!path.startsWith('/') || path.endsWith('/') || path.includes('\0') || path.split('/').includes('..') || path.split('/').includes('.')) {
      throw new LogCollectionError('LOG_TASK_INVALID', `invalid remote path: ${path}`)
    }
    if (seen.has(path)) throw new LogCollectionError('LOG_TASK_INVALID', `duplicate remote path: ${path}`)
    seen.add(path)
  }
  return normalized
}

function assertCommonInput(name: string, ownerDomain: string, sshInstanceId: string, actor: string, localMaxDays: number): void {
  if (name.trim() === '' || ownerDomain.trim() === '' || sshInstanceId.trim() === '' || actor.trim() === '') {
    throw new LogCollectionError('LOG_TASK_INVALID', 'name, owner domain, SSH instance and actor are required')
  }
  if (!Number.isSafeInteger(localMaxDays) || localMaxDays < 0) {
    throw new LogCollectionError('LOG_TASK_INVALID', 'localMaxDays must be a non-negative integer')
  }
}
