/**
 * Read-only data-query tools.
 *
 * Two tools only: `sql_query` (guarded SELECT) and `describe_database` (schema
 * for whitelisted tables). Credentials never appear in arguments: one resolver
 * decides which database instance the executing Agent may query, and the guard
 * and the query body both read that single resolved record.
 *
 * @module @agentops/dsh-db/tools
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

import type { DatabaseResolver } from './instances.ts'
import { agentPresetOf } from './instances.ts'
import { describeSchema, runQuery } from './query.ts'
import { guardSql, referencedTables, type DatasourceWhitelist } from './guard.ts'

interface QueryTable {
  readonly columns: readonly string[]
  readonly rows: readonly Record<string, unknown>[]
  readonly rowCount: number
  readonly elapsedMs: number
  readonly executedSql: string
  /** SQL with the real schema replaced by a display placeholder for final answers. */
  readonly displaySql: string
}

interface SchemaPayload {
  readonly datasource: string
  readonly displayName: string
  readonly schema: string
  readonly maxRows: number
  readonly tables: Readonly<Record<string, readonly { name: string; type: string; nullable: boolean }[]>>
}

const MAX_RENDERED_ROWS = 50
const MAX_CELL_CHARS = 120

/** Placeholder used for real schema names in model-visible and final-answer SQL. */
const DISPLAY_SCHEMA = '<业务库>'

/** Escape a schema name for use in a regular expression. */
function escapeRegExp(value: string): string {
  let result = ''
  for (const char of value) {
    if ('\\^$.|?*+()[]{}'.includes(char)) result += '\\'
    result += char
  }
  return result
}

/**
 * Replace every whitelisted schema prefix with a display placeholder.
 * @param sql - SQL that may contain schema-qualified table references.
 * @param whitelist - the datasource policy used for the query.
 * @returns SQL safe for model-visible and final-answer output.
 */
function toDisplaySql(sql: string, whitelist: DatasourceWhitelist): string {
  let result = sql
  for (const schema of whitelist.schemas) {
    if (schema === '') continue
    result = result.replace(new RegExp('\\b' + escapeRegExp(schema) + '\\.', 'gi'), DISPLAY_SCHEMA + '.')
  }
  return result
}

function cell(value: unknown): string {
  if (value === null || value === undefined) return 'NULL'
  const text = typeof value === 'string'
    ? value
    : typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint'
      ? String(value)
      : typeof value === 'symbol'
        ? value.toString()
        : typeof value === 'function'
          ? `[function ${value.name === '' ? 'anonymous' : value.name}]`
          : JSON.stringify(value)
  return text.length > MAX_CELL_CHARS ? `${text.slice(0, MAX_CELL_CHARS)}…` : text
}

/**
 * The model reads tool results through `render`, so the rows themselves must be
 * here — a summary-only line leaves the model blind and invites error-channel
 * hacks like EXTRACTVALUE.
 * @param table - the executed query result.
 * @returns the rows rendered as a Markdown table.
 */
export function renderRows(table: QueryTable): string {
  const header = `查询成功：${table.rowCount} 行（${table.elapsedMs}ms）`
  if (table.columns.length === 0 || table.rows.length === 0) {
    return `${header}\n（结果集为空）`
  }
  const columns = [...table.columns]
  const shown = table.rows.slice(0, MAX_RENDERED_ROWS)
  const lines = [
    header,
    `SQL: ${table.displaySql}`,
    '',
    `| ${columns.join(' | ')} |`,
    `| ${columns.map(() => '---').join(' | ')} |`,
    ...shown.map(row => `| ${columns.map(name => cell(row[name])).join(' | ')} |`),
  ]
  if (table.rows.length > shown.length) {
    lines.push('', `（仅列出前 ${shown.length} 行，共 ${table.rowCount} 行；如需更多请加聚合或缩小范围）`)
  }
  return lines.join('\n')
}

/**
 * Same rule for the schema: list tables and their columns instead of a count.
 * @param payload - the described schema.
 * @returns the schema rendered as text.
 */
export function renderSchema(payload: SchemaPayload): string {
  const names = Object.keys(payload.tables)
  const qualifier = payload.schema === '' ? '' : `${payload.schema}.`
  const lines = [`数据源 ${payload.displayName}（${payload.datasource}，schema ${payload.schema}）：${names.length} 张表（字段来自 information_schema）`]
  if (payload.maxRows > 0) lines.push(`LIMIT 上限：${payload.maxRows}`)
  for (const name of names) {
    const columns = payload.tables[name] ?? []
    lines.push(`${qualifier}${name}（${columns.length} 列）：${columns.map(column => `${column.name} ${column.type.split(' — ')[0]}`).join(', ')}`)
  }
  return lines.join('\n')
}

