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

const WRITE_KEYWORDS = new Set([
  'insert', 'update', 'delete', 'drop', 'alter', 'truncate', 'create', 'grant',
  'revoke', 'call', 'load_file', 'outfile', 'dumpfile', 'into', 'replace',
])
const SYSTEM_SCHEMAS = new Set(['information_schema', 'performance_schema', 'mysql', 'sys'])
const CLAUSE_KEYWORDS = new Set([
  'where', 'on', 'using', 'group', 'order', 'limit', 'having', 'union', 'join', 'inner',
  'left', 'right', 'full', 'cross', 'natural', 'straight_join', 'as', 'set', 'values',
  'window', 'for', 'lock', 'offset', 'select', 'recursive', 'into',
])
const BACKTICK = String.fromCharCode(96)

/** A lexed SQL token; comments are omitted and quoted text keeps its value without quotes. */
interface SqlToken {
  readonly type: 'identifier' | 'number' | 'string' | 'punctuation'
  readonly value: string
  readonly raw: string
}

/** Lex SQL into tokens, distinguishing quoted identifiers and string literals from code. */
function lexSql(sql: string): SqlToken[] {
  const tokens: SqlToken[] = []
  let index = 0
  while (index < sql.length) {
    const char = sql[index]
    if (char === undefined) break
    if (/\s/.test(char)) {
      index += 1
      continue
    }
    if (char === '-' && sql[index + 1] === '-') {
      while (index < sql.length && sql[index] !== '\n') index += 1
      continue
    }
    if (char === '/' && sql[index + 1] === '*') {
      const end = sql.indexOf('*/', index + 2)
      index = end === -1 ? sql.length : end + 2
      continue
    }
    if (char === "'") {
      index += 1
      while (index < sql.length && !(sql[index] === "'" && (sql[index + 1] !== "'" || sql[index + 2] === "'"))) {
        if (sql[index] === "'" && sql[index + 1] === "'") index += 2
        else index += 1
      }
      if (index < sql.length) index += 1
      continue
    }
    if (char === '"' || char === BACKTICK) {
      const quote = char
      const start = index
      index += 1
      while (index < sql.length && sql[index] !== quote) {
        if (sql[index] === quote && sql[index + 1] === quote) index += 2
        else index += 1
      }
      if (index < sql.length) index += 1
      tokens.push({ type: 'identifier', value: sql.slice(start + 1, index - 1), raw: sql.slice(start, index) })
      continue
    }
    if (/[0-9]/.test(char) || (char === '.' && /[0-9]/.test(sql[index + 1] ?? ''))) {
      const start = index
      while (index < sql.length && /[0-9.]/.test(sql[index] ?? '')) index += 1
      if ((sql[index] === 'e' || sql[index] === 'E') && /[+\-0-9]/.test(sql[index + 1] ?? '')) {
        index += 2
        while (index < sql.length && /[0-9+\-]/.test(sql[index] ?? '')) index += 1
      }
      tokens.push({ type: 'number', value: sql.slice(start, index), raw: sql.slice(start, index) })
      continue
    }
    if (/[A-Za-z_]/.test(char)) {
      const start = index
      while (index < sql.length && /[A-Za-z0-9_$]/.test(sql[index] ?? '')) index += 1
      tokens.push({ type: 'identifier', value: sql.slice(start, index), raw: sql.slice(start, index) })
      continue
    }
    tokens.push({ type: 'punctuation', value: char, raw: char })
    index += 1
  }
  return tokens
}

/** Tokens whose content is actual SQL rather than a literal or comment. */
function significantTokens(tokens: readonly SqlToken[]): SqlToken[] {
  return tokens.filter(token => token.type !== 'string')
}

/** Find the index of the parenthesis matching the one at `open`. */
function matchingParen(tokens: readonly SqlToken[], open: number): number {
  let depth = 1
  for (let index = open + 1; index < tokens.length; index += 1) {
    if (tokens[index]?.value === '(') depth += 1
    else if (tokens[index]?.value === ')') {
      depth -= 1
      if (depth === 0) return index
    }
  }
  return tokens.length - 1
}

