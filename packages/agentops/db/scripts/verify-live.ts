/**
 * Real read-only verification against the audit database, through the same
 * guard + target-resolution path the tools use.
 *
 * Usage: node --import tsx packages/agentops/db/scripts/verify-live.ts
 */

import { dshHomePath } from '@deepseek-ai/dsh-home-paths'

import { ConnectionStore } from '../../vault/src/store.ts'
import { loadDatasources } from '../src/dsh.ts'
import { guardSql } from '../src/guard.ts'
import { describeSchema, runQuery, type Target } from '../src/query.ts'

const datasources = loadDatasources(dshHomePath('agentops', 'datasources.yml'))
const datasource = datasources.find(config => config.key === 'audit_reader') ?? datasources[0]
if (datasource === undefined) throw new Error('datasources.yml 里没有 audit_reader')

const store = new ConnectionStore(dshHomePath('agentops', 'credentials.db'))
const connection = store.get(datasource.key)
if (connection === null) throw new Error(`凭证库里没有连接 ${datasource.key}`)

const target: Target = {
  driver: connection.driver === 'sqlite' ? 'sqlite' : 'mysql',
  host: connection.host,
  port: connection.port,
  username: connection.username,
  password: store.readSecret(connection.id),
  database: connection.defaultDatabase,
}

const schema = await describeSchema(datasource, target)
const tables = Object.entries(schema.tables).map(([name, columns]) => `${name}(${columns.length})`)

const sql = 'SELECT status, COUNT(*) AS total FROM audit_example.audit_records GROUP BY status ORDER BY total DESC LIMIT 10'
const guarded = guardSql(sql, datasource.whitelist)
if (!guarded.ok) throw new Error(`guard 拒绝：${guarded.reason}`)

const result = await runQuery(datasource, target, guarded.sql)
console.log(JSON.stringify({
  tables: schema.tables === undefined ? [] : tables,
  schemaSource: schema.source,
  columns: result.columns,
  rows: result.rows,
  rowCount: result.rowCount,
  elapsedMs: result.elapsedMs,
  executedSql: guarded.sql,
}, null, 2))
store.close()
