/**
 * Transport-neutral HTTP router for the log collection control plane.
 *
 * The original AgentOps page managed log tasks through
 * `/api/log-collection/tasks`. This router keeps the same operations under the
 * shared `/api/agentops/log-collection` prefix and validates the referenced SSH
 * instance against the capability center before a task is stored.
 *
 * @module @agentops/dsh-log-collection/http
 */

import { randomUUID } from 'node:crypto'

import type { CapabilityStore } from '@agentops/dsh-capability'

import type { PullLogsService } from './pull.ts'
import { LogCollectionStore } from './store.ts'
import { LogCollectionError, type LogCollectionTask } from './types.ts'

/** One parsed log collection request. */
export interface LogCollectionHttpRequest {
  readonly method: string
  readonly path: string
  readonly query?: Readonly<Record<string, string | undefined>>
  readonly body?: unknown
  readonly actor?: string
  readonly tenantKey?: string
}

/** One log collection response. */
export interface LogCollectionHttpResponse {
  readonly status: number
  readonly body: unknown
}

const PREFIX = '/api/agentops/log-collection'

/** Default tenant for a single-owner deployment; a multi-tenant host overrides it. */
export const DEFAULT_TENANT = 'default'

/** Built-in workflow preset allowed to pull every configured log task. */
export const DEFAULT_LOG_PULL_PRESET = 'log_puller'

/** Built-in analysis preset allowed to query every configured log task. */
export const DEFAULT_LOG_QUERY_PRESET = 'log_analyst'

function json(status: number, body: unknown): LogCollectionHttpResponse {
  return { status, body }
}

function objectBody(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null) return {}
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new LogCollectionError('LOG_TASK_INVALID', 'request body must be a JSON object')
  }
  return value as Record<string, unknown>
}

function stringField(body: Record<string, unknown>, key: string): string {
  const value = body[key]
  if (typeof value !== 'string' || value.trim() === '') {
    throw new LogCollectionError('LOG_TASK_INVALID', `${key} is required`)
  }
  return value.trim()
}

function optionalString(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new LogCollectionError('LOG_TASK_INVALID', `${key} must be a string`)
  return value.trim()
}

function positiveInteger(body: Record<string, unknown>, key: string, fallback?: number): number {
  const value = body[key]
  if (value === undefined && fallback !== undefined) return fallback
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new LogCollectionError('LOG_TASK_INVALID', `${key} must be a non-negative integer`)
  }
  return parsed
}

function remotePaths(body: Record<string, unknown>): string[] {
  const value = body.remote_paths
  if (!Array.isArray(value) || value.length === 0) {
    throw new LogCollectionError('LOG_TASK_INVALID', 'remote_paths must be a non-empty array')
  }
  return value.map((item) => {
    if (typeof item !== 'string' || item.trim() === '') {
      throw new LogCollectionError('LOG_TASK_INVALID', 'remote_paths must contain non-empty strings')
    }
    return item.trim()
  })
}

/** Public task view: stored row plus the resolved absolute directory, never credential material. */
function taskView(task: LogCollectionTask, localDir: string): Record<string, unknown> {
  return {
    task_id: task.taskId,
    name: task.name,
    owner_domain: task.ownerDomain,
    ssh_instance_id: task.sshInstanceId,
    remote_paths: task.remotePaths,
    storage_key: task.storageKey,
    local_subdir: task.localSubdir,
    local_dir: localDir,
    local_max_days: task.localMaxDays,
    enabled: task.enabled,
    revision: task.revision,
    created_at: task.createdAt,
    updated_at: task.updatedAt,
  }
}

/** Stable transport-neutral log collection router. */
export class LogCollectionHttpApi {
  readonly #store: LogCollectionStore
  readonly #capabilities: CapabilityStore
  readonly #pull: PullLogsService | undefined

  /**
   * @param store - task registry.
   * @param capabilities - capability center used to validate SSH references.
   * @param pull - optional pull service used by the run-now action.
   */
  constructor(store: LogCollectionStore, capabilities: CapabilityStore, pull?: PullLogsService) {
    this.#store = store
    this.#capabilities = capabilities
    this.#pull = pull
  }

