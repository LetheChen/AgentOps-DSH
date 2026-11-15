/**
 * Read only the bytes not yet turned into a report.
 *
 * Collection and patrol run on separate schedules. The analyzer therefore keeps
 * its own offset per file (`analyzed_size`) instead of reusing the latest pull
 * window; several collections between two patrols still form one analysis window.
 *
 * @module @agentops/dsh-log-collection/delta
 */

import { open, stat } from 'node:fs/promises'
import { join } from 'node:path'

import type { LogCollectionStore } from './store.ts'
import { LogCollectionError } from './types.ts'

/** One file's incremental slice. */
export interface DeltaFile {
  readonly remotePath: string
  readonly localPath: string
  readonly deltaStart: number
  readonly deltaEnd: number
  readonly matched: number
  readonly truncated: boolean
  readonly lines: readonly string[]
}

/** Result of reading one task's analysis window. */
export interface DeltaReadResult {
  readonly logTaskId: string
  readonly files: readonly DeltaFile[]
  readonly truncated: boolean
}

/** Read the not-yet-analyzed window for one task. */
export class LogDeltaReader {
  readonly #store: LogCollectionStore

  /**
   * @param store - task registry that owns file state.
   */
  constructor(store: LogCollectionStore) {
    this.#store = store
  }

  /**
   * Read and filter the unanalyzed window, then advance the analysis cursor.
   * @param tenantKey - authenticated tenant.
   * @param agentPreset - preset holding the query grant.
   * @param logTaskId - canonical task id.
   * @param options - level filter and per-file byte cap.
   * @returns matched lines per file.
   */
  async read(
    tenantKey: string,
    agentPreset: string,
    logTaskId: string,
    options: { readonly level?: string; readonly maxBytes?: number; readonly maxLines?: number } = {},
  ): Promise<DeltaReadResult> {
    const task = this.#store.authorize(tenantKey, logTaskId, agentPreset, 'query')
    const directory = this.#store.resolveTaskDirectory(task)
    const states = [...this.#store.fileStates.list(tenantKey, logTaskId).values()]
    if (states.length === 0) {
      throw new LogCollectionError('LOG_TASK_INVALID', `task ${logTaskId} has no collected file yet`)
    }
    const maxBytes = Math.min(Math.max(options.maxBytes ?? 2_097_152, 1024), 2_097_152)
    const maxLines = Math.min(Math.max(options.maxLines ?? 500, 1), 5000)
    const level = (options.level ?? '').trim().toUpperCase()
    const matcher = level === '' ? undefined : new RegExp(`\\b${escapeRegExp(level)}\\b`, 'i')
    const files: DeltaFile[] = []
    let truncated = false
    for (const state of states) {
      const localPath = join(directory, state.localName)
      const info = await stat(localPath).catch(() => undefined)
      if (info === undefined || !info.isFile()) {
        throw new LogCollectionError('SFTP_PULL_FAILED', `本地文件缺失：${localPath}`)
      }
      // A file smaller than its cursor was rotated: analyze it from the start.
      const start = info.size < state.analyzedSize ? 0 : Math.min(state.analyzedSize, info.size)
      const end = Math.min(info.size, state.lastSize)
      const length = Math.max(0, end - start)
      const readLength = Math.min(length, maxBytes)
      const buffer = Buffer.alloc(readLength)
      if (readLength > 0) {
        const handle = await open(localPath, 'r')
        try { await handle.read(buffer, 0, readLength, start) } finally { await handle.close() }
      }
      const all = buffer.toString('utf8').split(/\r?\n/)
      const matched = matcher === undefined ? all : all.filter(line => matcher.test(line))
      const fileTruncated = readLength < length || matched.length > maxLines
      if (fileTruncated) truncated = true
      files.push({
        remotePath: state.remotePath,
        localPath,
        deltaStart: start,
        deltaEnd: readLength === length ? end : start + readLength,
        matched: matched.length,
        truncated: fileTruncated,
        lines: matched.slice(0, maxLines),
      })
      // Advance only by what was actually handed to the analyzer.
      this.#store.fileStates.advanceAnalyzed(tenantKey, logTaskId, state.remotePath, start + readLength)
    }
    return { logTaskId, files, truncated }
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
