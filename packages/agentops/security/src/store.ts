/**
 * SQLite storage for the security domain.
 *
 * Every write that changes access or grants a capability also appends an audit
 * event in the same transaction, so the trail cannot drift from the state.
 */

import { createHash } from 'node:crypto'
import { DatabaseSync, type SQLOutputValue } from 'node:sqlite'

import { summarizeUsage } from './types.ts'
import type {
  ApiToken,
  AuditEvent,
  Role,
  RoleAssignment,
  SessionRecord,
  UsageRecord,
  UsageSummary,
  User,
  UserStatus,
} from './types.ts'

const SCHEMA = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  email      TEXT,
  status     TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  metadata   TEXT NOT NULL DEFAULT '{}',
  version    INTEGER NOT NULL DEFAULT 1
);

CREATE UNIQUE INDEX IF NOT EXISTS users_email ON users(email) WHERE email IS NOT NULL;

CREATE TABLE IF NOT EXISTS roles (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  permissions TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS user_roles (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id    TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  granted_at TEXT NOT NULL,
  granted_by TEXT NOT NULL,
  PRIMARY KEY (user_id, role_id)
);

CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  agent      TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at   TEXT,
  status     TEXT NOT NULL DEFAULT 'active'
);

CREATE TABLE IF NOT EXISTS usage_records (
  id                TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL,
  session_id        TEXT,
  agent             TEXT NOT NULL,
  provider          TEXT NOT NULL DEFAULT 'unknown',
  model             TEXT NOT NULL,
  prompt_tokens     INTEGER NOT NULL,
  completion_tokens INTEGER NOT NULL,
  total_tokens      INTEGER NOT NULL,
  at                TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS usage_at ON usage_records(at);
CREATE INDEX IF NOT EXISTS usage_user ON usage_records(user_id);

CREATE TABLE IF NOT EXISTS api_tokens (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  prefix     TEXT NOT NULL,
  hash       TEXT NOT NULL,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE TABLE IF NOT EXISTS audit_events (
  seq    INTEGER PRIMARY KEY AUTOINCREMENT,
  actor  TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT NOT NULL,
  at     TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '{}'
);
`

/** SQLite storage for users, roles, sessions, token usage, and the audit trail. */
export class SecurityStore {
  readonly #db: DatabaseSync

  constructor(path: string) {
    this.#db = new DatabaseSync(path)
    this.#db.exec(SCHEMA)
    // Older security.db files predate the version column; add it in place.
    const columns = this.#db.prepare('PRAGMA table_info(users)').all() as { name: string }[]
    if (!columns.some(column => column.name === 'version')) {
      this.#db.exec('ALTER TABLE users ADD COLUMN version INTEGER NOT NULL DEFAULT 1')
    }
    const usageColumns = this.#db.prepare('PRAGMA table_info(usage_records)').all() as { name: string }[]
    if (!usageColumns.some(column => column.name === 'session_id')) {
      this.#db.exec('ALTER TABLE usage_records ADD COLUMN session_id TEXT')
    }
    if (!usageColumns.some(column => column.name === 'provider')) {
      this.#db.exec("ALTER TABLE usage_records ADD COLUMN provider TEXT NOT NULL DEFAULT 'unknown'")
    }
  }

  /** Close the database handle. */
  close(): void {
    this.#db.close()
  }

  /**
   * Create a user and audit the write.
   * @param input - the user identity, name, optional email and metadata, and the acting user.
   * @returns the created user.
   */
  createUser(input: {
    id: string
    name: string
    email?: string
    actor: string
    now?: string
    metadata?: Record<string, unknown>
  }): User {
    const now = input.now ?? new Date().toISOString()
    this.#db.exec('BEGIN')
    try {
      this.#db.prepare(`
        INSERT INTO users(id, name, email, status, created_at, metadata)
        VALUES (?, ?, ?, 'active', ?, ?)
      `).run(input.id, input.name, input.email ?? null, now, JSON.stringify(input.metadata ?? {}))
      this.#audit(input.actor, 'user.create', input.id, now, { name: input.name })
      this.#db.exec('COMMIT')
    } catch (error) {
      this.#db.exec('ROLLBACK')
      throw error
    }
    const user = this.getUser(input.id)
    if (user === null) throw new Error(`user ${input.id} missing after write`)
    return user
  }

  /**
   * Read one user, or null when it does not exist.
   * @param id - the user id.
   * @returns the user, or null when it does not exist.
   */
  getUser(id: string): User | null {
    const row = this.#db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined
    return row === undefined ? null : toUser(row)
  }

  /**
   * List users, optionally filtered by status.
   * @param filter - the optional status filter.
   * @returns the matching users, oldest first.
   */
  listUsers(filter: { status?: UserStatus } = {}): User[] {
    const rows = filter.status === undefined
      ? this.#db.prepare('SELECT * FROM users ORDER BY created_at').all()
      : this.#db.prepare('SELECT * FROM users WHERE status = ? ORDER BY created_at').all(filter.status)
    return (rows as UserRow[]).map(toUser)
  }

  /**
   * Disable or re-enable a user; every change is audited and version-checked.
   * @param input - the new status, the acting user, and the version the caller based the change on.
   * @returns the updated user.
   */
  setUserStatus(input: {
    id: string
    status: UserStatus
    actor: string
    expectedVersion: number
    now?: string
  }): User {
    const now = input.now ?? new Date().toISOString()
    const current = this.getUser(input.id)
    if (current === null) throw new Error(`user not found: ${input.id}`)
    if (current.version !== input.expectedVersion) {
      throw new Error(`version conflict: expected ${input.expectedVersion}, current ${current.version}`)
    }
    this.#db.exec('BEGIN')
    try {
      this.#db.prepare('UPDATE users SET status = ?, version = version + 1 WHERE id = ?')
        .run(input.status, input.id)
      this.#audit(input.actor, 'user.status', input.id, now, { from: current.status, to: input.status })
      this.#db.exec('COMMIT')
    } catch (error) {
      this.#db.exec('ROLLBACK')
      throw error
    }
    const user = this.getUser(input.id)
    if (user === null) throw new Error(`user ${input.id} missing after write`)
    return user
  }

  /**
   * Create a role and audit the write.
   * @param input - the role identity, permissions, and acting user.
   * @returns the created role.
   */
  createRole(input: { id: string; name: string; description?: string; permissions?: string[]; actor: string; now?: string }): Role {
    const now = input.now ?? new Date().toISOString()
    this.#db.exec('BEGIN')
    try {
      this.#db.prepare('INSERT INTO roles(id, name, description, permissions) VALUES (?, ?, ?, ?)')
        .run(input.id, input.name, input.description ?? '', JSON.stringify(input.permissions ?? []))
      this.#audit(input.actor, 'role.create', input.id, now, { permissions: input.permissions ?? [] })
      this.#db.exec('COMMIT')
    } catch (error) {
      this.#db.exec('ROLLBACK')
      throw error
    }
    const role = this.getRole(input.id)
    if (role === null) throw new Error(`role ${input.id} missing after create`)
    return role
  }

  /**
   * Read one role, or null when it does not exist.
   * @param id - the role id.
   * @returns the role, or null when it does not exist.
   */
  getRole(id: string): Role | null {
    const row = this.#db.prepare('SELECT * FROM roles WHERE id = ?').get(id) as RoleRow | undefined
    return row === undefined ? null : toRole(row)
  }

  /**
   * List every role.
   * @returns every stored role, ordered by id.
   */
  listRoles(): Role[] {
    return (this.#db.prepare('SELECT * FROM roles ORDER BY id').all() as RoleRow[]).map(toRole)
  }

  /**
   * Grant a role to a user and audit the write.
   * @param input - the user, role, granting user, and timestamp.
   * @returns the recorded assignment.
   */
  assignRole(input: { userId: string; roleId: string; grantedBy: string; now?: string }): RoleAssignment {
    const now = input.now ?? new Date().toISOString()
    this.#db.exec('BEGIN')
    try {
      this.#db.prepare(`
        INSERT INTO user_roles(user_id, role_id, granted_at, granted_by) VALUES (?, ?, ?, ?)
        ON CONFLICT(user_id, role_id) DO NOTHING
      `).run(input.userId, input.roleId, now, input.grantedBy)
      this.#audit(input.grantedBy, 'role.assign', `${input.userId}:${input.roleId}`, now, {})
      this.#db.exec('COMMIT')
    } catch (error) {
      this.#db.exec('ROLLBACK')
      throw error
    }
    return { userId: input.userId, roleId: input.roleId, grantedAt: now, grantedBy: input.grantedBy }
  }

  /**
   * List the roles granted to one user.
   * @param userId - the user whose grants are read.
   * @returns the user's role assignments.
   */
  listAssignments(userId: string): RoleAssignment[] {
    return (this.#db.prepare('SELECT * FROM user_roles WHERE user_id = ? ORDER BY granted_at').all(userId) as {
      user_id: string
      role_id: string
      granted_at: string
      granted_by: string
    }[]).map(row => ({
      userId: row.user_id, roleId: row.role_id, grantedAt: row.granted_at, grantedBy: row.granted_by,
    }))
  }

  /**
   * Effective permission ids for a user, de-duplicated.
   * @param userId - the user whose permissions are resolved.
   * @returns the effective permission ids, de-duplicated and sorted.
   */
  permissionsOf(userId: string): string[] {
    const rows = this.#db.prepare(`
      SELECT r.permissions AS permissions FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = ?
    `).all(userId) as { permissions: string }[]
    const set = new Set<string>()
    for (const row of rows) {
      for (const permission of JSON.parse(row.permissions) as string[]) set.add(permission)
    }
    return [...set].sort()
  }

  /**
   * Record one model call and its token usage.
   * @param input - the call identity, model, agent, and token counts.
   * @returns the stored usage record.
   */
  recordUsage(input: Omit<UsageRecord, 'totalTokens' | 'provider'> & { totalTokens?: number; provider?: string }): UsageRecord {
    const total = input.totalTokens ?? input.promptTokens + input.completionTokens
    const provider = input.provider?.trim() || 'unknown'
    this.#db.prepare(`
      INSERT INTO usage_records(id, user_id, session_id, agent, provider, model, prompt_tokens, completion_tokens, total_tokens, at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.id, input.userId, input.sessionId ?? null, input.agent, provider, input.model,
      input.promptTokens, input.completionTokens, total, input.at,
    )
    return { ...input, provider, totalTokens: total }
  }

  /**
   * Most recent calls, for the monitor page's activity list.
   * @param limit - how many calls to return.
   * @returns the most recent calls, newest first.
   */
  recentUsage(limit = 20): UsageRecord[] {
    return (this.#db.prepare('SELECT * FROM usage_records ORDER BY at DESC LIMIT ?').all(limit) as UsageRow[])
      .map(toUsage)
  }

  /**
   * Token usage aggregated since a timestamp.
   * @param since - the earliest timestamp to include.
   * @returns the aggregated usage summary.
   */
  usage(since?: string): UsageSummary {
    return summarizeUsage(this.usageRecords(since))
  }

  /**
   * Usage rows ordered oldest-first, optionally restricted to an inclusive UTC instant.
   * @param since - the earliest timestamp to include.
   * @returns the raw usage rows since that timestamp.
   */
  usageRecords(since?: string): UsageRecord[] {
    const rows = (since === undefined
      ? this.#db.prepare('SELECT * FROM usage_records ORDER BY at').all()
      : this.#db.prepare('SELECT * FROM usage_records WHERE datetime(at) >= datetime(?) ORDER BY at').all(since)) as UsageRow[]
    return rows.map(toUsage)
  }

  /**
   * List the recorded usage sessions.
   * @param userId - the optional user filter.
   * @returns the matching sessions, newest first.
   */
  listSessions(userId?: string): SessionRecord[] {
    const rows = (userId === undefined
      ? this.#db.prepare('SELECT * FROM sessions ORDER BY started_at DESC').all()
      : this.#db.prepare('SELECT * FROM sessions WHERE user_id = ? ORDER BY started_at DESC').all(userId)) as SessionRow[]
    return rows.map(toSession)
  }

  /**
   * Record the start of a usage session.
   * @param input - the session identity, user, and agent.
   * @returns the started session.
   */
  startSession(input: { id: string; userId: string; agent: string; now?: string }): SessionRecord {
    const now = input.now ?? new Date().toISOString()
    this.#db.prepare('INSERT INTO sessions(id, user_id, agent, started_at, status) VALUES (?, ?, ?, ?, \'active\')')
      .run(input.id, input.userId, input.agent, now)
    const session = this.listSessions(input.userId).find(candidate => candidate.id === input.id)
    if (session === undefined) throw new Error(`session ${input.id} missing after start`)
    return session
  }

  /**
   * Record the end of a usage session.
   * @param input - the session id, acting user, and timestamp.
   */
  endSession(input: { id: string; actor: string; now?: string }): void {
    const now = input.now ?? new Date().toISOString()
    this.#db.exec('BEGIN')
    try {
      this.#db.prepare("UPDATE sessions SET ended_at = ?, status = 'ended' WHERE id = ?").run(now, input.id)
      this.#audit(input.actor, 'session.end', input.id, now, {})
      this.#db.exec('COMMIT')
    } catch (error) {
      this.#db.exec('ROLLBACK')
      throw error
    }
  }

  /**
   * Mint a token. Only a hash and a short prefix are stored; the plaintext is
   * returned once and can never be read back.
   * @param input - the token identity, its owner, and the acting user.
   * @returns the issued token, carrying only its prefix.
   */
  createToken(input: { id: string; userId: string; name: string; secret: string; actor: string; now?: string }): ApiToken {
    const now = input.now ?? new Date().toISOString()
    const hash = createHash('sha256').update(input.secret).digest('hex')
    const prefix = input.secret.slice(0, 8)
    this.#db.exec('BEGIN')
    try {
      this.#db.prepare(`
        INSERT INTO api_tokens(id, user_id, name, prefix, hash, created_at) VALUES (?, ?, ?, ?, ?, ?)
      `).run(input.id, input.userId, input.name, prefix, hash, now)
      this.#audit(input.actor, 'token.create', input.id, now, { userId: input.userId, prefix })
      this.#db.exec('COMMIT')
    } catch (error) {
      this.#db.exec('ROLLBACK')
      throw error
    }
    return { id: input.id, userId: input.userId, name: input.name, prefix, createdAt: now, revokedAt: null }
  }

  /**
   * List issued tokens, optionally for one user.
   * @param userId - the optional user filter.
   * @returns the matching tokens, newest first.
   */
  listTokens(userId?: string): ApiToken[] {
    const rows = (userId === undefined
      ? this.#db.prepare('SELECT * FROM api_tokens ORDER BY created_at DESC').all()
      : this.#db.prepare('SELECT * FROM api_tokens WHERE user_id = ? ORDER BY created_at DESC').all(userId)) as TokenRow[]
    return rows.map(toToken)
  }

  /**
   * Verify a presented token by hash; revoked tokens never match.
   * @param secret - the token value presented by the caller.
   * @returns the matching token, or null when it is unknown or revoked.
   */
  verifyToken(secret: string): ApiToken | null {
    const hash = createHash('sha256').update(secret).digest('hex')
    const row = this.#db.prepare('SELECT * FROM api_tokens WHERE hash = ? AND revoked_at IS NULL')
      .get(hash) as TokenRow | undefined
    return row === undefined ? null : toToken(row)
  }

  /**
   * Revoke a token and audit the write.
   * @param input - the token id, acting user, and timestamp.
   */
  revokeToken(input: { id: string; actor: string; now?: string }): void {
    const now = input.now ?? new Date().toISOString()
    this.#db.exec('BEGIN')
    try {
      this.#db.prepare('UPDATE api_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(now, input.id)
      this.#audit(input.actor, 'token.revoke', input.id, now, {})
      this.#db.exec('COMMIT')
    } catch (error) {
      this.#db.exec('ROLLBACK')
      throw error
    }
  }

  /**
   * List the audit trail, newest first.
   * @param limit - how many events to return.
   * @returns the newest audit events.
   */
  listAudit(limit = 100): AuditEvent[] {
    return (this.#db.prepare('SELECT * FROM audit_events ORDER BY seq DESC LIMIT ?').all(limit) as AuditRow[])
      .map(row => ({
        seq: row.seq, actor: row.actor, action: row.action, target: row.target, at: row.at,
        detail: JSON.parse(row.detail) as Record<string, unknown>,
      }))
  }

  /**
   * Manual audit append, used by write guardrails in other packages.
   * @param event - the actor, action, and target of the audited operation.
   */
  recordAudit(event: { actor: string; action: string; target: string; at?: string; detail?: Record<string, unknown> }): void {
    this.#audit(event.actor, event.action, event.target, event.at ?? new Date().toISOString(), event.detail ?? {})
  }

  #audit(actor: string, action: string, target: string, at: string, detail: Record<string, unknown>): void {
    this.#db.prepare('INSERT INTO audit_events(actor, action, target, at, detail) VALUES (?, ?, ?, ?, ?)')
      .run(actor, action, target, at, JSON.stringify(detail))
  }
}

interface UserRow extends Record<string, SQLOutputValue> {
  id: string
  name: string
  email: string | null
  status: string
  created_at: string
  metadata: string
  version: number
}
interface RoleRow extends Record<string, SQLOutputValue> {
  id: string
  name: string
  description: string
  permissions: string
}
interface SessionRow extends Record<string, SQLOutputValue> {
  id: string
  user_id: string
  agent: string
  started_at: string
  ended_at: string | null
  status: string
}
interface UsageRow extends Record<string, SQLOutputValue> {
  id: string
  user_id: string
  session_id: string | null
  agent: string
  provider: string
  model: string
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
  at: string
}
interface TokenRow extends Record<string, SQLOutputValue> {
  id: string
  user_id: string
  name: string
  prefix: string
  hash: string
  created_at: string
  revoked_at: string | null
}

function toToken(row: TokenRow): ApiToken {
  return {
    id: row.id, userId: row.user_id, name: row.name, prefix: row.prefix,
    createdAt: row.created_at, revokedAt: row.revoked_at,
  }
}

interface AuditRow extends Record<string, SQLOutputValue> {
  seq: number
  actor: string
  action: string
  target: string
  at: string
  detail: string
}

function toUser(row: UserRow): User {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    status: row.status === 'disabled' ? 'disabled' : 'active',
    createdAt: row.created_at,
    version: row.version,
    metadata: JSON.parse(row.metadata) as Record<string, unknown>,
  }
}

function toRole(row: RoleRow): Role {
  return {
    id: row.id, name: row.name, description: row.description,
    permissions: JSON.parse(row.permissions) as string[],
  }
}

function toSession(row: SessionRow): SessionRecord {
  return {
    id: row.id, userId: row.user_id, agent: row.agent,
    startedAt: row.started_at, endedAt: row.ended_at,
    status: row.status === 'ended' ? 'ended' : 'active',
  }
}

function toUsage(row: UsageRow): UsageRecord {
  return {
    id: row.id, userId: row.user_id,
    ...(row.session_id === null ? {} : { sessionId: row.session_id }),
    agent: row.agent, provider: row.provider, model: row.model,
    promptTokens: row.prompt_tokens, completionTokens: row.completion_tokens,
    totalTokens: row.total_tokens, at: row.at,
  }
}
