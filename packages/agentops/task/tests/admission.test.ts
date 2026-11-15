import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'

import { createTaskSchema } from '../src/schema.ts'
import { TaskService, TaskServiceError } from '../src/service.ts'
import { ADMISSION_USER, admitCandidate } from './admission-fixture.ts'

const NOW = '2026-11-09T00:00:00Z'

function harness(): { db: DatabaseSync; service: TaskService } {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  createTaskSchema(db)
  const service = new TaskService(db, { now: () => NOW })
  service.createProject({ name: '订单后台', projectId: 'p1' })
  return { db, service }
}

function code(error: unknown): string {
  return error instanceof TaskServiceError ? error.code : 'not-a-service-error'
}

function insertDecision(
  db: DatabaseSync,
  decisionId: string,
  status: 'proposed' | 'implemented' | 'rejected' | 'archived',
): void {
  const approved = status === 'implemented' || status === 'archived'
  db.prepare(
    `INSERT INTO decisions(
       decision_id, project_id, decision_key, title, status, subject_type, subject_id,
       authority_scope, authority_level, problem, proposal, rationale, proposed_by,
       proposed_at, approved_by, approved_at, effective_from, reject_reason,
       archive_reason, note_class, note_date, version, created_at, updated_at)
     VALUES (?, 'p1', ?, ?, ?, 'project', '', 'project', 'policy', 'problem', 'proposal',
             'rationale', 'pm', ?, ?, ?, ?, ?, ?, 'process', ?, 0, ?, ?)`,
  ).run(
    decisionId,
    decisionId,
    decisionId,
    status,
    NOW,
    approved ? 'pm' : '',
    approved ? NOW : '',
    approved ? NOW : '',
    status === 'rejected' ? 'not viable' : '',
    status === 'archived' ? 'obsolete' : '',
    NOW,
    NOW,
    NOW,
  )
}

void test('直接建 Task 被关闭，返回 admission_required', () => {
  const h = harness()
  assert.throws(
    () => h.service.createTask({ projectId: 'p1', title: '绕过准入' }),
    (error: unknown) => {
      if (!(error instanceof TaskServiceError)) return false
      return error.code === 'admission_required' && error.httpStatus === 410
    },
  )
  assert.equal((h.db.prepare('SELECT COUNT(*) AS n FROM tasks').get() as { n: number }).n, 0)
  h.db.close()
})

void test('Candidate 分析状态推进，Snapshot 与 canonical hash 一致', () => {
  const h = harness()
  const candidate = h.service.captureCandidate({ projectId: 'p1', title: '导出', actor: ADMISSION_USER })
  assert.equal(candidate.status, 'captured')
  const analyzing = h.service.analyzeCandidate({ candidateId: candidate.candidateId, ifVersion: 0, actor: ADMISSION_USER })
  assert.equal(analyzing.status, 'analyzing')
  const awaiting = h.service.analyzeCandidate({ candidateId: candidate.candidateId, ifVersion: 1, actor: ADMISSION_USER })
  assert.equal(awaiting.status, 'awaiting_gate')
  const snapshot = h.service.createAdmissionSnapshot({
    candidateId: candidate.candidateId,
    ifVersion: 2,
    actor: ADMISSION_USER,
    query: { q: '导出' },
    searchCoverage: 'complete',
  })
  const row = h.db.prepare('SELECT canonical_json, snapshot_hash FROM admission_snapshots WHERE snapshot_id = ?')
    .get(snapshot.snapshotId) as { canonical_json: string; snapshot_hash: string }
  assert.equal(row.snapshot_hash, `sha256:${createHash('sha256').update(row.canonical_json, 'utf8').digest('hex')}`)
  assert.equal(h.service.getCandidate(candidate.candidateId).status, 'awaiting_gate')
  h.db.close()
})

void test('Decision 三集合互斥，selected 必须来自集合', () => {
  const h = harness()
  insertDecision(h.db, 'd1', 'proposed')
  insertDecision(h.db, 'd2', 'implemented')
  const candidate = h.service.captureCandidate({ projectId: 'p1', title: '导出', actor: ADMISSION_USER })
  h.service.analyzeCandidate({ candidateId: candidate.candidateId, ifVersion: 0, actor: ADMISSION_USER })
  h.service.analyzeCandidate({ candidateId: candidate.candidateId, ifVersion: 1, actor: ADMISSION_USER })
  assert.throws(
    () => h.service.createAdmissionSnapshot({
      candidateId: candidate.candidateId,
      ifVersion: 2,
      actor: ADMISSION_USER,
      query: {},
      searchCoverage: 'complete',
      proposedDecisionIds: ['d1'],
      authoritativeDecisionIds: ['d1'],
    }),
    (error: unknown) => code(error) === 'decision_validation_failed',
  )
  assert.throws(
    () => h.service.createAdmissionSnapshot({
      candidateId: candidate.candidateId,
      ifVersion: 2,
      actor: ADMISSION_USER,
      query: {},
      searchCoverage: 'complete',
      proposedDecisionIds: ['d1'],
      selectedDecisionIds: ['d2'],
    }),
    (error: unknown) => code(error) === 'decision_validation_failed',
  )
  h.db.close()
})

