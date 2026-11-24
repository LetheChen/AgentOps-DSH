/**
 * pull_logs orchestration over the task registry and one SSH capability instance.
 * @module @agentops/dsh-log-collection/pull
 */

import { mkdir, readdir, rm, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'

import type { LogCollectionStore } from './store.ts'
import type { LogSftpTransport } from './transport.ts'
import { LogCollectionError, type PullLogsResult, type SshCapabilityResolver } from './types.ts'

/** Authenticated pull request. log_task_id is the only model-facing field. */
export interface PullLogsRequest {
  readonly tenantKey: string
  readonly agentPreset: string
  readonly logTaskId: string
  readonly signal?: AbortSignal
}

/** Resolve credentials only after the host key has been verified. */
export class PullLogsService {
  readonly #store: LogCollectionStore
  readonly #resolver: SshCapabilityResolver
  readonly #transport: LogSftpTransport

  /**
   * @param store - task registry.
   * @param resolver - capability configuration and delayed credential reader.
   * @param transport - strict read-only SFTP transport.
   */
  constructor(store: LogCollectionStore, resolver: SshCapabilityResolver, transport: LogSftpTransport) {
    this.#store = store
    this.#resolver = resolver
    this.#transport = transport
  }

  /**
   * Pull every configured remote path for one task, enforcing the preset ACL.
   * @param request - authenticated task id and cancellation signal.
   * @returns local files, byte counts and per-file delta ranges.
   */
  async pull(request: PullLogsRequest): Promise<PullLogsResult> {
    const task = this.#store.authorize(request.tenantKey, request.logTaskId, request.agentPreset, 'pull')
    return await this.#pullTask(task, request.signal)
  }

  /**
   * Pull one task on behalf of the authenticated owner.
   *
   * The owner-authored control plane is outside the preset ACL model: an operator
   * who can edit the task can already change its instance and paths, so requiring a
   * preset grant here would only make the "run now" action unusable. Preset-scoped
   * tools still go through `pull()`, which enforces the ACL.
   * @param request - tenant and task id named by the operator.
   * @returns local files, byte counts and per-file delta ranges.
   */
  async pullAsOwner(request: Omit<PullLogsRequest, 'agentPreset'>): Promise<PullLogsResult> {
    const task = this.#store.get(request.tenantKey, request.logTaskId)
    if (!task.enabled) throw new LogCollectionError('LOG_TASK_DISABLED', `task ${task.taskId} is disabled`)
    return await this.#pullTask(task, request.signal)
  }

  async #pullTask(
    task: {
      readonly tenantKey: string
      readonly taskId: string
      readonly sshInstanceId: string
      readonly remotePaths: readonly string[]
      readonly localMaxDays: number
      readonly localSubdir: string
      readonly storageKey: string
    },
    signal: AbortSignal | undefined,
  ): Promise<PullLogsResult> {
    const config = this.#resolver.resolveConfig(task.sshInstanceId)
    if (config.hostKeySha256.trim() === '') {
      throw new LogCollectionError('SSH_HOST_KEY_REJECTED', `SSH instance ${task.sshInstanceId} has no pinned host key`)
    }
    await this.#transport.probeHostKey(config)
    const states: {
      remotePath: string
      localName: string
      lastSize: number
      lastMtimeMs: number
      analyzedSize: number
      lastPulledAt: string
    }[] = []
    const credential = await this.#resolver.readCredential(task.sshInstanceId, config.instanceRevision)
    const directory = this.#store.resolveTaskDirectory(task)
    await mkdir(directory, { recursive: true })

    const remoteFiles = await this.#transport.resolveRemotePaths(config, credential, task.remotePaths, signal)
    const previous = this.#store.fileStates.list(task.tenantKey, task.taskId)
    const files: PullLogsResult['files'][number][] = []

    const used = new Map<string, string>()
    for (const remotePath of remoteFiles) {
      const localName = localNameFor(remotePath, used)
      const localPath = join(directory, localName)
      const previousState = previous.get(remotePath)
      const result = await this.#transport.pullFile(
        config,
        credential,
        remotePath,
        localPath,
        previousState === undefined
          ? undefined
          : { size: previousState.lastSize, mtimeMs: previousState.lastMtimeMs },
        signal,
      )
      files.push({
        remotePath,
        localPath,
        bytes: result.bytes,
        deltaStart: result.deltaStart,
        deltaEnd: result.deltaEnd,
        skipped: result.skipped,
      })
      // A rotated or replaced file has a new byte space, so its analyzed offset resets.
      const analyzedSize = result.deltaStart === 0 && !result.skipped
        ? 0
        : previousState?.analyzedSize ?? 0
      states.push({
        remotePath,
        localName,
        lastSize: result.bytes,
        lastMtimeMs: result.mtimeMs,
        analyzedSize,
        lastPulledAt: new Date().toISOString(),
      })
    }
    this.#store.fileStates.replace(task.tenantKey, task.taskId, states)
    const cleaned = await cleanupRetention(directory, task.localMaxDays)
    return {
      ok: true,
      logTaskId: task.taskId,
      sshInstanceId: task.sshInstanceId,
      files,
      filesCleaned: cleaned,
    }
  }
}

/** Pick a local file name, disambiguating identical basenames from different directories. */
function localNameFor(remotePath: string, used: Map<string, string>): string {
  const name = basename(remotePath)
  const existing = used.get(name)
  if (existing === undefined || existing === remotePath) {
    used.set(name, remotePath)
    return name
  }
  return remotePath.replace(/^\//, '').replaceAll('/', '_')
}

/** Delete local files older than the task's retention window. */
async function cleanupRetention(directory: string, maxDays: number): Promise<number> {
  if (maxDays <= 0) return 0
  const cutoff = Date.now() - maxDays * 86_400_000
  let cleaned = 0
  let entries: string[]
  try { entries = await readdir(directory) } catch { return 0 }
  for (const entry of entries) {
    const path = join(directory, entry)
    try {
      const info = await stat(path)
      if (info.isFile() && info.mtimeMs < cutoff) {
        await rm(path, { force: true })
        cleaned += 1
      }
    } catch {
      // A file removed concurrently is already in the desired state.
    }
  }
  return cleaned
}
