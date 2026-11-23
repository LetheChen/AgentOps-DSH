/**
 * Audit writes for credential operations, appended to the security domain's
 * `audit_events` table.
 *
 * Why not DSH's own logs: connection changes come from page HTTP routes, not from
 * a session or a tool call, so the session log never sees them, and DSH ships no
 * admin-audit service. The security database is the one place that is queryable
 * and retained, so it stays the source of truth; a structured logger line is
 * emitted alongside for operations.
 *
 * Secrets are never written here: only the action, the connection id, the result
 * and a short detail. A rotated password records "rotated", not its length.
 */

import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { dshHomePath } from '@deepseek-ai/dsh-home-paths'

/** Credential operations recorded in the audit log. */
export type AuditAction =
  | 'connection.create'
  | 'connection.update'
  | 'connection.secret.set'
  | 'connection.delete'
  | 'connection.test'

/** One credential operation and its outcome, without any secret material. */
export interface AuditEntry {
  readonly action: AuditAction
  readonly target: string
  readonly result: 'ok' | 'fail'
  /** Short, secret-free context, e.g. `{"driver":"mysql","elapsedMs":159}`. */
  readonly detail?: Record<string, unknown>
}

/**
 * Resolve the security database path the same way the security plugin does.
 * @returns the path of the security database holding the audit log.
 */
export function resolveSecurityDbPath(): string {
  const explicit = process.env.AGENTOPS_SECURITY_DB?.trim()
  if (explicit !== undefined && explicit.length > 0) return explicit
  return dshHomePath('agentops', 'security.db')
}

/**
 * Append one audit row. Failures are swallowed by callers: an audit hiccup must
 * not turn a successful connection save into an error response.
 * @param entry - the operation, its target, and its result.
 * @param options - the database path, the acting user, and the timestamp to record.
 */
export function appendAudit(entry: AuditEntry, options: { path?: string; actor?: string; at?: string } = {}): void {
  const path = options.path ?? resolveSecurityDbPath()
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS audit_events (
        seq    INTEGER PRIMARY KEY AUTOINCREMENT,
        actor  TEXT NOT NULL,
        action TEXT NOT NULL,
        target TEXT NOT NULL,
        at     TEXT NOT NULL,
        detail TEXT NOT NULL DEFAULT '{}'
      );
    `)
    db.prepare('INSERT INTO audit_events(actor, action, target, at, detail) VALUES (?, ?, ?, ?, ?)').run(
      options.actor ?? 'owner',
      entry.action,
      entry.target,
      options.at ?? new Date().toISOString(),
      JSON.stringify({ result: entry.result, ...(entry.detail ?? {}) }),
    )
  } finally {
    db.close()
  }
}

/**
 * Read the newest credential-related audit rows (for the page).
 * @param limit - how many rows to return.
 * @param path - the security database to read.
 * @returns the newest credential audit rows, newest first.
 */
export function listCredentialAudit(limit = 20, path = resolveSecurityDbPath()): {
  seq: number
  actor: string
  action: string
  target: string
  at: string
  detail: Record<string, unknown>
}[] {
  let db: DatabaseSync
  try {
    db = new DatabaseSync(path, { readOnly: true })
  } catch {
    // The page can load before any audited operation creates the security DB.
    return []
  }
  try {
    return (db.prepare(
      "SELECT * FROM audit_events WHERE action LIKE 'connection.%' ORDER BY seq DESC LIMIT ?",
    ).all(limit) as {
      seq: number
      actor: string
      action: string
      target: string
      at: string
      detail: string
    }[]).map(row => ({
      seq: row.seq, actor: row.actor, action: row.action, target: row.target, at: row.at,
      detail: JSON.parse(row.detail) as Record<string, unknown>,
    }))
  } catch {
    return []
  } finally {
    db.close()
  }
}