/** Names introduced by a WITH clause, including recursive and column-listed CTEs. */
function collectCteNames(tokens: readonly SqlToken[]): Set<string> {
  const names = new Set<string>()
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token?.type !== 'identifier' || token.value.toLowerCase() !== 'with') continue
    let cursor = index + 1
    while (cursor < tokens.length) {
      const current = tokens[cursor]
      if (current?.type === 'identifier' && current.value.toLowerCase() === 'recursive') {
        cursor += 1
        continue
      }
      if (current?.type === 'punctuation' && current.value === ',') {
        cursor += 1
        continue
      }
      if (current?.type !== 'identifier') break
      names.add(current.value.toLowerCase())
      cursor += 1
      if (tokens[cursor]?.type === 'punctuation' && tokens[cursor]?.value === '(') cursor = matchingParen(tokens, cursor) + 1
      if (tokens[cursor]?.type !== 'identifier' || tokens[cursor]?.value.toLowerCase() !== 'as') break
      cursor += 1
      if (tokens[cursor]?.type === 'punctuation' && tokens[cursor]?.value === '(') cursor = matchingParen(tokens, cursor) + 1
    }
    break
  }
  return names
}

/** Whether a token is a FROM/JOIN keyword. */
function isTableClause(token: SqlToken): boolean {
  return token.type === 'identifier'
    && ['from', 'join', 'straight_join'].includes(token.value.toLowerCase())
}

/** Skip optional `AS` and collect a following alias, unless the next token starts another clause. */
function consumeAlias(tokens: readonly SqlToken[], index: number, aliases: Set<string>): number {
  let cursor = index
  if (tokens[cursor]?.type === 'identifier' && tokens[cursor]?.value.toLowerCase() === 'as') cursor += 1
  const alias = tokens[cursor]
  if (alias?.type === 'identifier' && !CLAUSE_KEYWORDS.has(alias.value.toLowerCase())) {
    aliases.add(alias.value.toLowerCase())
    cursor += 1
  }
  return cursor
}

/**
 * Validate FROM/JOIN targets at the statement's top level.
 *
 * Qualified targets are checked by the schema scan. Bare targets are allowed only for
 * CTE names and, for SQLite, whitelisted tables. Derived tables and their aliases are
 * local and are never treated as schema-qualified references.
 * @param tokens - lexed SQL tokens.
 * @param localNames - names introduced by the statement itself.
 * @param whitelist - datasource policy.
 * @returns the local aliases and the first rejection reason, if any.
 */
function checkTableTargets(
  tokens: readonly SqlToken[],
  localNames: ReadonlySet<string>,
  whitelist: DatasourceWhitelist,
): { readonly aliases: Set<string>; readonly error?: string } {
  const aliases = new Set<string>()
  let depth = 0
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token?.type === 'punctuation' && token.value === '(') {
      depth += 1
      continue
    }
    if (token?.type === 'punctuation' && token.value === ')') {
      depth -= 1
      continue
    }
    if (depth !== 0 || token === undefined || !isTableClause(token)) continue
    let cursor = index + 1
    while (cursor < tokens.length) {
      const current = tokens[cursor]
      if (current?.type === 'identifier' && CLAUSE_KEYWORDS.has(current.value.toLowerCase())) break
      if (current?.type === 'punctuation' && current.value === ',') {
        cursor += 1
        continue
      }
      if (current?.type === 'punctuation' && current.value === '(') {
        cursor = matchingParen(tokens, cursor) + 1
        cursor = consumeAlias(tokens, cursor, aliases)
        continue
      }
      if (current?.type !== 'identifier') break
      const next = tokens[cursor + 1]
      if (next?.type === 'punctuation' && next.value === '.') {
        cursor = consumeAlias(tokens, cursor + 3, aliases)
        continue
      }
      const name = current.value.toLowerCase()
      if (localNames.has(name) || isWhitelistedSqliteTable(name, whitelist)) {
        cursor = consumeAlias(tokens, cursor + 1, aliases)
        continue
      }
      return { aliases, error: `表名必须带 schema 限定：${current.raw}（可用 schema：${whitelist.schemas.join('、') || '无'}）` }
    }
  }
  return { aliases }
}

