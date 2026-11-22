/**
 * Connection registry: metadata in SQLite, secrets sealed in a separate column.
 *
 * Reads never return the cipher; callers ask for a secret explicitly and get a
 * throwaway string for the current operation.
 */

import { DatabaseSync } from 'node:sqlite'

import { loadMasterKey, openSecret, sealSecret, secretAad, type MasterKey } from './crypto.ts'

/** The kinds of connection the vault stores. */
export type ConnectionKind = 'database' | 'server'

/** Fields accepted when creating or updating a connection. */
export interface ConnectionInput {
  readonly id: string
  readonly kind: ConnectionKind
  readonly name: string
  /** `mysql` / `sqlite` for databases, `ssh` for servers. */
  readonly driver: string
  readonly host: string
  readonly port: number | null
  readonly username: string
  readonly defaultDatabase: string | null
  readonly enabled: boolean
  /** Present only when the caller wants to set/rotate the password. */
  readonly password?: string
}

/** A connection as the page sees it, without the sealed secret. */
export interface ConnectionView {
  readonly id: string
  readonly kind: ConnectionKind
  readonly name: string
  readonly driver: string
  readonly host: string
  readonly port: number | null
  readonly username: string
  readonly defaultDatabase: string | null
  readonly enabled: boolean
  readonly hasSecret: boolean
  readonly secretUpdatedAt: string | null
  readonly lastTestAt: string | null
  readonly lastTestOk: boolean | null
  readonly lastTestError: string | null
  readonly createdAt: string
  readonly updatedAt: string
}

interface Row {
  id: string
  kind: string
  name: string
  driver: string
  host: string
  port: number | null
  username: string
  default_database: string | null
  enabled: number
  secret_cipher: string | null
  secret_updated_at: string | null
  last_test_at: string | null
  last_test_ok: number | null
  last_test_error: string | null
  created_at: string
  updated_at: string
}

/** Strip the cipher before anything leaves the store. */
function toView(row: Row): ConnectionView {
  return {
    id: row.id,
    kind: row.kind === 'server' ? 'server' : 'database',
    name: row.name,
    driver: row.driver,
    host: row.host,
    port: row.port,
    username: row.username,
    defaultDatabase: row.default_database,
    enabled: row.enabled === 1,
    hasSecret: row.secret_cipher !== null,
    secretUpdatedAt: row.secret_updated_at,
    lastTestAt: row.last_test_at,
    lastTestOk: row.last_test_ok === null ? null : row.last_test_ok === 1,
    lastTestError: row.last_test_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/** SQLite-backed store of connection metadata and sealed secrets. */
export class ConnectionStore {
  readonly #db: DatabaseSync
  readonly #key: MasterKey

  constructor(path: string, key: MasterKey = loadMasterKey()) {
    this.#db = new DatabaseSync(path)
    this.#key = key
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS connections (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        name TEXT NOT NULL,
        driver TEXT NOT NULL,
        host TEXT NOT NULL,
        port INTEGER,
        username TEXT NOT NULL DEFAULT '',
        default_database TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        secret_cipher TEXT,
        secret_updated_at TEXT,
        last_test_at TEXT,
        last_test_ok INTEGER,
        last_test_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `)
  }

  /** Close the underlying database. */
  close(): void {
    this.#db.close()
  }

  /**
   * List stored connections.
   * @param kind - restrict the result to one connection kind.
   * @returns the matching connections, ordered by kind and name.
   */
  list(kind?: ConnectionKind): ConnectionView[] {
    const rows = (kind === undefined
      ? this.#db.prepare('SELECT * FROM connections ORDER BY kind, name').all()
      : this.#db.prepare('SELECT * FROM connections WHERE kind = ? ORDER BY name').all(kind)) as unknown as Row[]
    return rows.map(toView)
  }

  /**
   * Read one connection.
   * @param id - the connection id.
   * @returns the connection, or null when it does not exist.
   */
  get(id: string): ConnectionView | null {
    const row = this.#db.prepare('SELECT * FROM connections WHERE id = ?').get(id) as unknown as Row | undefined
    return row === undefined ? null : toView(row)
  }

  /**
   * Create or update one connection. A provided password is sealed; omitting it
   * keeps the stored one (the "leave blank to keep" rule from the UI).
   * @param input - the connection fields to write.
   * @param now - the timestamp recorded as the change time.
   * @returns the stored connection as the page sees it.
   */
  upsert(input: ConnectionInput, now: string = new Date().toISOString()): ConnectionView {
    const existing = this.get(input.id)
    if (existing === null) {
      this.#db.prepare(`
        INSERT INTO connections (id, kind, name, driver, host, port, username, default_database, enabled, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.id, input.kind, input.name, input.driver, input.host,
        input.port, input.username, input.defaultDatabase, input.enabled ? 1 : 0, now, now,
      )
    } else {
      if (existing.kind !== input.kind) throw new Error('连接类型创建后不可修改')
      this.#db.prepare(`
        UPDATE connections SET name = ?, driver = ?, host = ?, port = ?, username = ?,
          default_database = ?, enabled = ?, updated_at = ? WHERE id = ?
      `).run(
        input.name, input.driver, input.host, input.port, input.username,
        input.defaultDatabase, input.enabled ? 1 : 0, now, input.id,
      )
    }
    if (input.password !== undefined && input.password.length > 0) {
      const sealed = sealSecret(this.#key.key, input.password, secretAad(input.kind, input.id))
      this.#db.prepare('UPDATE connections SET secret_cipher = ?, secret_updated_at = ? WHERE id = ?')
        .run(sealed, now, input.id)
    }
    const saved = this.get(input.id)
    if (saved === null) throw new Error('connection disappeared during upsert')
    return saved
  }

  /**
   * Decrypt one connection's password for the current operation.
   * @param id - the connection id.
   * @returns the decrypted password, or null when the connection has none.
   */
  readSecret(id: string): string | null {
    const row = this.#db.prepare('SELECT kind, secret_cipher FROM connections WHERE id = ?')
      .get(id) as unknown as { kind: string; secret_cipher: string | null } | undefined
    if (row === undefined || row.secret_cipher === null) return null
    return openSecret(this.#key.key, row.secret_cipher, secretAad(row.kind, id))
  }

  /**
   * Delete one connection.
   * @param id - the connection id.
   * @returns whether a connection was deleted.
   */
  remove(id: string): boolean {
    const result = this.#db.prepare('DELETE FROM connections WHERE id = ?').run(id)
    return Number(result.changes) > 0
  }

  /**
   * Record the outcome of a connection test.
   * @param id - the connection id.
   * @param ok - whether the test succeeded.
   * @param error - the failure reason, or null when the test succeeded.
   * @param now - the timestamp of the test.
   */
  recordTest(id: string, ok: boolean, error: string | null, now: string = new Date().toISOString()): void {
    this.#db.prepare('UPDATE connections SET last_test_at = ?, last_test_ok = ?, last_test_error = ? WHERE id = ?')
      .run(now, ok ? 1 : 0, error, id)
  }
}
