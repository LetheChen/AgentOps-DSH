import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import { describeSchema, runQuery, type Target } from '../src/query.ts'
import { guardSql, referencedTables } from '../src/guard.ts'
import { parseDatasources } from '../src/datasources.ts'
import { resolveDatasourcesPath } from '../src/dsh.ts'
import { CapabilityStore } from '@agentops/dsh-capability'
import { createDbTools, renderRows, renderSchema } from '../src/tools.ts'
import { createDatabaseResolver, normalizeDatabasePolicy, type DatabaseResolver } from '../src/instances.ts'
import type { DatasourceConfig } from '../src/datasources.ts'

const WHITELIST = {
  driver: 'sqlite',
  schemas: ['audit_example'],
  tables: { audit_example: ['audit_records', 'users'] },
  deniedColumns: ['password_hash'],
  maxRows: 100,
  timeoutSeconds: 30,
} as const

const DATASOURCE: DatasourceConfig = {
  key: 'audit_reader',
  label: 'audit',
  driver: 'sqlite',
  dsnEnv: 'TEST_DSN',
  credentialId: null,
  whitelist: WHITELIST,
}

/** The query policy shape expected by the query layer. */
const DATASOURCE_POLICY = {
  key: DATASOURCE.key,
  displayName: DATASOURCE.label,
  whitelist: DATASOURCE.whitelist,
}

const targetOf = (path: string): Target => ({
  driver: 'sqlite', host: path, port: null, username: '', password: null, database: null,
})

/** A resolver that always returns one local SQLite target. */
const resolveTo = (target: Target | null): DatabaseResolver => async () => target === null
  ? { ok: false, reason: '数据源 audit_reader 未配置凭据' }
  : {
    ok: true,
    database: {
      instanceId: DATASOURCE.key,
      label: DATASOURCE.label,
      target,
      whitelist: DATASOURCE.whitelist,
    },
  }

/** Resolver over one in-memory capability store plus the legacy datasource. */
const capabilityResolver = (store: CapabilityStore, path: string) => createDatabaseResolver({
  capabilityStore: () => store,
  datasources: [DATASOURCE],
  resolveLegacyTarget: () => Promise.resolve(targetOf(path)),
})

function withDb(run: (path: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'agentops-db-'))
  const path = join(dir, 'audit.db')
  const db = new DatabaseSync(path)
  db.exec(`
    CREATE TABLE audit_records (id INTEGER PRIMARY KEY, doc_number TEXT, status TEXT);
    CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, password_hash TEXT);
    INSERT INTO audit_records (doc_number, status) VALUES ('A-1', 'approved'), ('A-2', 'rejected');
    INSERT INTO users (username, password_hash) VALUES ('alice', 'secret');
  `)
  db.close()
  return run(path).finally(() => { rmSync(dir, { recursive: true, force: true }) })
}

