/**
 * Optional run history for log collection pulls.
 *
 * v1 stopped at the task registry. The control plane needs evidence of what each
 * pull actually did — the original AgentOps log-pull page showed file counts,
 * byte totals and errors per run — so this slice adds a durable run row written
 * after every successful or failed pull.
 *
 * @module @agentops/dsh-log-collection/schema-runs
 */

import type { DatabaseSync, SQLOutputValue } from 'node:sqlite'

/** Current schema version after adding the run history. */
export const LOG_COLLECTION_RUN_SCHEMA_VERSION = 2

/**
 * Add the pull run history table.
 *
 * Runs are append-only evidence. They reference a task by its stable id rather
 * than the surrogate UID so a soft-deleted task's history stays readable.
 * @param db - open database at schema version 1.
 */
export function createLogCollectionRunSchema(db: DatabaseSync): void {
  db.exec(`
    PRAGMA user_version = 2;
    CREATE TABLE log_collection_runs (
      run_id TEXT PRIMARY KEY,
      tenant_key TEXT NOT NULL,
      task_id TEXT NOT NULL,
      ssh_instance_id TEXT NOT NULL,
      actor TEXT NOT NULL,
      origin TEXT NOT NULL CHECK(origin IN ('manual','tool','schedule')),
      status TEXT NOT NULL CHECK(status IN ('succeeded','failed')),
      started_at TEXT NOT NULL,
      finished_at TEXT NOT NULL,
      elapsed_ms INTEGER NOT NULL CHECK(elapsed_ms >= 0),
      file_count INTEGER NOT NULL CHECK(file_count >= 0),
      byte_count INTEGER NOT NULL CHECK(byte_count >= 0),
      files_json TEXT NOT NULL DEFAULT '[]',
      error_code TEXT,
      error_message TEXT,
      CHECK(json_valid(files_json)),
      CHECK(json_type(files_json) = 'array'),
      CHECK((status = 'succeeded' AND error_code IS NULL AND error_message IS NULL)
          OR (status = 'failed'))
    );
    CREATE INDEX idx_log_collection_runs_task
      ON log_collection_runs(tenant_key, task_id, finished_at DESC);
    CREATE INDEX idx_log_collection_runs_recent
      ON log_collection_runs(finished_at DESC);
  `)
}

/** One recorded pull run. */
export interface LogCollectionRun {
  readonly runId: string
  readonly tenantKey: string
  readonly taskId: string
  readonly sshInstanceId: string
  readonly actor: string
  readonly origin: 'manual' | 'tool' | 'schedule'
  readonly status: 'succeeded' | 'failed'
  readonly startedAt: string
  readonly finishedAt: string
  readonly elapsedMs: number
  readonly fileCount: number
  readonly byteCount: number
  readonly files: readonly {
    readonly remotePath: string
    readonly localPath: string
    readonly bytes: number
    readonly deltaStart: number
    readonly deltaEnd: number
    readonly skipped: boolean
  }[]
  readonly errorCode: string | null
  readonly errorMessage: string | null
}

interface RunRow extends Record<string, SQLOutputValue> {
  run_id: string
  tenant_key: string
  task_id: string
  ssh_instance_id: string
  actor: string
  origin: string
  status: string
  started_at: string
  finished_at: string
  elapsed_ms: number
  file_count: number
  byte_count: number
  files_json: string
  error_code: string | null
  error_message: string | null
}

/** Append and read pull run evidence. */
export class LogCollectionRuns {
  readonly #db: DatabaseSync

  /**
   * @param db - open database at schema version 2 or later.
   */
  constructor(db: DatabaseSync) {
    this.#db = db
  }

  /**
   * Append one finished run.
   * @param run - completed evidence, already timed by the caller.
   */
  record(run: LogCollectionRun): void {
    this.#db.prepare(`
      INSERT INTO log_collection_runs(
        run_id, tenant_key, task_id, ssh_instance_id, actor, origin, status,
        started_at, finished_at, elapsed_ms, file_count, byte_count, files_json,
        error_code, error_message
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      run.runId, run.tenantKey, run.taskId, run.sshInstanceId, run.actor, run.origin, run.status,
      run.startedAt, run.finishedAt, run.elapsedMs, run.fileCount, run.byteCount,
      JSON.stringify(run.files), run.errorCode, run.errorMessage,
    )
  }

  /**
   * List recent runs, newest first.
   * @param tenantKey - authenticated tenant.
   * @param taskId - optional task filter.
   * @param limit - maximum rows.
   * @returns recorded runs.
   */
  list(tenantKey: string, taskId: string | undefined, limit: number = 50): readonly LogCollectionRun[] {
    const bounded = Math.min(Math.max(Math.trunc(limit), 1), 200)
    const rows = (taskId === undefined || taskId === ''
      ? this.#db.prepare(`
          SELECT * FROM log_collection_runs WHERE tenant_key = ?
          ORDER BY finished_at DESC LIMIT ?
        `).all(tenantKey, bounded)
      : this.#db.prepare(`
          SELECT * FROM log_collection_runs WHERE tenant_key = ? AND task_id = ?
          ORDER BY finished_at DESC LIMIT ?
        `).all(tenantKey, taskId, bounded)) as RunRow[]
    return rows.map(row => ({
      runId: row.run_id,
      tenantKey: row.tenant_key,
      taskId: row.task_id,
      sshInstanceId: row.ssh_instance_id,
      actor: row.actor,
      origin: row.origin as LogCollectionRun['origin'],
      status: row.status as LogCollectionRun['status'],
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      elapsedMs: row.elapsed_ms,
      fileCount: row.file_count,
      byteCount: row.byte_count,
      files: JSON.parse(row.files_json) as LogCollectionRun['files'],
      errorCode: row.error_code,
      errorMessage: row.error_message,
    }))
  }
}
