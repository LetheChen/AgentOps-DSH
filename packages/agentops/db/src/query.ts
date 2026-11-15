/**
 * Query execution for whitelisted datasources.
 *
 * SQLite runs through `node:sqlite`, MySQL through `mysql2`, and PostgreSQL
 * through `pg`. All three are read-only from the caller's point of view: the
 * guard already rejected writes, and SQLite connections are opened read-only.
 *
 * @module @agentops/dsh-db/query
 */

import { DatabaseSync } from 'node:sqlite'

import { createConnection } from 'mysql2/promise'
import { Client as PgClient } from 'pg'

import type { DatasourceWhitelist } from './guard.ts'

/** The label and policy one query needs; both the legacy datasource and a capability instance satisfy it. */
export interface QueryPolicy {
  /** Identifier used in rendered output and error messages. */
  readonly key: string
  /** Read-only guard policy. */
  readonly whitelist: DatasourceWhitelist
}

/** Where a datasource actually lives, resolved from the capability instance or the legacy vault. */
export interface Target {
  readonly driver: 'sqlite' | 'mysql' | 'postgres'
  /** File path for sqlite, host for mysql and postgres. */
  readonly host: string
  readonly port: number | null
  readonly username: string
  readonly password: string | null
  readonly database: string | null
}

/** Rows and metadata returned by one guarded statement. */
export interface QueryResult {
  readonly columns: string[]
  readonly rows: Record<string, unknown>[]
  readonly rowCount: number
  readonly elapsedMs: number
  readonly truncated: boolean
}

/** One column of a whitelisted table. */
export interface TableColumn {
  readonly name: string
  readonly type: string
  readonly nullable: boolean
}

/** Column layout of a datasource's whitelisted tables. */
export interface SchemaDescription {
  readonly datasource: string
  readonly tables: Readonly<Record<string, readonly TableColumn[]>>
  readonly source: 'introspection' | 'unavailable'
  readonly note?: string
}

/**
 * Execute one already-guarded statement.
 * @param policy - identifier and limits for this query.
 * @param target - resolved connection target.
 * @param sql - guarded SQL.
 * @returns the rows and the execution metadata.
 */
export async function runQuery(policy: QueryPolicy, target: Target, sql: string): Promise<QueryResult> {
  const started = Date.now()
  if (target.driver === 'mysql') {
    const handle = await createConnection({
      host: target.host,
      port: target.port ?? 3306,
      user: target.username,
      password: target.password ?? '',
      ...(target.database === null ? {} : { database: target.database }),
      connectTimeout: policy.whitelist.timeoutSeconds * 1000,
      // Return DATE/DATETIME as strings: the JSON-encoded Date would shift by the
      // server timezone and read as the previous day in the transcript.
      dateStrings: true,
    })
    try {
      const [rows, fields] = await handle.query(sql)
      const list = rows as Record<string, unknown>[]
      const columns = (fields ?? []).map(field => field.name)
      return {
        columns: columns.length > 0 ? columns : (list[0] === undefined ? [] : Object.keys(list[0])),
        rows: list,
        rowCount: list.length,
        elapsedMs: Date.now() - started,
        truncated: list.length >= policy.whitelist.maxRows,
      }
    } finally {
      await handle.end().catch(() => undefined)
    }
  }

  if (target.driver === 'postgres') {
    const client = new PgClient({
      host: target.host,
      port: target.port ?? 5432,
      user: target.username,
      password: target.password ?? '',
      ...(target.database === null ? {} : { database: target.database }),
      connectionTimeoutMillis: policy.whitelist.timeoutSeconds * 1000,
    })
    await client.connect()
    try {
      const result = await client.query(sql)
      return {
        columns: result.fields.map(field => field.name),
        rows: result.rows as Record<string, unknown>[],
        rowCount: result.rows.length,
        elapsedMs: Date.now() - started,
        truncated: result.rows.length >= policy.whitelist.maxRows,
      }
    } finally {
      await client.end().catch(() => undefined)
    }
  }

  const db = new DatabaseSync(target.host, { readOnly: true })
  try {
    const rows = db.prepare(sql).all() as Record<string, unknown>[]
    return {
      columns: rows[0] === undefined ? [] : Object.keys(rows[0]),
      rows,
      rowCount: rows.length,
      elapsedMs: Date.now() - started,
      truncated: rows.length >= policy.whitelist.maxRows,
    }
  } finally {
    db.close()
  }
}