void test('路径：datasources 默认跟随 ~/.dsh，DSH_HOME 可覆盖', () => {
  const previous = process.env.DSH_HOME
  delete process.env.DSH_HOME
  try {
    assert.equal(resolveDatasourcesPath({}), join(homedir(), '.dsh', 'agentops', 'datasources.yml'))
    assert.notEqual(resolveDatasourcesPath({}), join(process.cwd(), '.dsh', 'agentops', 'datasources.yml'))
    process.env.DSH_HOME = join(tmpdir(), 'agentops-db-home')
    assert.equal(resolveDatasourcesPath({}), join(tmpdir(), 'agentops-db-home', 'agentops', 'datasources.yml'))
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
})

void test('guard：只放行单条 SELECT/WITH，写操作与多语句被拒', () => {
  assert.equal(guardSql('SELECT * FROM audit_example.audit_records', WHITELIST).ok, true)
  assert.equal(guardSql('WITH t AS (SELECT 1) SELECT * FROM t', WHITELIST).ok, true)
  assert.equal(guardSql('DELETE FROM audit_example.audit_records', WHITELIST).ok, false)
  assert.equal(guardSql('SELECT 1; DROP TABLE users', WHITELIST).ok, false)
  assert.equal(guardSql('SELECT * INTO OUTFILE "/tmp/x" FROM t', WHITELIST).ok, false)
})

void test('guard：裸表名只允许命中 SQLite 单 schema 白名单', () => {
  const unlisted = guardSql('SELECT * FROM secrets', WHITELIST)
  assert.equal(unlisted.ok, false)
  assert.match(unlisted.reason ?? '', /schema 限定/)

  const sqliteListed = guardSql('SELECT r.status FROM audit_records r', WHITELIST)
  assert.equal(sqliteListed.ok, true)

  const serverUnqualified = guardSql('SELECT * FROM audit_records', { ...WHITELIST, driver: 'mysql' })
  assert.equal(serverUnqualified.ok, false)
  assert.match(serverUnqualified.reason ?? '', /schema 限定/)
})

void test('guard：白名单表与屏蔽列', () => {
  const denied = guardSql('SELECT * FROM audit_example.secrets', WHITELIST)
  assert.equal(denied.ok, false)
  assert.match(denied.reason ?? '', /白名单/)

  const column = guardSql('SELECT password_hash FROM audit_example.users', WHITELIST)
  assert.equal(column.ok, false)
  assert.match(column.reason ?? '', /屏蔽/)

  // A string literal that merely mentions a denied column is fine.
  assert.equal(guardSql("SELECT * FROM audit_example.users WHERE username = 'password_hash'", WHITELIST).ok, true)
})

void test('guard：数值字面量的小数点不算 schema 限定', () => {
  // `100.0` has the same lexical shape as `schema.table`; rejecting it blocks
  // ordinary percentage arithmetic.
  assert.equal(
    guardSql(
      "SELECT ROUND(SUM(CASE WHEN decision='pass' THEN 1 ELSE 0 END) * 100.0 / COUNT(*), 1) AS rate FROM audit_example.audit_records",
      WHITELIST,
    ).ok,
    true,
  )
  assert.equal(
    guardSql('SELECT COUNT(*) * 1.5 AS x FROM audit_example.audit_records', WHITELIST).ok,
    true,
  )
})

void test('guard：表别名、CTE 与派生表名不算 schema', () => {
  // `alias.column` has the same lexical shape as `schema.table`; a bare
  // qualified-name scan rejected ordinary aliased queries.
  assert.equal(
    guardSql('SELECT r.status FROM audit_example.audit_records r WHERE r.status = \'completed\'', WHITELIST).ok,
    true,
  )
  assert.equal(
    guardSql('SELECT a.agent_name, COUNT(*) FROM audit_example.audit_records a GROUP BY a.agent_name', WHITELIST).ok,
    true,
  )
  assert.equal(
    guardSql('WITH b AS (SELECT status FROM audit_example.audit_records) SELECT b.status FROM b', WHITELIST).ok,
    true,
  )
  assert.equal(
    guardSql('SELECT t.c FROM (SELECT COUNT(*) AS c FROM audit_example.audit_records) t', WHITELIST).ok,
    true,
  )

  // The alias exception must not become a bypass: a real foreign schema is
  // still rejected, aliased or not.
  const foreign = guardSql('SELECT r.id FROM other_db.users r', WHITELIST)
  assert.equal(foreign.ok, false)
  assert.match(foreign.reason ?? '', /schema 不在白名单/)
})

void test('guard：缺 LIMIT 时按 maxRows 注入，已有则不重复', () => {
  const injected = guardSql('SELECT * FROM audit_example.audit_records', WHITELIST)
  assert.equal(injected.ok, true)
  assert.match(injected.sql, /LIMIT 100$/)

  const kept = guardSql('SELECT * FROM audit_example.audit_records LIMIT 5', WHITELIST)
  assert.equal(kept.sql, 'SELECT * FROM audit_example.audit_records LIMIT 5')
})

void test('guard：referencedTables 提取 FROM/JOIN 目标', () => {
  assert.deepEqual(
    referencedTables('SELECT * FROM audit_example.audit_records a JOIN audit_example.users u ON a.id = u.id'),
    ['audit_example.audit_records', 'audit_example.users'],
  )
})


void test('guard：标识符引号、CTE 与字符串分号不被误判', () => {
  const mysql = { ...WHITELIST, driver: 'mysql' as const }
  const backtick = String.fromCharCode(96)
  assert.equal(guardSql('SELECT * FROM ' + backtick + 'audit_example' + backtick + '.' + backtick + 'audit_records' + backtick, mysql).ok, true)
  assert.equal(guardSql('SELECT * FROM "audit_example"."audit_records"', mysql).ok, true)
  assert.equal(guardSql('WITH x (a) AS (SELECT 1) SELECT a FROM x', mysql).ok, true)
  assert.equal(guardSql('WITH x AS (SELECT 1), y AS (SELECT * FROM x) SELECT * FROM y', mysql).ok, true)
  assert.equal(guardSql('WITH RECURSIVE x AS (SELECT 1) SELECT * FROM x', mysql).ok, true)
  assert.equal(guardSql("SELECT 'a;b' AS x FROM audit_example.audit_records", mysql).ok, true)
})

void test('guard：schema 与表名错误回传可用值', () => {
  const mysql = { ...WHITELIST, driver: 'mysql' as const }
  const schema = guardSql('SELECT * FROM other.audit_records', mysql)
  assert.equal(schema.ok, false)
  assert.match(schema.reason ?? '', /schema 不在白名单：other/)
  assert.match(schema.reason ?? '', /可用：audit_example/)

  const table = guardSql('SELECT * FROM audit_records', mysql)
  assert.equal(table.ok, false)
  assert.match(table.reason ?? '', /表名必须带 schema 限定：audit_records/)
  assert.match(table.reason ?? '', /可用 schema：audit_example/)
})

void test('执行：sqlite 只读查询返回列与行；describe 输出字段', async () => {
  await withDb(async (path) => {
    const result = await runQuery(DATASOURCE_POLICY, targetOf(path), 'SELECT doc_number, status FROM audit_records LIMIT 10')
    assert.deepEqual(result.columns, ['doc_number', 'status'])
    assert.equal(result.rowCount, 2)
    assert.equal(result.truncated, false)

    const schema = await describeSchema(DATASOURCE_POLICY, targetOf(path))
    assert.equal(schema.source, 'introspection')
    assert.deepEqual(schema.tables.audit_records?.map(column => column.name), ['id', 'doc_number', 'status'])
  })
})

void test('工具：sql_query 走 guard 并返回行；被屏蔽列直接失败', async () => {
  await withDb(async (path) => {
    const tools = createDbTools(resolveTo(targetOf(path)))
    const query = tools[0]
    const ok = await query.execute({ sql: 'SELECT doc_number FROM audit_records' }, {} as never) as Record<string, unknown>
    assert.equal(ok.ok, true)
    assert.equal(ok.rowCount, 2)
    assert.match(String(ok.displaySql), /FROM audit_records/)

    const blocked = await query.execute({ sql: 'SELECT password_hash FROM users' }, {} as never) as Record<string, unknown>
    assert.equal(blocked.ok, false)
    assert.match(String(blocked.error), /屏蔽/)
  })
})

void test('工具：未配置凭据时明确失败，不抛异常', async () => {
  const tools = createDbTools(resolveTo(null))
  const query = tools[0]
  const result = await query.execute({ sql: 'SELECT 1 FROM audit_records' }, {} as never) as Record<string, unknown>
  assert.equal(result.ok, false)
  assert.match(String(result.error), /未配置凭据/)
})

void test('access policy：按原 AgentOps 语义归一化白名单与限额', () => {
  const config = { engine: 'mysql', database: 'audit_example' }
  const canonical = normalizeDatabasePolicy(config, {
    allowed_tables: { audit_example: ['users', 'audit_records'] },
    denied_columns: ['password_hash', ' '],
    operation_limits: { max_rows: 200, max_query_seconds: 5 },
  })
  assert.deepEqual(canonical.schemas, ['audit_example'])
  assert.deepEqual(canonical.tables.audit_example, ['audit_records', 'users'])
  assert.deepEqual(canonical.deniedColumns, ['password_hash'])
  assert.equal(canonical.maxRows, 200)
  assert.equal(canonical.timeoutSeconds, 5)

  // The legacy flat list and the single-key map both resolve to the same shape.
  const flat = normalizeDatabasePolicy(config, { allowed_tables: ['users'] })
  assert.deepEqual(flat.tables.audit_example, ['users'])
  const indirect = normalizeDatabasePolicy(config, { allowed_tables: { audit_example: ['users'] } })
  assert.deepEqual(indirect.tables.audit_example, ['users'])

  // PostgreSQL keeps database and schema separate; `public` is the safe default.
  const pg = normalizeDatabasePolicy({ engine: 'pg', database: 'reporting' }, { allowed_tables: { public: ['orders'] } })
  assert.deepEqual(pg.schemas, ['public'])
  assert.deepEqual(pg.tables.public, ['orders'])
  assert.throws(() => normalizeDatabasePolicy(config, { allowed_tables: { audit_example: ['bad table'] } }), /不合法/)
})

void test('resolver：能力中心已配置的 preset 只走实例，不回落到 datasources.yml', async () => {
  await withDb(async (path) => {
    const store = new CapabilityStore(':memory:', { key: Buffer.alloc(32, 7), source: 'env' })
    try {
      store.saveInstance({
        instanceId: 'audit_reader',
        capabilityId: 'database',
        name: '审计库实例',
        config: { engine: 'sqlite', host: path },
        accessPolicy: { allowed_tables: { audit_example: ['audit_records'] }, denied_columns: ['password_hash'] },
        secret: 'unused',
      }, 'test')
      store.replaceBindings('smart_query', [{ capabilityId: 'database', instanceId: 'audit_reader', enabled: true }], 'test')

      const resolve = capabilityResolver(store, path)
      const bound = await resolve('audit_reader', 'smart_query')
      assert.equal(bound.ok, true)
      if (bound.ok) {
        assert.equal(bound.database.instanceId, 'audit_reader')
        assert.equal(bound.database.label, '审计库实例')
        assert.deepEqual(bound.database.whitelist.tables.audit_example, ['audit_records'])
      }
    } finally {
      store.close()
    }
  })
})

void test('resolver：能力中心配置为空时拒绝，且能力实例不会被旧数据源文件旁路', async () => {
  await withDb(async (path) => {
    const store = new CapabilityStore(':memory:', { key: Buffer.alloc(32, 7), source: 'env' })
    try {
      store.saveInstance({
        instanceId: 'audit_reader',
        capabilityId: 'database',
        name: '审计库实例',
        config: { engine: 'sqlite', host: path },
        accessPolicy: { allowed_tables: { audit_example: ['audit_records'] } },
        secret: 'unused',
      }, 'test')
      store.replaceBindings('smart_query', [], 'test')

      const resolve = capabilityResolver(store, path)
      const configuredEmpty = await resolve(undefined, 'smart_query')
      assert.equal(configuredEmpty.ok, false)

      const shadowed = await resolve('audit_reader', 'some_other_preset')
      assert.equal(shadowed.ok, false)
      if (!shadowed.ok) assert.match(shadowed.reason, /能力中心管理/)
    } finally {
      store.close()
    }
  })
})

void test('datasources：解析 YAML，缺 key 抛错', () => {
  const parsed = parseDatasources(`
datasources:
  - key: audit_reader
    label: 审计库
    driver: sqlite
    dsn_env: AGENTOPS_DB_AUDIT_DSN
    schemas: [audit_example]
    tables:
      audit_example: [audit_records]
    denied_columns: [password_hash]
    max_rows: 500
`)
  assert.equal(parsed.length, 1)
  assert.equal(parsed[0]?.driver, 'sqlite')
  assert.equal(parsed[0]?.whitelist.driver, 'sqlite')
  assert.equal(parsed[0]?.whitelist.maxRows, 500)
  assert.throws(() => parseDatasources('datasources:\n  - label: 无 key\n'))
})

void test('guard：系统库与非白名单 schema 被拒', () => {
  const info = guardSql('SELECT table_name FROM information_schema.tables', WHITELIST)
  assert.equal(info.ok, false)
  assert.match(info.reason ?? '', /系统库/)

  const other = guardSql('SELECT * FROM other_db.users', WHITELIST)
  assert.equal(other.ok, false)
  assert.match(other.reason ?? '', /schema 不在白名单/)
})

void test('render：模型能看到真实数据行（不是只有摘要）', () => {
  const text = renderRows({
    columns: ['status', 'total'],
    rows: [{ status: 'completed', total: 3304 }, { status: 'failed', total: 0 }],
    rowCount: 2,
    elapsedMs: 159,
    executedSql: 'SELECT status, COUNT(*) AS total FROM audit_example.audit_records GROUP BY status',
    displaySql: 'SELECT status, COUNT(*) AS total FROM <业务库>.audit_records GROUP BY status',
  })
  assert.match(text, /completed/)
  assert.match(text, /3304/)
  assert.match(text, /\| status \| total \|/)
})

void test('render：超过 50 行时截断并说明', () => {
  const rows = Array.from({ length: 60 }, (_, index) => ({ id: index }))
  const text = renderRows({ columns: ['id'], rows, rowCount: 60, elapsedMs: 1, executedSql: 'SELECT id FROM t', displaySql: 'SELECT id FROM t' })
  assert.match(text, /仅列出前 50 行/)
})

void test('render：describe 输出表与字段清单', () => {
  const text = renderSchema({
    datasource: 'audit_reader',
    displayName: '审计库',
    schema: 'audit_example',
    maxRows: 100,
    tables: {
      audit_records: [
        { name: 'id', type: 'bigint', nullable: false },
        { name: 'status', type: 'varchar — 状态：completed/failed', nullable: true },
      ],
    },
  })
  assert.match(text, /审计库（audit_reader，schema audit_example）/)
  assert.match(text, /LIMIT 上限：100/)
  assert.match(text, /audit_example\.audit_records（2 列）/)
  assert.match(text, /status varchar/)
})