/** Whether a bare table name is in the single authorized SQLite schema allowlist. */
function isWhitelistedSqliteTable(table: string, whitelist: DatasourceWhitelist): boolean {
  if (whitelist.driver !== 'sqlite' || whitelist.schemas.length !== 1) return false
  const schema = whitelist.schemas[0]
  if (schema === undefined) return false
  return whitelist.tables[schema]?.some(allowed => allowed.toLowerCase() === table) ?? false
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

  const tokens = lexSql(trimmed)
  const code = significantTokens(tokens)
  if (code.length === 0) return { ok: false, sql: trimmed, reason: 'SQL 为空' }
  if (code.some(token => token.type === 'punctuation' && token.value === ';')) {
    return { ok: false, sql: trimmed, reason: '只允许单条语句' }
  }
  const first = code[0]
  if (first?.type !== 'identifier' || !['select', 'with'].includes(first.value.toLowerCase())) {
    return { ok: false, sql: trimmed, reason: '只允许 SELECT（或 WITH … SELECT）' }
  }

  for (let index = 0; index < code.length; index += 1) {
    const token = code[index]
    if (token?.type !== 'identifier') continue
    const lower = token.value.toLowerCase()
    if (SYSTEM_SCHEMAS.has(lower) && code[index + 1]?.type === 'punctuation' && code[index + 1]?.value === '.') {
      return { ok: false, sql: trimmed, reason: `系统库不可查询：${lower}` }
    }
    if (!WRITE_KEYWORDS.has(lower)) continue
    if (lower === 'replace' && code[index + 1]?.type === 'punctuation' && code[index + 1]?.value === '(') continue
    return { ok: false, sql: trimmed, reason: '语句包含写操作或危险关键字' }
  }

  const localNames = collectCteNames(code)
  const targetCheck = checkTableTargets(code, localNames, whitelist)
  if (targetCheck.error !== undefined) return { ok: false, sql: trimmed, reason: targetCheck.error }
  for (const alias of targetCheck.aliases) localNames.add(alias)

  for (let index = 0; index < code.length; index += 1) {
    const qualifier = code[index]
    const dot = code[index + 1]
    const table = code[index + 2]
    if (qualifier?.type !== 'identifier' || dot?.type !== 'punctuation' || dot.value !== '.' || table?.type !== 'identifier') continue
    const schema = qualifier.value.toLowerCase()
    if (schema === 'dual' || localNames.has(schema)) continue
    if (!whitelist.schemas.some(allowed => allowed.toLowerCase() === schema)) {
      return { ok: false, sql: trimmed, reason: `schema 不在白名单：${qualifier.raw}（可用：${whitelist.schemas.join('、') || '无'}）` }
    }
    const tableName = table.value.toLowerCase()
    const allowed = whitelist.tables[schema] ?? []
    if (!allowed.some(entry => entry.toLowerCase() === tableName)) {
      return { ok: false, sql: trimmed, reason: `表不在白名单：${qualifier.raw}.${table.raw}（可用：${allowed.join('、') || '无'}）` }
    }
  }

  for (const column of whitelist.deniedColumns) {
    if (code.some(token => token.type === 'identifier' && token.value.toLowerCase() === column.toLowerCase())) {
      return { ok: false, sql: trimmed, reason: `列被屏蔽：${column}` }
    }
  }

  const hasLimit = code.some(
    (token, index) => token.type === 'identifier'
      && token.value.toLowerCase() === 'limit'
      && (code[index + 1]?.type === 'number' || code[index + 1]?.type === 'identifier'),
  )
  const effective = hasLimit ? trimmed : `${trimmed} LIMIT ${whitelist.maxRows}`
  return { ok: true, sql: effective }
}

/**
 * Extract the table names a statement reads, best effort (for display only).
 * @param sql - the statement to inspect.
 * @returns the table names the statement reads.
 */
export function referencedTables(sql: string): string[] {
  const bare = sql.replace(/--[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ')
  const quoted = '[' + BACKTICK + '"][^' + BACKTICK + '"]*[' + BACKTICK + '"]'
  const bareName = '[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)?'
  const pattern = new RegExp('\\b(?:from|join)\\s+(' + quoted + '|' + bareName + ')', 'gi')
  const found = new Set<string>()
  for (const match of bare.matchAll(pattern)) {
    if (match[1] === undefined) continue
    found.add(match[1].toLowerCase())
  }
  return [...found]
}