/**
 * Describe the whitelisted tables of a datasource.
 * @param policy - identifier and table policy for this datasource.
 * @param target - resolved connection target.
 * @returns the column layout, or the reason it is unavailable.
 */
export async function describeSchema(policy: QueryPolicy, target: Target): Promise<SchemaDescription> {
  if (target.driver === 'mysql') {
    const database = target.database ?? policy.whitelist.schemas[0]
    if (database === undefined) {
      return { datasource: policy.key, tables: {}, source: 'unavailable', note: '未指定默认库，无法读取字段结构' }
    }
    const allowed = policy.whitelist.tables[database] ?? []
    if (allowed.length === 0) {
      return { datasource: policy.key, tables: {}, source: 'unavailable', note: `白名单里没有 ${database} 的表` }
    }
    const handle = await createConnection({
      host: target.host,
      port: target.port ?? 3306,
      user: target.username,
      password: target.password ?? '',
      database,
      connectTimeout: policy.whitelist.timeoutSeconds * 1000,
      dateStrings: true,
    })
    try {
      const [rows] = await handle.query(
        `SELECT TABLE_NAME AS t, COLUMN_NAME AS c, DATA_TYPE AS ty, IS_NULLABLE AS n, COLUMN_COMMENT AS cm
         FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME IN (${allowed.map(() => '?').join(',')})
         ORDER BY TABLE_NAME, ORDINAL_POSITION`,
        [database, ...allowed],
      )
      const tables: Record<string, TableColumn[]> = {}
      for (const row of rows as { t: string; c: string; ty: string; n: string; cm: string | null }[]) {
        const list = tables[row.t] ?? []
        list.push({
          name: row.c,
          type: `${row.ty}${row.cm === null || row.cm === '' ? '' : ` — ${row.cm}`}`,
          nullable: row.n === 'YES',
        })
        tables[row.t] = list
      }
      return { datasource: policy.key, tables, source: 'introspection' }
    } finally {
      await handle.end().catch(() => undefined)
    }
  }

  if (target.driver === 'postgres') {
    const schema = policy.whitelist.schemas[0]
    if (schema === undefined) {
      return { datasource: policy.key, tables: {}, source: 'unavailable', note: '未指定 schema，无法读取字段结构' }
    }
    const allowed = policy.whitelist.tables[schema] ?? []
    if (allowed.length === 0) {
      return { datasource: policy.key, tables: {}, source: 'unavailable', note: `白名单里没有 ${schema} 的表` }
    }
    const client = new PgClient({
      host: target.host,
      port: target.port ?? 5432,
      user: target.username,
      password: target.password ?? '',
      ...(target.database === null ? {} : { database: target.database }),
      connectionTimeoutMillis: policy.whitelist.timeoutSeconds * 1000,
    })
    await client.connect()
    try {
      const result = await client.query(
        `SELECT table_name AS t, column_name AS c, data_type AS ty, is_nullable AS n
         FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = ANY($2::text[])
         ORDER BY table_name, ordinal_position`,
        [schema, allowed],
      )
      const tables: Record<string, TableColumn[]> = {}
      for (const row of result.rows as { t: string; c: string; ty: string; n: string }[]) {
        const list = tables[row.t] ?? []
        list.push({ name: row.c, type: row.ty, nullable: row.n === 'YES' })
        tables[row.t] = list
      }
      return { datasource: policy.key, tables, source: 'introspection' }
    } finally {
      await client.end().catch(() => undefined)
    }
  }

  const db = new DatabaseSync(target.host, { readOnly: true })
  try {
    const allowed = Object.values(policy.whitelist.tables).flat()
    const tables: Record<string, TableColumn[]> = {}
    for (const table of allowed) {
      const rows = db.prepare(`PRAGMA table_info(${table})`).all() as unknown as {
        name: string
        type: string
        notnull: number
      }[]
      tables[table] = rows.map(row => ({ name: row.name, type: row.type, nullable: row.notnull === 0 }))
    }
    return { datasource: policy.key, tables, source: 'introspection' }
  } finally {
    db.close()
  }
}
