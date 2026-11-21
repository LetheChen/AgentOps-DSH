/**
 * Read-only SQL guard.
 *
 * The legacy `tools/sql_validator.py` was the security boundary for text-to-SQL:
 * single read-only statement, schema/table whitelist, denied columns, forced
 * LIMIT. This module keeps those rules and drops the parts that depended on the
 * old session identity (row filters), which DSH tools cannot see.
 */

export interface DatasourceWhitelist {
  /** Schemas a query may touch. */
  readonly schemas: readonly string[]
  /** Allowed tables per schema. */
  readonly tables: Readonly<Record<string, readonly string[]>>
  /** Column-name patterns that must never be selected. */
  readonly deniedColumns: readonly string[]
  /** Rows a single query may return. */
  readonly maxRows: number
  /** Query timeout in seconds. */
  readonly timeoutSeconds: number
  /** Driver of the resolved datasource; only SQLite allows whitelisted bare table names. */
  readonly driver?: 'sqlite' | 'mysql' | 'postgres'
}

/** Outcome of the read-only SQL check. */
export interface GuardResult {
  readonly ok: boolean
  /** SQL actually executed (with the LIMIT that was injected, if any). */
  readonly sql: string
  /** Why the query was refused. */
  readonly reason?: string
}

const WRITE_VERBS = [
  'insert', 'update', 'delete', 'drop', 'alter', 'truncate', 'create', 'replace',
  'grant', 'revoke', 'call', 'load_file', 'into\\s+outfile', 'into\\s+dumpfile',
]
const WRITE_PATTERN = new RegExp(`\\b(?:${WRITE_VERBS.join('|')})\\b`, 'i')
const MULTI_STATEMENT = /;\s*\S/

/** Words that may appear inside string literals or comments but not as statements. */
function stripLiteralsAndComments(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/"(?:[^"]|"")*"/g, '""')
}

/**
 * Validate one SQL statement against a datasource whitelist.
 * @param sql - raw SQL from the model.
 * @param whitelist - datasource policy.
 * @returns the check outcome, with the SQL that may be executed.
 */
export function guardSql(sql: string, whitelist: DatasourceWhitelist): GuardResult {
  const trimmed = sql.trim().replace(/;+$/, '')
  if (trimmed.length === 0) return { ok: false, sql: trimmed, reason: 'SQL 为空' }
  if (MULTI_STATEMENT.test(trimmed)) return { ok: false, sql: trimmed, reason: '只允许单条语句' }

  const bare = stripLiteralsAndComments(trimmed)
  if (!/^\s*(select|with)\b/i.test(bare)) {
    return { ok: false, sql: trimmed, reason: '只允许 SELECT（或 WITH … SELECT）' }
  }
  if (WRITE_PATTERN.test(bare)) {
    return { ok: false, sql: trimmed, reason: '语句包含写操作或危险关键字' }
  }

  const lowered = bare.toLowerCase()
  // System schemas are never queryable from the model side, even though
  // information_schema is what the server uses internally to describe tables.
  for (const blocked of ['information_schema', 'performance_schema', 'mysql.', 'sys.']) {
    if (lowered.includes(blocked)) {
      return { ok: false, sql: trimmed, reason: `系统库不可查询：${blocked.replace('.', '')}` }
    }
  }
  // `x.y` is a schema-qualified table only when `x` is not a name this
  // statement itself introduced. Table aliases and CTE names produce the same
  // `alias.column` shape, so they are collected first and skipped; otherwise a
  // perfectly ordinary `FROM audit_records r WHERE r.status = …` reads as
  // "schema r is not whitelisted".
  const localNames = collectLocalNames(bare)
  const unqualified = rejectUnqualifiedTableReference(bare, localNames, whitelist)
  if (unqualified !== undefined) return { ok: false, sql: trimmed, reason: unqualified }
  // The qualifier must start like an identifier: `100.0` is a decimal literal,
  // not a schema-qualified table, and rejecting it blocks ordinary arithmetic.
  for (const match of bare.matchAll(/\b([a-z_][a-z0-9_]*)\.[a-z0-9_]+/gi)) {
    const qualifier = (match[1] ?? '').toLowerCase()
    if (qualifier === 'dual') continue
    if (localNames.has(qualifier)) continue
    if (!whitelist.schemas.some(allowed => allowed.toLowerCase() === qualifier)) {
      return { ok: false, sql: trimmed, reason: `schema 不在白名单：${qualifier}` }
    }
  }
  for (const schema of whitelist.schemas) {
    if (lowered.includes(`${schema.toLowerCase()}.`)) {
      const tables = whitelist.tables[schema] ?? []
      // Every qualified reference must point at an allowed table.
      const pattern = new RegExp(`${schema}\\.([a-z0-9_]+)`, 'gi')
      for (const match of bare.matchAll(pattern)) {
        const table = match[1]?.toLowerCase()
        if (table === undefined) continue
        if (!tables.some(allowed => allowed.toLowerCase() === table)) {
          return { ok: false, sql: trimmed, reason: `表不在白名单：${schema}.${table}` }
        }
      }
    }
  }
  for (const column of whitelist.deniedColumns) {
    if (new RegExp(`\\b${column}\\b`, 'i').test(bare)) {
      return { ok: false, sql: trimmed, reason: `列被屏蔽：${column}` }
    }
  }

  const hasLimit = /\blimit\s+(\d+|\?|:\w+)\s*$/i.test(bare)
  const effective = hasLimit ? trimmed : `${trimmed} LIMIT ${whitelist.maxRows}`
  return { ok: true, sql: effective }
}

