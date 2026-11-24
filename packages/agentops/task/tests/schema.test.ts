/**
 * Schema tests for the v2 task database. They exercise the DB-level checks the
 * service layer will rely on: gate-only Task creation, immutable source,
 * one-to-one decision links, append-only evidence and parent relation facts.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'

import { TASK_INDEXES, TASK_TABLES, revisionTriggerNames } from '../src/contracts.ts'
import {
  SCHEMA_VERSION,
  TASK_SCHEMA_SQL,
  assertSchemaVersion,
  createTaskSchema,
  readUserVersion,
} from '../src/schema.ts'

const NOW = '2026-11-08T00:00:00Z'

function fresh(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  createTaskSchema(db)
  return db
}

function names(db: DatabaseSync, type: string): string[] {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type = ? AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all(type) as { name: string }[]
  return rows.map(row => row.name)
}

function insertProject(db: DatabaseSync, project = 'p1'): void {
  db.prepare(
    `INSERT OR IGNORE INTO projects(project_id, name, created_at, updated_at)
     VALUES (?, ?, ?, ?)`,
  ).run(project, `project ${project}`, NOW, NOW)
}

function insertCandidate(
  db: DatabaseSync,
  candidate = 'c1',
  project = 'p1',
  status = 'captured',
  version = 0,
): void {
  db.prepare(
    `INSERT INTO task_candidates(
       candidate_id, source_type, source_ref, project_id, title, status,
       version, created_at, updated_at
     ) VALUES (?, 'manual', ?, ?, ?, ?, ?, ?, ?)`,
  ).run(candidate, `ref:${candidate}`, project, `candidate ${candidate}`, status, version, NOW, NOW)
}

function insertSnapshot(
  db: DatabaseSync,
  candidate = 'c1',
  snapshot = 's1',
  project = 'p1',
  candidateVersion = 0,
  hash = 'sha256:s1',
): void {
  db.prepare(
    `INSERT INTO admission_snapshots(
       snapshot_id, candidate_id, candidate_version, project_id,
       search_query_json, search_coverage_json, active_work_json,
       proposed_decisions_json, authoritative_decisions_json,
       historical_decisions_json, selected_decision_ids_json,
       decision_link_count, conflicts_json, required_actions_json,
       residual_risk, snapshot_version, canonical_json, snapshot_hash,
       created_by, created_at
     ) VALUES (?, ?, ?, ?, '{}', '{}', '[]', '[]', '[]', '[]', '[]', 0, '[]', '[]', 'none', 1, '{"v":1}', ?, 'tester', ?)`,
  ).run(snapshot, candidate, candidateVersion, project, hash, NOW)
}

function insertApproveGate(
  db: DatabaseSync,
  candidate = 'c1',
  snapshot = 's1',
  gate = 'g1',
  candidateVersion = 0,
  hash = 'sha256:s1',
): void {
  db.prepare(
    `INSERT INTO candidate_gate_events(
       event_id, candidate_id, candidate_version, snapshot_id, snapshot_hash,
       action, actor_type, actor_id, decided_at, request_id,
       idempotency_key, payload_hash
     ) VALUES (?, ?, ?, ?, ?, 'approve', 'user', 'u1', ?, ?, ?, ?)`,
  ).run(gate, candidate, candidateVersion, snapshot, hash, NOW, `req:${gate}`, `idem:${gate}`, `payload:${gate}`)
}

function attachSnapshot(db: DatabaseSync, candidate = 'c1', snapshot = 's1', hash = 'sha256:s1'): void {
  db.prepare(
    `UPDATE task_candidates
     SET admission_snapshot_id = ?, admission_snapshot_hash = ?
     WHERE candidate_id = ?`,
  ).run(snapshot, hash, candidate)
}

function insertTask(
  db: DatabaseSync,
  task: string,
  candidate: string,
  project = 'p1',
  status = 'discussing',
  mode = 'v1',
): void {
  db.prepare(
    `INSERT INTO tasks(
       task_id, project_id, source_candidate_id, lifecycle_mode, title,
       status, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(task, project, candidate, mode, `task ${task}`, status, NOW, NOW)
}

function convertCandidate(db: DatabaseSync, candidate: string, task: string): void {
  db.prepare(
    'UPDATE task_candidates SET status = \'converted\', converted_task_id = ? WHERE candidate_id = ?',
  ).run(task, candidate)
}

function seedTask(
  db: DatabaseSync,
  task: string,
  status = 'discussing',
  mode = 'v1',
  project = 'p1',
): { candidate: string; snapshot: string; gate: string } {
  const candidate = `cand_${task}`
  const snapshot = `snap_${task}`
  const gate = `gate_${task}`
  insertProject(db, project)
  insertCandidate(db, candidate, project, 'awaiting_gate')
  insertSnapshot(db, candidate, snapshot, project)
  insertApproveGate(db, candidate, snapshot, gate)
  attachSnapshot(db, candidate, snapshot)
  insertTask(db, task, candidate, project, status, mode)
  convertCandidate(db, candidate, task)
  return { candidate, snapshot, gate }
}

function insertDecision(db: DatabaseSync, decision = 'd1', project = 'p1', key = 'decision-key'): void {
  db.prepare(
    `INSERT INTO decisions(
       decision_id, project_id, decision_key, title, subject_type,
       authority_scope, authority_level, problem, proposal, rationale,
       proposed_by, proposed_at, note_class, note_date, created_at, updated_at
     ) VALUES (?, ?, ?, ?, 'project', 'project', 'policy', 'problem', 'proposal', 'rationale',
       'u1', ?, 'architecture', '2026-11-08', ?, ?)`,
  ).run(decision, project, key, `decision ${decision}`, NOW, NOW, NOW)
}

function insertEvidence(db: DatabaseSync, decision = 'd1', evidence = 'e1'): void {
  db.prepare(
    `INSERT INTO decision_evidence(
       evidence_id, decision_id, kind, ref, verified_by, verified_at, content_hash, created_at
     ) VALUES (?, ?, 'test', ?, 'u1', ?, 'sha256:e1', ?)`,
  ).run(evidence, decision, `test:${evidence}`, NOW, NOW)
}

void test('schema 与契约快照逐项一致', () => {
  const db = fresh()
  assert.deepEqual(names(db, 'table'), [...TASK_TABLES].sort())
  assert.deepEqual(names(db, 'index'), TASK_INDEXES.map(index => index.name).sort())
  assert.deepEqual(names(db, 'trigger'), revisionTriggerNames().sort())
  db.close()
})

void test('user_version 记录 SCHEMA_VERSION，且旧版本会被拒绝', () => {
  const db = fresh()
  assert.equal(readUserVersion(db), SCHEMA_VERSION)
  assert.doesNotThrow(() => { assertSchemaVersion(db) })
  db.exec('PRAGMA user_version = 1')
  assert.throws(() => { assertSchemaVersion(db) }, new RegExp(`schema version 1 is not ${SCHEMA_VERSION}`))
  db.close()
})

void test('schema v2 upgrades by adding task_leases', () => {
  const db = fresh()
  db.exec('DROP TABLE task_leases')
  db.exec('PRAGMA user_version = 2')
  assert.doesNotThrow(() => { assertSchemaVersion(db) })
  assert.equal(readUserVersion(db), SCHEMA_VERSION)
  assert.ok(names(db, 'table').includes('task_leases'))
  db.close()
})

void test('global_revision 初始化为单行 0', () => {
  const db = fresh()
  const row = db.prepare('SELECT singleton, revision FROM global_revision').get() as { singleton: number; revision: number }
  assert.deepEqual({ ...row }, { singleton: 1, revision: 0 })
  insertProject(db)
  assert.equal((db.prepare('SELECT revision FROM global_revision').get() as { revision: number }).revision, 1)
  db.close()
})

void test('没有 Gate 时不能直接创建 Task', () => {
  const db = fresh()
  insertProject(db)
  insertCandidate(db, 'captured-only')
  assert.throws(() => { insertTask(db, 't1', 'captured-only') }, /CANDIDATE_GATE_REQUIRED/)
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM tasks').get() as { n: number }).n, 0)
  db.close()
})

void test('Gate、快照与 Candidate 版本必须一致，且同版本只能批准一次', () => {
  const db = fresh()
  insertProject(db)
  insertCandidate(db, 'c1', 'p1', 'awaiting_gate', 0)
  insertSnapshot(db, 'c1', 's1', 'p1', 0, 'sha256:s1')

  assert.throws(
    () =>{  insertApproveGate(db, 'c1', 's1', 'wrong-version', 1, 'sha256:s1') },
    /CANDIDATE_GATE_SNAPSHOT_MISMATCH/,
  )
  assert.throws(
    () =>{  insertApproveGate(db, 'c1', 's1', 'wrong-hash', 0, 'sha256:other') },
    /CANDIDATE_GATE_SNAPSHOT_MISMATCH/,
  )

  insertApproveGate(db, 'c1', 's1', 'g1', 0, 'sha256:s1')
  assert.throws(
    () =>{  insertApproveGate(db, 'c1', 's1', 'g2', 0, 'sha256:s1') },
    /UNIQUE constraint failed/,
  )
  assert.throws(
    () => db.prepare(
      `INSERT INTO candidate_gate_events(
         event_id, candidate_id, candidate_version, snapshot_id, snapshot_hash,
         action, actor_type, actor_id, decided_at, request_id,
         idempotency_key, payload_hash
       ) VALUES ('g3', 'c1', NULL, 's1', 'sha256:s1', 'approve', 'user', 'u1', ?, 'req:g3', 'idem:g1', 'payload:g3')`,
    ).run(NOW),
    /CANDIDATE_GATE_SNAPSHOT_MISMATCH|NOT NULL constraint failed/,
  )
  db.close()
})

void test('Candidate 转 converted 时按选择集逐条对账，不能只凑数量', () => {
  const db = fresh()
  insertProject(db)
  insertCandidate(db, 'c1', 'p1', 'awaiting_gate')
  insertSnapshot(db, 'c1', 's1')
  insertApproveGate(db, 'c1', 's1', 'g1')
  attachSnapshot(db, 'c1', 's1')
  insertTask(db, 't1', 'c1')

  insertDecision(db, 'd1', 'p1', 'key-1')
  insertDecision(db, 'd2', 'p1', 'key-2')
  db.prepare(
    `INSERT INTO admission_snapshot_selected_decisions(
       snapshot_id, decision_id, decision_status, collection_type, decision_version, selected_rank
     ) VALUES ('s1', 'd1', 'proposed', 'proposed', 0, 0), ('s1', 'd2', 'proposed', 'proposed', 0, 1)`,
  ).run()

  db.prepare(
    `INSERT INTO task_decision_links(
       link_id, task_id, decision_id, admission_snapshot_id, link_type,
       evidence_kind, evidence_ref, authority_epoch, active, version, created_by, created_at
     ) VALUES ('l1', 't1', 'd1', 's1', 'references', 'admission_snapshot', 's1', 0, 1, 1, 'tester', ?)`,
  ).run(NOW)

  assert.throws(() =>{  convertCandidate(db, 'c1', 't1') }, /CANDIDATE_DECISION_LINK_CLOSURE/)
  assert.equal(
    (db.prepare("SELECT status FROM task_candidates WHERE candidate_id = 'c1'").get() as { status: string }).status,
    'awaiting_gate',
  )

  db.prepare(
    `INSERT INTO task_decision_links(
       link_id, task_id, decision_id, admission_snapshot_id, link_type,
       evidence_kind, evidence_ref, authority_epoch, active, version, created_by, created_at
     ) VALUES ('l2', 't1', 'd2', 's1', 'references', 'admission_snapshot', 's1', 0, 1, 1, 'tester', ?)`,
  ).run(NOW)
  assert.doesNotThrow(() =>{  convertCandidate(db, 'c1', 't1') })
  db.close()
})

void test('未选中的 Decision 不能写 Task 链接，且活跃链接唯一', () => {
  const db = fresh()
  insertProject(db)
  insertCandidate(db, 'c1', 'p1', 'awaiting_gate')
  insertSnapshot(db, 'c1', 's1')
  insertApproveGate(db, 'c1', 's1', 'g1')
  attachSnapshot(db, 'c1', 's1')
  insertTask(db, 't1', 'c1')
  insertDecision(db, 'd1', 'p1', 'key-1')
  insertDecision(db, 'd2', 'p1', 'key-2')
  db.prepare(
    `INSERT INTO admission_snapshot_selected_decisions(
       snapshot_id, decision_id, decision_status, collection_type, decision_version, selected_rank
     ) VALUES ('s1', 'd1', 'proposed', 'proposed', 0, 0)`,
  ).run()

  const insertLink = db.prepare(
    `INSERT INTO task_decision_links(
       link_id, task_id, decision_id, admission_snapshot_id, link_type,
       evidence_kind, evidence_ref, authority_epoch, active, version, created_by, created_at
     ) VALUES (?, 't1', ?, 's1', 'references', 'admission_snapshot', 's1', 0, 1, 1, 'tester', ?)`,
  )
  assert.throws(() => insertLink.run('bad', 'd2', NOW), /DECISION_NOT_SELECTED/)
  insertLink.run('l1', 'd1', NOW)
  assert.throws(() => insertLink.run('l2', 'd1', NOW), /UNIQUE constraint failed/)
  db.close()
})

void test('链接引用快照选择集，而不是要求 Decision 仍是当时版本', () => {
  const db = fresh()
  insertProject(db)
  insertCandidate(db, 'c1', 'p1', 'awaiting_gate')
  insertSnapshot(db, 'c1', 's1')
  insertApproveGate(db, 'c1', 's1', 'g1')
  attachSnapshot(db, 'c1', 's1')
  insertTask(db, 't1', 'c1')
  insertDecision(db, 'd1', 'p1', 'key-1')
  db.prepare(
    `INSERT INTO admission_snapshot_selected_decisions(
       snapshot_id, decision_id, decision_status, collection_type, decision_version, selected_rank
     ) VALUES ('s1', 'd1', 'proposed', 'proposed', 0, 0)`,
  ).run()
  db.prepare("UPDATE decisions SET version = 7 WHERE decision_id = 'd1'").run()
  assert.doesNotThrow(() => {
    db.prepare(
      `INSERT INTO task_decision_links(
         link_id, task_id, decision_id, admission_snapshot_id, link_type,
         evidence_kind, evidence_ref, authority_epoch, active, version, created_by, created_at
       ) VALUES ('l1', 't1', 'd1', 's1', 'references', 'admission_snapshot', 's1', 0, 1, 1, 'tester', ?)`,
    ).run(NOW)
  })
  db.close()
})

void test('Decision 状态迁移、证据与批准字段冻结', () => {
  const db = fresh()
  insertProject(db)
  insertDecision(db, 'd1')

  assert.throws(
    () => db.prepare(
      `UPDATE decisions SET status = 'implemented', approved_by = 'u1',
       approved_at = ?, effective_from = ? WHERE decision_id = 'd1'`,
    ).run(NOW, NOW),
    /DECISION_EVIDENCE_REQUIRED/,
  )
  assert.throws(() => db.prepare("UPDATE decisions SET status = 'archived' WHERE decision_id = 'd1'").run(), /DECISION_INVALID_TRANSITION/)

  insertEvidence(db, 'd1')
  db.prepare(
    `UPDATE decisions SET status = 'implemented', approved_by = 'u1',
     approved_at = ?, effective_from = ? WHERE decision_id = 'd1'`,
  ).run(NOW, NOW)
  assert.throws(
    () => db.prepare("UPDATE decisions SET approved_by = 'u2' WHERE decision_id = 'd1'").run(),
    /DECISION_APPROVAL_IMMUTABLE/,
  )
  assert.throws(
    () => db.prepare("UPDATE decisions SET effective_to = '2027-01-01' WHERE decision_id = 'd1'").run(),
    /CHECK constraint failed|DECISION_APPROVAL_IMMUTABLE/,
  )
  insertDecision(db, 'd2', 'p1', 'decision-key')
  insertEvidence(db, 'd2', 'e2')
  assert.throws(
    () => db.prepare(
      `UPDATE decisions SET status = 'implemented', approved_by = 'u1',
       approved_at = ?, effective_from = ? WHERE decision_id = 'd2'`,
    ).run(NOW, NOW),
    /UNIQUE constraint failed/,
  )

  db.prepare("UPDATE decisions SET status = 'archived', archive_reason = 'obsolete' WHERE decision_id = 'd1'").run()
  assert.throws(() => db.prepare("UPDATE decisions SET status = 'proposed' WHERE decision_id = 'd1'").run(), /DECISION_INVALID_TRANSITION/)
  db.close()
})

void test('append-only 表拒绝 UPDATE/DELETE', () => {
  const db = fresh()
  insertProject(db)
  insertCandidate(db, 'c1', 'p1', 'awaiting_gate')
  insertSnapshot(db, 'c1', 's1')
  assert.throws(
    () => db.prepare("UPDATE admission_snapshots SET canonical_json = canonical_json WHERE snapshot_id = 's1'").run(),
    /APPEND_ONLY_TABLE/,
  )
  insertApproveGate(db, 'c1', 's1', 'g1')
  assert.throws(
    () => db.prepare("DELETE FROM candidate_gate_events WHERE event_id = 'g1'").run(),
    /APPEND_ONLY_TABLE/,
  )
  insertDecision(db, 'd1')
  insertEvidence(db, 'd1')
  assert.throws(
    () => db.prepare("UPDATE decision_evidence SET content_hash = 'changed' WHERE evidence_id = 'e1'").run(),
    /APPEND_ONLY_TABLE/,
  )
  db.close()
})

void test('生命周期 CHECK：模式与状态组合非法时拒绝写入', () => {
  const db = fresh()
  assert.throws(() => { seedTask(db, 't1', 'in_progress', 'p0') }, /CHECK constraint failed/)
  assert.throws(() => { seedTask(db, 't2', 'idea', 'nope') }, /CHECK constraint failed/)
  assert.doesNotThrow(() => { seedTask(db, 't3', 'closed', 'p0') })
  assert.doesNotThrow(() => { seedTask(db, 't4', 'blocked', 'v1') })
  db.close()
})

void test('Task 项目归属和来源 Candidate 不可变，且 REPLACE 不能绕过', () => {
  const db = fresh()
  seedTask(db, 't1')
  insertProject(db, 'p2')
  assert.throws(
    () => db.prepare("UPDATE tasks SET project_id = 'p2' WHERE task_id = 't1'").run(),
    /TASK_PROJECT_IMMUTABLE/,
  )
  assert.throws(
    () => db.prepare("UPDATE tasks SET source_candidate_id = 'other' WHERE task_id = 't1'").run(),
    /TASK_CANDIDATE_IMMUTABLE/,
  )
  assert.throws(
    () => db.prepare(
      `INSERT OR REPLACE INTO tasks(
         task_id, project_id, source_candidate_id, title, status, lifecycle_mode, created_at, updated_at
       ) VALUES ('t1', 'p1', 'other', 'replacement', 'discussing', 'v1', ?, ?)`,
    ).run(NOW, NOW),
    /TASK_ID_ALREADY_EXISTS|TASK_CANDIDATE_IMMUTABLE/,
  )
  db.close()
})

void test('删除 Project 被 RESTRICT 拒绝，不连带删除 Task', () => {
  const db = fresh()
  seedTask(db, 't1')
  assert.throws(
    () => db.prepare("DELETE FROM projects WHERE project_id = 'p1'").run(),
    /FOREIGN KEY constraint failed/,
  )
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM tasks').get() as { n: number }).n, 1)
  db.close()
})

void test('运行约束：同一任务至多一个活跃运行', () => {
  const db = fresh()
  seedTask(db, 't1')
  const insert = db.prepare(
    "INSERT INTO task_runs(link_id, task_id, role, status, linked_at) VALUES (?, 't1', 'main_execution', ?, 'n')",
  )
  insert.run('r1', 'pending')
  assert.throws(() => insert.run('r2', 'running'), /UNIQUE constraint failed/)
  db.prepare("UPDATE task_runs SET status = 'succeeded' WHERE link_id = 'r1'").run()
  assert.doesNotThrow(() => { insert.run('r3', 'pending') })
  db.close()
})

void test('运行约束：同一任务相同幂等键只能成功一次，空键不冲突', () => {
  const db = fresh()
  seedTask(db, 't1')
  const insert = db.prepare(
    `INSERT INTO task_runs(link_id, task_id, role, status, idempotency_key, linked_at)
     VALUES (?, 't1', 'main_execution', 'succeeded', ?, 'n')`,
  )
  insert.run('r1', 'k1')
  assert.throws(() => insert.run('r2', 'k1'), /UNIQUE constraint failed/)
  assert.doesNotThrow(() => { insert.run('r3', 'k2') })
  assert.doesNotThrow(() => { insert.run('r4', null) })
  assert.doesNotThrow(() => { insert.run('r5', null) })
  db.close()
})

void test('parent 关系由关系表做唯一事实源，拒绝伪造、跨项目和成环', () => {
  const db = fresh()
  seedTask(db, 'a')
  seedTask(db, 'b')
  seedTask(db, 'x', 'discussing', 'v1', 'p2')

  assert.throws(
    () => db.prepare("UPDATE tasks SET parent_task_id = 'a' WHERE task_id = 'b'").run(),
    /PARENT_CACHE_REQUIRES_RELATION/,
  )

  const insertParent = db.prepare(
    "INSERT INTO task_relations(relation_id, relation_type, source_task_id, target_task_id, created_at) VALUES (?, 'parent', ?, ?, 'n')",
  )
  assert.throws(() => insertParent.run('cross', 'x', 'a'), /RELATION_CROSS_PROJECT/)
  assert.doesNotThrow(() => { insertParent.run('rel1', 'b', 'a') })
  assert.equal(
    (db.prepare("SELECT parent_task_id FROM tasks WHERE task_id = 'b'").get() as { parent_task_id: string | null }).parent_task_id,
    'a',
  )
  assert.throws(() => insertParent.run('rel2', 'a', 'b'), /RELATION_CYCLE/)
  assert.throws(
    () => db.prepare("UPDATE task_relations SET relation_type = 'related' WHERE relation_id = 'rel1'").run(),
    /RELATION_IMMUTABLE/,
  )
  db.prepare("DELETE FROM task_relations WHERE relation_id = 'rel1'").run()
  assert.equal(
    (db.prepare("SELECT parent_task_id FROM tasks WHERE task_id = 'b'").get() as { parent_task_id: string | null }).parent_task_id,
    null,
  )
  db.close()
})

void test('schema SQL 覆盖全部表且以单换行结束', () => {
  for (const table of TASK_TABLES) assert.ok(TASK_SCHEMA_SQL.includes(`CREATE TABLE ${table} `), table)
  assert.ok(TASK_SCHEMA_SQL.endsWith(';\n'))
})