/**
 * Build the `sql_query` and `describe_database` tools over one resolver.
 * @param resolve - resolves the database the executing Agent may query.
 * @returns the query tool followed by the schema tool.
 */
export function createDbTools(resolve: DatabaseResolver): readonly [ToolDefinition, ToolDefinition] {
  const sqlQuery = defineTool({
    name: 'sql_query',
    description:
      'Run ONE read-only SELECT against a whitelisted AgentOps datasource. '
      + 'The guard enforces: single statement, SELECT/WITH only, schema+table whitelist, '
      + 'denied columns rejected, and a LIMIT injected when the query omits one. '
      + 'Use describe_database first when you do not know the column names — never guess fields.',
    parameters: {
      sql: { type: 'string', required: true, description: 'A single SELECT (or WITH … SELECT) statement.' },
      database: { type: 'string', description: 'Database instance id or name; defaults to the only authorized one.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          columns: { type: 'array', required: true, items: { type: 'string' } },
          rows: { type: 'array', required: true, items: { type: 'json' } },
          rowCount: { type: 'integer', required: true },
          elapsedMs: { type: 'integer', required: true },
          truncated: { type: 'boolean', required: true },
          executedSql: { type: 'string', required: true },
          displaySql: { type: 'string', required: true },
          tables: { type: 'array', required: true, items: { type: 'string' } },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text:  value.ok
          ? renderRows(value as unknown as QueryTable)
          : `查询失败：${value.error ?? '未知原因'}`,
      }],
    },
    async execute(args, exec) {
      const resolution = await resolve(args.database, agentPresetOf(exec))
      if (!resolution.ok) {
        return {
          ok: false, columns: [], rows: [], rowCount: 0, elapsedMs: 0, truncated: false,
          executedSql: '', displaySql: '', tables: [], error: resolution.reason,
        }
      }
      const database = resolution.database
      const guarded = guardSql(args.sql, database.whitelist)
      if (!guarded.ok) {
        return {
          ok: false, columns: [], rows: [], rowCount: 0, elapsedMs: 0, truncated: false,
          executedSql: guarded.sql, displaySql: toDisplaySql(guarded.sql, database.whitelist), tables: [], error: guarded.reason ?? 'SQL 未通过校验',
        }
      }
      try {
        const result = await runQuery(
          { key: database.instanceId, displayName: database.label, whitelist: database.whitelist },
          database.target,
          guarded.sql,
        )
        return {
          ok: true,
          columns: result.columns,
          rows: result.rows as never,
          rowCount: result.rowCount,
          elapsedMs: result.elapsedMs,
          truncated: result.truncated,
          executedSql: guarded.sql,
          displaySql: toDisplaySql(guarded.sql, database.whitelist),
          tables: referencedTables(guarded.sql),
        }
      } catch (reason) {
        return {
          ok: false, columns: [], rows: [], rowCount: 0, elapsedMs: 0, truncated: false,
          executedSql: guarded.sql, displaySql: toDisplaySql(guarded.sql, database.whitelist), tables: [],
          error: reason instanceof Error ? reason.message : String(reason),
        }
      }
    },
  })

  const describeDatabase = defineTool({
    name: 'describe_database',
    description:
      'Describe the tables and columns of a whitelisted datasource. Read-only. '
      + 'Call this before writing SQL; column names must come from here, not from memory.',
    parameters: {
      database: { type: 'string', description: 'Database instance id or name; defaults to the only authorized one.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          datasource: { type: 'string', required: true },
          displayName: { type: 'string', required: true },
          schema: { type: 'string', required: true },
          maxRows: { type: 'integer', required: true },
          source: { type: 'string', required: true, enum: ['introspection', 'unavailable'] },
          tables: { type: 'json', required: true },
          note: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.source === 'unavailable'
          ? `无法获取结构：${value.note ?? ''}`
          : renderSchema(value as unknown as SchemaPayload),
      }],
    },
    async execute(args, exec) {
      const resolution = await resolve(args.database, agentPresetOf(exec))
      if (!resolution.ok) {
        return { datasource: args.database ?? '', displayName: args.database ?? '', schema: '', maxRows: 0, source: 'unavailable' as const, tables: {} as never, note: resolution.reason }
      }
      const database = resolution.database
      const described = await describeSchema(
        { key: database.instanceId, displayName: database.label, whitelist: database.whitelist },
        database.target,
      )
      return {
        datasource: described.datasource,
        displayName: described.displayName,
        schema: described.schema,
        maxRows: described.maxRows,
        source: described.source,
        tables: described.tables as never,
        ...(described.note === undefined ? {} : { note: described.note }),
      }
    },
  })

  return [sqlQuery, describeDatabase] as const
}
