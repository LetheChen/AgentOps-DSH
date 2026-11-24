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

const policy = {
  key: datasource.key,
  displayName: datasource.label,
  whitelist: datasource.whitelist,
}

const schema = await describeSchema(policy, target)
if (schema.schema === '' || Object.keys(schema.tables).length === 0) {
  throw new Error(`无法获取 ${datasource.key} 的表结构：${schema.note ?? '未知原因'}`)
}
const [firstTable] = Object.keys(schema.tables)
if (firstTable === undefined) throw new Error('datasources 白名单里没有可校验的表')

const sql = `SELECT COUNT(*) AS total FROM ${schema.schema}.${firstTable}`
const guarded = guardSql(sql, datasource.whitelist)
if (!guarded.ok) throw new Error(`guard 拒绝：${guarded.reason}`)

const result = await runQuery(policy, target, guarded.sql)
console.log(JSON.stringify({
  schema: schema.schema,
  table: firstTable,
  schemaSource: schema.source,
  rowCount: result.rowCount,
  elapsedMs: result.elapsedMs,
  executedSql: guarded.sql,
}, null, 2))
store.close()