/**
 * Names a statement introduces for itself: CTE names, table aliases, and
 * derived-table aliases.
 *
 * A qualifier that matches one of these is a column reference, not a schema, so
 * the whitelist check must skip it. The scan stays lexical — the guard never
 * parses SQL — which is why keyword-shaped aliases are filtered out rather than
 * resolved.
 * @param bare - statement text with literals and comments removed.
 * @returns lower-cased local names.
 */
function collectLocalNames(bare: string): Set<string> {
  const names = new Set<string>()
  // WITH name AS ( … ), name2 AS ( … )
  for (const match of bare.matchAll(/\b(?:with|,)\s+([a-z0-9_]+)\s+as\s*\(/gi)) {
    names.add((match[1] ?? '').toLowerCase())
  }
  // FROM/JOIN target [AS] alias
  for (const match of bare.matchAll(/\b(?:from|join)\s+([a-z0-9_.`]+)\s+(?:as\s+)?([a-z0-9_]+)/gi)) {
    const alias = (match[2] ?? '').toLowerCase()
    if (!CLAUSE_KEYWORDS.has(alias)) names.add(alias)
  }
  // Derived table: `FROM ( … ) AS alias`
  for (const match of bare.matchAll(DERIVED_TABLE_ALIAS)) {
    const alias = (match[1] ?? '').toLowerCase()
    if (!CLAUSE_KEYWORDS.has(alias)) names.add(alias)
  }
  return names
}

/**
 * Reject a bare table name in a FROM/JOIN target.
 *
 * A bare name can resolve to any table in the connected database's default
 * schema, so it must not bypass the schema-qualified table allowlist. CTE
 * names and derived-table aliases are local names and are allowed to remain
 * unqualified because they do not resolve to a database table.
 *
 * @param bare - statement text with literals and comments removed.
 * @param localNames - names introduced by the statement itself.
 * @returns the rejection reason, or undefined when all targets are qualified.
 */
function rejectUnqualifiedTableReference(
  bare: string,
  localNames: ReadonlySet<string>,
  whitelist: DatasourceWhitelist,
): string | undefined {
  const pattern = /\b(?:from|join)\s+(`[^`]*`|"[^"]*"|'[^']*'|[a-z_][a-z0-9_]*(?:\.[a-z0-9_]+)?)/gi
  for (const match of bare.matchAll(pattern)) {
    const target = (match[1] ?? '').replace(/^[`"']+|[`"']+$/g, '').toLowerCase()
    if (target.includes('.')) continue
    if (target === 'dual' || localNames.has(target)) continue
    if (isWhitelistedSqliteTable(target, whitelist)) continue
    return `表名必须带 schema 限定：${match[1]}`
  }
  return undefined
}

/**
 * Whether a bare SQLite table name is in the single authorized schema allowlist.
 *
 * @param table - lower-cased table name without quotes.
 * @param whitelist - datasource policy.
 * @returns whether the table is authorized.
 */
function isWhitelistedSqliteTable(table: string, whitelist: DatasourceWhitelist): boolean {
  if (whitelist.driver !== 'sqlite' || whitelist.schemas.length !== 1) return false
  const schema = whitelist.schemas[0]
  if (schema === undefined) return false
  return whitelist.tables[schema]?.some(allowed => allowed.toLowerCase() === table) ?? false
}

/** Words that follow a table reference but are never aliases. */
const CLAUSE_KEYWORDS = new Set([
  'where', 'on', 'using', 'group', 'order', 'limit', 'having', 'union', 'join', 'inner',
  'left', 'right', 'full', 'cross', 'natural', 'straight_join', 'as', 'set', 'values',
  'window', 'for', 'lock', 'offset', 'select',
])

/**
 * Alias of a derived table, matched only where a clause keyword, a comma, a
 * closing parenthesis, or the end of the statement follows — the shapes that can
 * legally follow `FROM ( … ) alias`.
 */
const DERIVED_TABLE_ALIAS
  = /\)\s*(?:as\s+)?([a-z0-9_]+)(?=\s+(?:where|on|group|order|having|limit|union|join|inner|left|right|cross)\b|\s*[,)]|\s*$)/gi

/**
 * Extract the table names a statement reads, best effort (for display only).
 * @param sql - the statement to inspect.
 * @returns the table names the statement reads.
 */
export function referencedTables(sql: string): string[] {
  const bare = stripLiteralsAndComments(sql)
  const found = new Set<string>()
  for (const match of bare.matchAll(/\bfrom\s+([a-z0-9_.]+)/gi)) if (match[1] !== undefined) found.add(match[1].toLowerCase())
  for (const match of bare.matchAll(/\bjoin\s+([a-z0-9_.]+)/gi)) if (match[1] !== undefined) found.add(match[1].toLowerCase())
  return [...found]
}
