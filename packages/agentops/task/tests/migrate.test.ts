/**
 * Migrator tests: a simplified store is planned read-only, rebuilt in staging,
 * verified, and replaced as a file group with a backup of the original.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { TASK_TABLES } from '../src/contracts.ts'
import { applyMigration, detectShape, planMigration } from '../src/migrate.ts'
import { SCHEMA_VERSION, readUserVersion } from '../src/schema.ts'

const SIMPLIFIED_DDL = `
CREATE TABLE tasks (
  id TEXT PRIMARY KEY, project_id TEXT, parent_id TEXT, title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '', status TEXT NOT NULL, risk_level TEXT NOT NULL DEFAULT 'medium',
  stage TEXT NOT NULL DEFAULT '', assignee TEXT, version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, closed_at TEXT
);
CREATE TABLE task_stages (
  task_id TEXT NOT NULL, seq INTEGER NOT NULL, name TEXT NOT NULL, status TEXT NOT NULL,
  note TEXT, entered_at TEXT NOT NULL, left_at TEXT, PRIMARY KEY (task_id, seq)
);
CREATE TABLE task_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, kind TEXT NOT NULL,
  from_status TEXT, to_status TEXT, actor TEXT NOT NULL, reason TEXT, at TEXT NOT NULL
);
`

function workspace(): string {
  return mkdtempSync(join(tmpdir(), 'task-migrate-'))
}

function simplifiedDb(dir: string, rows: { versions?: number[]; status?: string } = {}): string {
  const path = join(dir, 'tasks.db')
  const db = new DatabaseSync(path)
  db.exec(SIMPLIFIED_DDL)
  const versions = rows.versions ?? [1, 2, 0]
  versions.forEach((version, index) => {
    db.prepare(
      `INSERT INTO tasks(id, project_id, parent_id, title, description, status, risk_level, stage, assignee,
                         version, created_at, updated_at)
       VALUES (?, 'p1', NULL, ?, '', ?, 'high', ?, 'alice', ?, '2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z')`,
    ).run(`t${index + 1}`, `task ${index + 1}`, rows.status ?? 'in_progress', '方案讨论', version)
  })
  db.prepare(
    "INSERT INTO task_stages(task_id, seq, name, status, note, entered_at) VALUES ('t1', 1, '方案讨论', 'done', '完成', '2026-01-01T01:00:00Z')",
  ).run()
  db.prepare(
    "INSERT INTO task_events(task_id, kind, from_status, to_status, actor, reason, at) VALUES ('t1', 'advanced', 'idea', 'discussing', 'agent', '推进', '2026-01-01T02:00:00Z')",
  ).run()
  db.close()
  return path
}

void test('detectShape 识别简化库与目标库，缺文件时报错', () => {
  const dir = workspace()
  const path = simplifiedDb(dir)
  assert.equal(detectShape(path), 'simplified')
  assert.throws(() => detectShape(join(dir, 'missing.db')), /not found/)

  const result = applyMigration(path)
  assert.equal(result.applied, true)
  assert.equal(detectShape(path), 'target')
  rmSync(dir, { recursive: true, force: true })
})

void test('plan 只读：不改文件、不留下 staging', () => {
  const dir = workspace()
  const path = simplifiedDb(dir)
  const before = readFileSync(path)
  const plan = planMigration(path)
  assert.equal(plan.shape, 'simplified')
  assert.deepEqual(plan.counts, { tasks: 3, stages: 1, events: 1 })
  assert.deepEqual(plan.issues, [])
  assert.ok(plan.actions.length >= 4)
  assert.deepEqual(readFileSync(path), before)
  assert.deepEqual(readdirSync(dir), ['tasks.db'])
  rmSync(dir, { recursive: true, force: true })
})

void test('dry-run 不替换目标也不创建备份', () => {
  const dir = workspace()
  const path = simplifiedDb(dir)
  const result = applyMigration(path, { dryRun: true })
  assert.equal(result.applied, false)
  assert.equal(result.verified, false)
  assert.equal(result.backupDir, undefined)
  assert.deepEqual(readdirSync(dir), ['tasks.db'])
  assert.equal(detectShape(path), 'simplified')
  rmSync(dir, { recursive: true, force: true })
})

void test('apply 映射版本、阶段状态与 legacy 事件，并留下备份', () => {
  const dir = workspace()
  const path = simplifiedDb(dir)
  const result = applyMigration(path, { backupDir: join(dir, 'backup') })
  assert.equal(result.applied, true)
  assert.equal(result.verified, true)
  assert.ok(existsSync(join(dir, 'backup', 'tasks.db')))

  const db = new DatabaseSync(path, { readOnly: true })
  try {
    assert.equal(readUserVersion(db), SCHEMA_VERSION)
    const tables = db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").get() as { n: number }
    assert.equal(tables.n, TASK_TABLES.length)
    const versions = db.prepare('SELECT task_id, version FROM tasks ORDER BY task_id').all() as { task_id: string; version: number }[]
    assert.deepEqual(versions.map(row => [row.task_id, row.version]), [['t1', 0], ['t2', 1], ['t3', 0]])
    const stage = db.prepare('SELECT status, stage_output FROM task_stages').get() as { status: string; stage_output: string }
    assert.equal(stage.status, 'committed')
    assert.deepEqual(JSON.parse(stage.stage_output), { note: '完成' })
    const legacy = db.prepare("SELECT COUNT(*) AS n FROM task_events WHERE event_type = 'legacy_import'").get() as { n: number }
    assert.equal(legacy.n, 3)
    const project = db.prepare('SELECT metadata FROM projects').get() as { metadata: string }
    assert.equal((JSON.parse(project.metadata) as { legacy_project?: { source?: string } }).legacy_project?.source, 'simplified')
  } finally {
    db.close()
  }
  rmSync(dir, { recursive: true, force: true })
})

void test('负版本进入 issues，apply 拒绝执行', () => {
  const dir = workspace()
  const path = simplifiedDb(dir, { versions: [-1] })
  const plan = planMigration(path)
  assert.equal(plan.issues.length, 1)
  assert.match(plan.issues[0] ?? '', /version -1/)
  assert.throws(() => applyMigration(path), /migration refused/)
  assert.equal(detectShape(path), 'simplified')
  rmSync(dir, { recursive: true, force: true })
})

void test('未知状态进入 issues', () => {
  const dir = workspace()
  const path = simplifiedDb(dir, { status: 'shipped' })
  const plan = planMigration(path)
  assert.match(plan.issues[0] ?? '', /unknown status "shipped"/)
  rmSync(dir, { recursive: true, force: true })
})

void test('已是目标 schema 时幂等返回', () => {
  const dir = workspace()
  const path = simplifiedDb(dir)
  applyMigration(path)
  const again = applyMigration(path)
  assert.equal(again.applied, false)
  assert.equal(again.verified, true)
  rmSync(dir, { recursive: true, force: true })
})

void test('保留旧主库与 WAL/SHM 的备份（文件组）', () => {
  const dir = workspace()
  const path = simplifiedDb(dir)
  copyFileSync(path, join(dir, 'sidecar-source.db'))
  const result = applyMigration(path, { backupDir: join(dir, 'group') })
  assert.equal(result.applied, true)
  assert.ok(existsSync(join(dir, 'group', 'tasks.db')))
  rmSync(dir, { recursive: true, force: true })
})
