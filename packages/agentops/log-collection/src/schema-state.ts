/**
 * Per-task local layout and per-file incremental state.
 *
 * AgentOps kept a `local_path` on every task and a `{size, mtime}` checkpoint in
 * `workspace/log-collection/state/<task>.json`. DSH keeps both in the same
 * control-plane database so the page, the pull tool and the analyzer read one
 * fact source.
 *
 * @module @agentops/dsh-log-collection/schema-state
 */

import type { DatabaseSync } from 'node:sqlite'

/** Current schema version after adding local layout and file state. */
export const LOG_COLLECTION_STATE_SCHEMA_VERSION = 4

/** One file's incremental checkpoint. */
export interface LogCollectionFileState {
  readonly remotePath: string
  readonly localName: string
  readonly lastSize: number
  readonly lastMtimeMs: number
  /** Byte offset already turned into a report by the analysis workflow. */
  readonly analyzedSize: number
  readonly lastPulledAt: string
}

interface FileStateRow {
  remote_path: string
  local_name: string
  last_size: number
  last_mtime_ms: number
  analyzed_size: number
  last_pulled_at: string
}

/**
 * Add the business-local directory column and the per-file checkpoint table.
 * @param db - open database at schema version 2.
 */
export function createLogCollectionStateSchema(db: DatabaseSync): void {
  db.exec(`
    PRAGMA user_version = 3;
    ALTER TABLE log_collection_tasks ADD COLUMN local_subdir TEXT NOT NULL DEFAULT '';
    CREATE TABLE log_collection_file_state (
      tenant_key TEXT NOT NULL,
      task_id TEXT NOT NULL,
      remote_path TEXT NOT NULL,
      local_name TEXT NOT NULL,
      last_size INTEGER NOT NULL CHECK(last_size >= 0),
      last_mtime_ms INTEGER NOT NULL CHECK(last_mtime_ms >= 0),
      last_pulled_at TEXT NOT NULL,
      PRIMARY KEY (tenant_key, task_id, remote_path)
    );
  `)
}

/**
 * Add the analysis offset. Collection and patrol run on separate schedules,
 * so the analyzer must track its own position instead of reusing the last pull window.
 * @param db - open database at schema version 3.
 */
export function migrateLogCollectionAnalysisSchema(db: DatabaseSync): void {
  db.exec(`
    PRAGMA user_version = 4;
    ALTER TABLE log_collection_file_state ADD COLUMN analyzed_size INTEGER NOT NULL DEFAULT 0;
  `)
}

/** Read and write incremental checkpoints for one task. */
export class LogCollectionFileStates {
  readonly #db: DatabaseSync

  /**
   * @param db - open database at schema version 3 or later.
   */
  constructor(db: DatabaseSync) {
    this.#db = db
  }

  /**
   * Read every checkpoint for one task.
   * @param tenantKey - authenticated tenant.
   * @param taskId - canonical task id.
   * @returns checkpoints keyed by remote path.
   */
  list(tenantKey: string, taskId: string): Map<string, LogCollectionFileState> {
    const rows = this.#db.prepare(`
      SELECT remote_path, local_name, last_size, last_mtime_ms, analyzed_size, last_pulled_at
      FROM log_collection_file_state WHERE tenant_key = ? AND task_id = ?
    `).all(tenantKey, taskId) as unknown as FileStateRow[]
    return new Map(rows.map(row => [row.remote_path, {
      remotePath: row.remote_path,
      localName: row.local_name,
      lastSize: row.last_size,
      lastMtimeMs: row.last_mtime_ms,
      analyzedSize: row.analyzed_size,
      lastPulledAt: row.last_pulled_at,
    }]))
  }

  /**
   * Replace the checkpoint set for one task in a single statement per file.
   * @param tenantKey - authenticated tenant.
   * @param taskId - canonical task id.
   * @param states - checkpoints after a successful pull.
   */
  replace(tenantKey: string, taskId: string, states: readonly LogCollectionFileState[]): void {
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      this.#db.prepare('DELETE FROM log_collection_file_state WHERE tenant_key = ? AND task_id = ?')
        .run(tenantKey, taskId)
      const insert = this.#db.prepare(`
        INSERT INTO log_collection_file_state(
          tenant_key, task_id, remote_path, local_name, last_size, last_mtime_ms, analyzed_size, last_pulled_at
        ) VALUES (?,?,?,?,?,?,?,?)
      `)
      for (const state of states) {
        insert.run(
          tenantKey,
          taskId,
          state.remotePath,
          state.localName,
          state.lastSize,
          state.lastMtimeMs,
          state.analyzedSize,
          state.lastPulledAt,
        )
      }
      this.#db.exec('COMMIT')
    } catch (error) {
      this.#db.exec('ROLLBACK')
      throw error
    }
  }
  /**
   * Advance the analyzed offset for one remote file.
   * @param tenantKey - authenticated tenant.
   * @param taskId - canonical task id.
   * @param remotePath - concrete remote file.
   * @param offset - byte offset turned into a report.
   */
  advanceAnalyzed(tenantKey: string, taskId: string, remotePath: string, offset: number): void {
    this.#db.prepare(`
      UPDATE log_collection_file_state SET analyzed_size = ?
      WHERE tenant_key = ? AND task_id = ? AND remote_path = ?
    `).run(offset, tenantKey, taskId, remotePath)
  }
}