void test('零 selected Decision 合法，Gate 后 Task 与 Snapshot 双向对账', () => {
  const h = harness()
  const admitted = admitCandidate(h.service, { projectId: 'p1', title: '导出' })
  assert.equal(admitted.snapshot.selectedDecisionIds.length, 0)
  assert.equal(admitted.decisionLinkIds.length, 0)
  assert.equal(admitted.task.status, 'discussing')
  assert.equal(admitted.task.lifecycleMode, 'v1')
  const links = h.db.prepare('SELECT COUNT(*) AS n FROM task_decision_links WHERE task_id = ?').get(admitted.task.taskId) as { n: number }
  assert.equal(links.n, 0)
  h.db.close()
})

void test('selected Decision 必须与 Task links 完全闭合', () => {
  const h = harness()
  insertDecision(h.db, 'd1', 'proposed')
  const candidate = h.service.captureCandidate({ projectId: 'p1', title: '导出', actor: ADMISSION_USER })
  h.service.analyzeCandidate({ candidateId: candidate.candidateId, ifVersion: 0, actor: ADMISSION_USER })
  h.service.analyzeCandidate({ candidateId: candidate.candidateId, ifVersion: 1, actor: ADMISSION_USER })
  h.service.createAdmissionSnapshot({
    candidateId: candidate.candidateId,
    ifVersion: 2,
    actor: ADMISSION_USER,
    query: {},
    searchCoverage: 'complete',
    proposedDecisionIds: ['d1'],
    selectedDecisionIds: ['d1'],
  })
  const admitted = h.service.approveCandidateGate({ candidateId: candidate.candidateId, ifVersion: 3, actor: ADMISSION_USER })
  assert.equal(admitted.decisionLinkIds.length, 1)
  const selected = h.db.prepare('SELECT decision_id FROM admission_snapshot_selected_decisions WHERE snapshot_id = ?').all(admitted.snapshot.snapshotId)
  const linked = h.db.prepare('SELECT decision_id FROM task_decision_links WHERE task_id = ? AND active = 1').all(admitted.task.taskId)
  assert.deepEqual(selected, linked)
  h.db.close()
})

void test('重复 approve 幂等返回同一 Task；converted 不重复建单', () => {
  const h = harness()
  const candidate = h.service.captureCandidate({ projectId: 'p1', title: '导出', actor: ADMISSION_USER })
  h.service.analyzeCandidate({ candidateId: candidate.candidateId, ifVersion: 0, actor: ADMISSION_USER })
  h.service.analyzeCandidate({ candidateId: candidate.candidateId, ifVersion: 1, actor: ADMISSION_USER })
  h.service.createAdmissionSnapshot({ candidateId: candidate.candidateId, ifVersion: 2, actor: ADMISSION_USER, query: {}, searchCoverage: 'complete' })
  const first = h.service.approveCandidateGate({ candidateId: candidate.candidateId, ifVersion: 3, actor: ADMISSION_USER })
  const again = h.service.approveCandidateGate({ candidateId: candidate.candidateId, ifVersion: 99, actor: ADMISSION_USER })
  assert.equal(again.task.taskId, first.task.taskId)
  assert.equal((h.db.prepare('SELECT COUNT(*) AS n FROM tasks').get() as { n: number }).n, 1)
  h.db.close()
})

void test('普通 agent 不能首次批准 Gate；失败后 Candidate 仍 await_gate', () => {
  const h = harness()
  const candidate = h.service.captureCandidate({ projectId: 'p1', title: '导出', actor: ADMISSION_USER })
  h.service.analyzeCandidate({ candidateId: candidate.candidateId, ifVersion: 0, actor: ADMISSION_USER })
  h.service.analyzeCandidate({ candidateId: candidate.candidateId, ifVersion: 1, actor: ADMISSION_USER })
  h.service.createAdmissionSnapshot({ candidateId: candidate.candidateId, ifVersion: 2, actor: ADMISSION_USER, query: {}, searchCoverage: 'complete' })
  assert.throws(
    () => h.service.approveCandidateGate({ candidateId: candidate.candidateId, ifVersion: 3, actor: { type: 'agent', name: 'coding_agent' } }),
    (error: unknown) => code(error) === 'user_approval_required',
  )
  assert.throws(
    () => h.service.approveCandidateGate({ candidateId: candidate.candidateId, ifVersion: 2, actor: ADMISSION_USER }),
    (error: unknown) => code(error) === 'version_conflict',
  )
  assert.equal(h.service.getCandidate(candidate.candidateId).status, 'awaiting_gate')
  h.db.close()
})

void test('Decision 状态机与证据硬约束不被测试绕过', () => {
  const h = harness()
  insertDecision(h.db, 'd1', 'proposed')
  assert.throws(
    () => h.db.prepare("UPDATE decisions SET status = 'implemented' WHERE decision_id = 'd1'").run(),
    /DECISION_EVIDENCE_REQUIRED/,
  )
  insertDecision(h.db, 'd2', 'rejected')
  assert.ok((h.db.prepare("SELECT reject_reason FROM decisions WHERE decision_id = 'd2'").get() as { reject_reason: string }).reject_reason.length > 0)
  h.db.close()
})