  /**
   * Grant the built-in workflows access to a task created through the control plane.
   *
   * The UI creates log tasks, but it does not expose preset ACL editing. Without
   * these grants a fresh task is visible in the page while both built-in
   * workflows fail at their first tool call. Explicit ACL APIs can still revoke
   * or extend these defaults afterwards.
   * @param tenantKey - authenticated tenant.
   * @param taskId - canonical task id.
   * @param actor - creating principal.
   */
  #ensureDefaultAccess(tenantKey: string, taskId: string, actor: string): void {
    const existing = this.#store.listAccess(tenantKey, taskId)
    if (!existing.some(entry => entry.agentPreset === DEFAULT_LOG_PULL_PRESET)) {
      this.#store.grantAccess(tenantKey, taskId, DEFAULT_LOG_PULL_PRESET, { canPull: true, canQuery: false }, actor)
    }
    if (!existing.some(entry => entry.agentPreset === DEFAULT_LOG_QUERY_PRESET)) {
      this.#store.grantAccess(tenantKey, taskId, DEFAULT_LOG_QUERY_PRESET, { canPull: false, canQuery: true }, actor)
    }
  }

  /**
   * Confirm one SSH instance exists, is enabled, and carries a credential.
   *
   * The store cannot check this itself: it may only see its own database. A task
   * pointing at a missing or disabled instance would create successfully and then
   * fail at pull time, which is exactly the failure the original centre prevented.
   * @param instanceId - capability instance id named by the task.
   */
  #assertSshInstance(instanceId: string): void {
    const instance = this.#capabilities.getInstance(instanceId)
    if (instance === null || instance.capabilityId !== 'ssh') {
      throw new LogCollectionError('CAPABILITY_INSTANCE_MISMATCH', `SSH 实例不存在：${instanceId}`)
    }
    if (instance.status !== 'enabled') {
      throw new LogCollectionError('CAPABILITY_INSTANCE_UNAVAILABLE', `SSH 实例未启用：${instanceId}`)
    }
    if (!instance.credentialConfigured) {
      throw new LogCollectionError('CREDENTIAL_UNAVAILABLE', `SSH 实例缺少凭证：${instanceId}`)
    }
    if (typeof instance.config.host_key_sha256 !== 'string' || instance.config.host_key_sha256.trim() === '') {
      throw new LogCollectionError('SSH_HOST_KEY_REJECTED', `SSH 实例未配置 Host Key 指纹：${instanceId}`)
    }
  }

  /**
   * List the SSH instances a task may reference.
   * @returns browser-safe instance summaries.
   */
  #listSshInstances(): Record<string, unknown>[] {
    return this.#capabilities.listInstances('ssh').map(instance => ({
      instance_id: instance.instanceId,
      name: instance.name,
      status: instance.status,
      host: instance.config.host ?? '',
      port: instance.config.port ?? null,
      username: instance.config.username ?? '',
      credential_configured: instance.credentialConfigured,
      host_key_pinned: typeof instance.config.host_key_sha256 === 'string'
        && instance.config.host_key_sha256.trim() !== '',
    }))
  }

  /**
   * Handle one log collection request.
   * @param request - method, logical path, query, body and authenticated actor.
   * @returns status and JSON response.
   */
  async handle(request: LogCollectionHttpRequest): Promise<LogCollectionHttpResponse> {
    try {
      const path = request.path
      if (!path.startsWith(PREFIX)) {
        return json(404, { error: { code: 'not_found', message: `unknown path ${path}` } })
      }
      const suffix = path.slice(PREFIX.length).replace(/^\//, '')
      const parts = suffix === '' ? [] : suffix.split('/')
      const method = request.method.toUpperCase()
      const actor = request.actor?.trim() || 'owner'
      const tenantKey = request.tenantKey?.trim() || DEFAULT_TENANT

      if (parts[0] === 'tasks' && parts.length === 1 && method === 'GET') {
        return json(200, {
          tasks: this.#store.list(tenantKey).map(task => taskView(task, this.#store.resolveTaskDirectory(task))),
          ssh_instances: this.#listSshInstances(),
        })
      }

      if (parts[0] === 'tasks' && parts.length === 1 && method === 'POST') {
        const body = objectBody(request.body)
        const sshInstanceId = stringField(body, 'ssh_instance_id')
        this.#assertSshInstance(sshInstanceId)
        const requestedTaskId = optionalString(body, 'task_id')
        const requestedSubdir = optionalString(body, 'local_subdir')
        const task = this.#store.create({
          tenantKey,
          ...(requestedTaskId === undefined || requestedTaskId === '' ? {} : { taskId: requestedTaskId }),
          name: stringField(body, 'name'),
          ownerDomain: optionalString(body, 'owner_domain') || 'smart_ops',
          sshInstanceId,
          remotePaths: remotePaths(body),
          ...(requestedSubdir === undefined || requestedSubdir === '' ? {} : { localSubdir: requestedSubdir }),
          localMaxDays: positiveInteger(body, 'local_max_days', 30),
          enabled: body.enabled === undefined ? true : body.enabled === true,
          actor,
        })
        this.#ensureDefaultAccess(tenantKey, task.taskId, actor)
        return json(201, { task: taskView(task, this.#store.resolveTaskDirectory(task)) })
      }

      if (parts[0] === 'tasks' && parts.length === 2 && method === 'PATCH') {
        const taskId = parts[1] ?? ''
        const current = this.#store.get(tenantKey, taskId)
        const body = objectBody(request.body)
        const sshInstanceId = optionalString(body, 'ssh_instance_id')
        if (sshInstanceId !== undefined && sshInstanceId !== current.sshInstanceId) {
          this.#assertSshInstance(sshInstanceId)
        }
        if (Array.isArray(body.remote_paths) && body.remote_paths.length === 0) {
          throw new LogCollectionError('LOG_TASK_INVALID', 'remote_paths must not be empty')
        }
        const nextName = optionalString(body, 'name')
        const nextSubdir = optionalString(body, 'local_subdir')
        const updated = this.#store.update({
          tenantKey,
          taskId,
          expectedRevision: positiveInteger(body, 'expected_revision', current.revision),
          actor,
          ...(nextName === undefined || nextName === '' ? {} : { name: nextName }),
          ...(sshInstanceId === undefined || sshInstanceId === '' ? {} : { sshInstanceId }),
          ...(body.remote_paths === undefined ? {} : { remotePaths: remotePaths(body) }),
          ...(nextSubdir === undefined ? {} : { localSubdir: nextSubdir }),
          ...(body.local_max_days === undefined ? {} : { localMaxDays: positiveInteger(body, 'local_max_days') }),
          ...(body.enabled === undefined ? {} : { enabled: body.enabled === true }),
        })
        return json(200, { task: taskView(updated, this.#store.resolveTaskDirectory(updated)) })
      }

      if (parts[0] === 'tasks' && parts.length === 2 && method === 'DELETE') {
        const taskId = parts[1] ?? ''
        this.#store.delete(tenantKey, taskId, actor)
        return json(200, { deleted: true, task_id: taskId })
      }

      if (parts[0] === 'tasks' && parts.length === 3 && parts[2] === 'acl' && method === 'GET') {
        const taskId = parts[1] ?? ''
        return json(200, { acl: this.#store.listAccess(tenantKey, taskId) })
      }

      if (parts[0] === 'tasks' && parts.length === 3 && parts[2] === 'acl' && method === 'PUT') {
        const taskId = parts[1] ?? ''
        const body = objectBody(request.body)
        const preset = stringField(body, 'agent_preset')
        this.#store.grantAccess(tenantKey, taskId, preset, {
          canPull: body.can_pull !== false,
          canQuery: body.can_query === true,
        }, actor)
        return json(200, { acl: this.#store.listAccess(tenantKey, taskId) })
      }

      if (parts[0] === 'tasks' && parts.length === 4 && parts[2] === 'acl' && method === 'DELETE') {
        const taskId = parts[1] ?? ''
        const preset = parts[3] ?? ''
        this.#store.revokeAccess(tenantKey, taskId, decodeURIComponent(preset), actor)
        return json(200, { acl: this.#store.listAccess(tenantKey, taskId) })
      }

      if (parts[0] === 'runs' && parts.length === 1 && method === 'GET') {
        const taskId = request.query?.task_id?.trim()
        const limit = Number.parseInt(request.query?.limit ?? '50', 10)
        return json(200, {
          runs: this.#store.runs.list(tenantKey, taskId === undefined || taskId === '' ? undefined : taskId, limit),
        })
      }

      if (parts[0] === 'tasks' && parts.length === 3 && parts[2] === 'run' && method === 'POST') {
        const taskId = parts[1] ?? ''
        if (this.#pull === undefined) {
          return json(503, { error: { code: 'pull_unavailable', message: '拉取服务未接入' } })
        }
        const task = this.#store.get(tenantKey, taskId)
        const startedAt = new Date().toISOString()
        const started = Date.now()
        try {
          const result = await this.#pull.pullAsOwner({
            tenantKey,
            logTaskId: taskId,
          })
          const files = result.files.map(file => ({
            remotePath: file.remotePath, localPath: file.localPath, bytes: file.bytes,
            deltaStart: file.deltaStart, deltaEnd: file.deltaEnd, skipped: file.skipped,
          }))
          this.#store.runs.record({
            runId: randomUUID(),
            tenantKey,
            taskId,
            sshInstanceId: task.sshInstanceId,
            actor,
            origin: 'manual',
            status: 'succeeded',
            startedAt,
            finishedAt: new Date().toISOString(),
            elapsedMs: Date.now() - started,
            fileCount: files.length,
            byteCount: files.reduce((sum, file) => sum + file.bytes, 0),
            files,
            errorCode: null,
            errorMessage: null,
          })
          return json(200, {
            ok: true,
            files: files.map(file => ({
              remote_path: file.remotePath, local_path: file.localPath, bytes: file.bytes,
              delta_start: file.deltaStart, delta_end: file.deltaEnd, skipped: file.skipped,
            })),
          })
        } catch (error) {
          const code = error instanceof LogCollectionError ? error.code : 'SFTP_PULL_FAILED'
          const message = error instanceof Error ? error.message : String(error)
          this.#store.runs.record({
            runId: randomUUID(),
            tenantKey,
            taskId,
            sshInstanceId: task.sshInstanceId,
            actor,
            origin: 'manual',
            status: 'failed',
            startedAt,
            finishedAt: new Date().toISOString(),
            elapsedMs: Date.now() - started,
            fileCount: 0,
            byteCount: 0,
            files: [],
            errorCode: code,
            errorMessage: message,
          })
          return json(400, { error: { code, message } })
        }
      }

      return json(404, { error: { code: 'not_found', message: `unknown route ${method} ${path}` } })
    } catch (error) {
      if (error instanceof LogCollectionError) {
        const status = error.code === 'LOG_TASK_NOT_FOUND' ? 404 : 400
        return json(status, { error: { code: error.code, message: error.message } })
      }
      throw error
    }
  }
}
