/**
 * Legacy AgentOps migration tests: P0 and V1 databases are detected, planned
 * and copied into the target schema without guessing statuses or dropping
 * values that have no target column.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { applyMigration, detectShape, planMigration } from '../src/migrate.ts'

const COMMON_DDL = `
CREATE TABLE projects (
  project_id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'code',
  local_path TEXT, github_url TEXT, feishu_doc_token TEXT, workspace_id TEXT,
  next_task_number INTEGER NOT NULL DEFAULT 1, metadata TEXT, version INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE task_stages (
  stage_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, stage_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', assigned_agent TEXT, style_id TEXT,
  stage_input TEXT, stage_output TEXT, version INTEGER NOT NULL DEFAULT 0,
  started_at TEXT, committed_at TEXT
);
CREATE TABLE task_events (
  event_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, stage_id TEXT, event_type TEXT NOT NULL,
  actor TEXT, payload TEXT, created_at TEXT NOT NULL
);
CREATE TABLE task_runs (
  link_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, run_id TEXT, session_id TEXT,
  terminal_session_id TEXT, role TEXT NOT NULL DEFAULT 'main_execution', linked_at TEXT NOT NULL
);
CREATE TABLE task_reports (
  report_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, agent_id TEXT, session_id TEXT,
  terminal_session_id TEXT, content TEXT NOT NULL, artifact_ids TEXT, acceptance_self_check TEXT,
  status TEXT NOT NULL DEFAULT 'submitted', version INTEGER NOT NULL DEFAULT 0, submitted_at TEXT NOT NULL
);
`

const P0_TASKS = `
CREATE TABLE tasks (
  task_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, identifier TEXT, parent_task_id TEXT,
  title TEXT NOT NULL, description TEXT, status TEXT NOT NULL DEFAULT 'idea',
  task_type TEXT NOT NULL DEFAULT 'code', risk_level TEXT NOT NULL DEFAULT 'medium',
  creator_type TEXT NOT NULL DEFAULT 'user', creator_id TEXT, creator_name TEXT,
  assignee_type TEXT, assignee_id TEXT, assignee_name TEXT, sort_order REAL NOT NULL DEFAULT 0,
  thread_id TEXT, version INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL, closed_at TEXT,
  CHECK (status IN ('idea','backlog','discussing','reviewing','closed')),
  CHECK (risk_level IN ('low','medium','high'))
);
`

const V1_TASKS = `
CREATE TABLE tasks (
  task_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, identifier TEXT, parent_task_id TEXT,
  title TEXT NOT NULL, description TEXT, status TEXT NOT NULL DEFAULT 'idea',
  task_type TEXT NOT NULL DEFAULT 'code', risk_level TEXT NOT NULL DEFAULT 'medium',
  creator_type TEXT NOT NULL DEFAULT 'user', creator_id TEXT, creator_name TEXT,
  assignee_type TEXT, assignee_id TEXT, assignee_name TEXT, sort_order REAL NOT NULL DEFAULT 0,
  thread_id TEXT, version INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL, closed_at TEXT, approved INTEGER, archived_at TEXT,
  CHECK (status IN ('idea','backlog','discussing','reviewing','decomposing','in_progress',
                    'validating','closing','closed','paused','blocked','failed','canceled','abandoned'))
);
`

const P0_TASKS_LOOSE = `
CREATE TABLE tasks (
  task_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, identifier TEXT, parent_task_id TEXT,
  title TEXT NOT NULL, description TEXT, status TEXT NOT NULL DEFAULT 'idea',
  task_type TEXT NOT NULL DEFAULT 'code', risk_level TEXT NOT NULL DEFAULT 'medium',
  creator_type TEXT NOT NULL DEFAULT 'user', creator_id TEXT, creator_name TEXT,
  assignee_type TEXT, assignee_id TEXT, assignee_name TEXT, sort_order REAL NOT NULL DEFAULT 0,
  thread_id TEXT, version INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL, closed_at TEXT
);
`

function legacyDb(dir: string, options: { mode: 'p0' | 'v1'; taskStatus?: string; projectExtra?: boolean }): string {
  const path = join(dir, 'audit.db')
  const db = new DatabaseSync(path)
  db.exec(COMMON_DDL)
  db.exec(options.mode === 'p0' ? P0_TASKS : V1_TASKS)
  if (options.projectExtra === true) db.exec('ALTER TABLE projects ADD COLUMN binding_state TEXT')
  if (options.projectExtra === true) {
    db.prepare(
      "INSERT INTO projects(project_id, name, binding_state, created_at, updated_at) VALUES ('p1','订单后台','needs_review','n','n')",
    ).run()
  } else {
    db.prepare("INSERT INTO projects(project_id, name, created_at, updated_at) VALUES ('p1','订单后台','n','n')").run()
  }
  db.prepare(
    `INSERT INTO tasks(task_id, project_id, title, status, version, created_at, updated_at)
     VALUES ('t1','p1','修复导出按钮', ?, 0, 'n', 'n')`,
  ).run(options.taskStatus ?? 'idea')
  db.prepare(
    "INSERT INTO task_stages(stage_id, task_id, stage_type, status, started_at) VALUES ('s1','t1','方案讨论','done','n')",
  ).run()
  db.prepare(
    "INSERT INTO task_events(event_id, task_id, event_type, actor, created_at) VALUES ('e1','t1','created','user','n')",
  ).run()
  db.prepare(
    "INSERT INTO task_runs(link_id, task_id, run_id, session_id, terminal_session_id, linked_at) VALUES ('l1','t1',NULL,NULL,'term-9','n')",
  ).run()
  db.prepare(
    "INSERT INTO task_reports(report_id, task_id, content, submitted_at) VALUES ('r1','t1','正文','n')",
  ).run()
  db.prepare(
    "INSERT INTO task_reports(report_id, task_id, content, submitted_at) VALUES ('r2','t1','正文2','n')",
  ).run()
  db.prepare("UPDATE task_reports SET terminal_session_id = 'term-legacy' WHERE report_id = 'r2'").run()
  db.close()
  return path
}

void test('detectShape 区分 P0、V1 与目标库', () => {
  const dir = mkdtempSync(join(tmpdir(), 'task-legacy-'))
  mkdirSync(join(dir, 'p0'))
  mkdirSync(join(dir, 'v1'))
  mkdirSync(join(dir, 'versioned-v1'))
  assert.equal(detectShape(legacyDb(join(dir, 'p0'), { mode: 'p0' })), 'legacy-p0')
  assert.equal(detectShape(legacyDb(join(dir, 'v1'), { mode: 'v1' })), 'legacy-v1')
  const versionedV1 = legacyDb(join(dir, 'versioned-v1'), { mode: 'v1' })
  const versioned = new DatabaseSync(versionedV1)
  versioned.exec("ALTER TABLE tasks ADD COLUMN lifecycle_mode TEXT NOT NULL DEFAULT 'v1'; PRAGMA user_version = 1")
  versioned.close()
  assert.equal(detectShape(versionedV1), 'legacy-v1')
  rmSync(dir, { recursive: true, force: true })
})

void test('P0：生命周期标记为 p0，版本保持 0 基，阶段 done 转为 committed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'task-legacy-'))
  const path = legacyDb(dir, { mode: 'p0' })
  const plan = planMigration(path)
  assert.equal(plan.shape, 'legacy-p0')
  assert.deepEqual(plan.issues, [])
  assert.ok(plan.actions.some(action => action.includes("lifecycle_mode = 'p0'")))

  const result = applyMigration(path, { backupDir: join(dir, 'backup') })
  assert.equal(result.applied, true)
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    const task = db.prepare('SELECT lifecycle_mode, status, version FROM tasks').get() as {
      lifecycle_mode: string
      status: string
      version: number
    }
    assert.deepEqual({ ...task }, { lifecycle_mode: 'p0', status: 'idea', version: 0 })
    const stage = db.prepare('SELECT status FROM task_stages').get() as { status: string }
    assert.equal(stage.status, 'committed')
  } finally {
    db.close()
  }
  rmSync(dir, { recursive: true, force: true })
})

void test('V1：运行状态置 unknown，终端指针保留在 task_runs，报告指针进入 manifest', () => {
  const dir = mkdtempSync(join(tmpdir(), 'task-legacy-'))
  const path = legacyDb(dir, { mode: 'v1', taskStatus: 'in_progress' })
  const result = applyMigration(path, { backupDir: join(dir, 'backup') })
  assert.equal(result.applied, true)
  assert.deepEqual(result.manifest.droppedTerminalReportPointers, [
    { report_id: 'r2', task_id: 't1', terminal_session_id: 'term-legacy' },
  ])

  const db = new DatabaseSync(path, { readOnly: true })
  try {
    const run = db.prepare('SELECT status, terminal_session_id FROM task_runs').get() as {
      status: string
      terminal_session_id: string
    }
    assert.equal(run.status, 'unknown')
    assert.equal(run.terminal_session_id, 'term-9')
    const task = db.prepare('SELECT lifecycle_mode FROM tasks').get() as { lifecycle_mode: string }
    assert.equal(task.lifecycle_mode, 'v1')
  } finally {
    db.close()
  }
  rmSync(dir, { recursive: true, force: true })
})

void test('P0 库出现 V1 状态时拒绝迁移', () => {
  const dir = mkdtempSync(join(tmpdir(), 'task-legacy-'))
  const path = join(dir, 'p0-bad.db')
  const db = new DatabaseSync(path)
  db.exec(COMMON_DDL)
  db.exec(P0_TASKS_LOOSE)
  db.prepare("INSERT INTO projects(project_id, name, created_at, updated_at) VALUES ('p1','P','n','n')").run()
  db.prepare(
    "INSERT INTO tasks(task_id, project_id, title, status, version, created_at, updated_at) VALUES ('t1','p1','x','in_progress',0,'n','n')",
  ).run()
  db.close()
  const plan = planMigration(path)
  assert.match(plan.issues[0] ?? '', /not valid in legacy-p0/)
  assert.throws(() => applyMigration(path), /migration refused/)
  rmSync(dir, { recursive: true, force: true })
})

void test('缺失项目引用会创建可审计占位项目，旧 project 额外列进入 metadata', () => {
  const dir = mkdtempSync(join(tmpdir(), 'task-legacy-'))
  const path = legacyDb(dir, { mode: 'v1', projectExtra: true })
  const single = new DatabaseSync(path)
  single.prepare("UPDATE tasks SET project_id = 'missing' WHERE task_id = 't1'").run()
  single.close()

  applyMigration(path, { backupDir: join(dir, 'backup') })
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    const projects = db.prepare('SELECT project_id, metadata FROM projects ORDER BY project_id').all() as {
      project_id: string
      metadata: string
    }[]
    assert.deepEqual(projects.map(row => row.project_id), ['missing', 'p1'])
    const placeholder = JSON.parse(projects[0]!.metadata) as { legacy_project: { reason?: string } }
    assert.match(placeholder.legacy_project.reason ?? '', /missing project reference/)
    const kept = JSON.parse(projects[1]!.metadata) as { legacy_project: { binding_state?: string } }
    assert.equal(kept.legacy_project.binding_state, 'needs_review')
  } finally {
    db.close()
  }
  rmSync(dir, { recursive: true, force: true })
})
