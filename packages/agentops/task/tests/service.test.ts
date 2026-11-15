/**
 * TaskService tests: lifecycle edges, optimistic locking, approval ownership,
 * thread claiming, rollback aliases and the close gates.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'

import { createTaskSchema } from '../src/schema.ts'
import { TaskService, TaskServiceError } from '../src/service.ts'
import { createAdmittedTask } from './admission-fixture.ts'

const NOW = '2026-11-07T00:00:00Z'

interface Harness {
  db: DatabaseSync
  service: TaskService
  projectId: string
  revision: () => number
}

function harness(): Harness {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  createTaskSchema(db)
  let counter = 0
  const service = new TaskService(db, { now: () => NOW, newId: () => `id${(counter += 1)}` })
  const projectId = service.createProject({ name: '订单后台', projectId: 'p1', localPath: process.cwd() })
  return {
    db,
    service,
    projectId,
    revision: () => (db.prepare('SELECT revision FROM global_revision').get() as { revision: number }).revision,
  }
}

function user(): { type: 'user'; name: string } {
  return { type: 'user', name: 'pm' }
}

function agent(): { type: 'agent'; name: string } {
  return { type: 'agent', name: 'coding_agent' }
}

function code(error: unknown): string {
  return error instanceof TaskServiceError ? error.code : 'not-a-service-error'
}

void test('Candidate gate 准入默认 v1/discussing/v0，并写 admitted 事件', () => {
  const h = harness()
  const task = createAdmittedTask(h.service, { projectId: h.projectId, title: '修复导出按钮' })
  assert.equal(task.status, 'discussing')
  assert.equal(task.lifecycleMode, 'v1')
  assert.equal(task.version, 0)
  const events = h.db.prepare('SELECT event_type FROM task_events WHERE task_id = ?').all(task.taskId) as {
    event_type: string
  }[]
  assert.deepEqual(events.map(row => row.event_type), ['admitted'])
  assert.ok(h.revision() > 0)
  h.db.close()
})

void test('advance：需用户确认的边拒绝 agent，允许 user 并递增版本', () => {
  const h = harness()
  const task = createAdmittedTask(h.service, { projectId: h.projectId, title: 't', status: 'reviewing' })
  assert.throws(() => h.service.advance({ taskId: task.taskId, to: 'discussing', ifVersion: task.version, actor: agent() }), (error: unknown) => code(error) === 'user_approval_required')
  const advanced = h.service.advance({ taskId: task.taskId, to: 'discussing', ifVersion: task.version, actor: user() })
  assert.equal(advanced.status, 'discussing')
  assert.equal(advanced.version, task.version + 1)
  h.db.close()
})

void test('advance：陈旧版本返回 version_conflict 并带最新记录', () => {
  const h = harness()
  const task = createAdmittedTask(h.service, { projectId: h.projectId, title: 't' })
  h.service.advance({ taskId: task.taskId, to: 'decomposing', ifVersion: task.version, actor: user() })
  assert.throws(
    () => h.service.advance({ taskId: task.taskId, to: 'reviewing', ifVersion: task.version, actor: user() }),
    (error: unknown) => {
      if (!(error instanceof TaskServiceError)) return false
      return error.code === 'version_conflict' && error.httpStatus === 409 && (error.details.latest as { version: number }).version === task.version + 1
    },
  )
  h.db.close()
})

void test('advance：不存在的边返回 invalid_transition', () => {
  const h = harness()
  const task = createAdmittedTask(h.service, { projectId: h.projectId, title: 't' })
  assert.throws(
    () => h.service.advance({ taskId: task.taskId, to: 'in_progress', ifVersion: task.version, actor: user() }),
    (error: unknown) => code(error) === 'invalid_transition',
  )
  h.db.close()
})

void test('claim：绑定、幂等与冲突', () => {
  const h = harness()
  const task = createAdmittedTask(h.service, { projectId: h.projectId, title: 't' })
  const claimed = h.service.claim({ taskId: task.taskId, threadId: 'thread-a', ifVersion: task.version, actor: agent() })
  assert.equal(claimed.threadId, 'thread-a')
  assert.equal(claimed.version, task.version + 1)
  const again = h.service.claim({ taskId: task.taskId, threadId: 'thread-a', ifVersion: claimed.version, actor: agent() })
  assert.equal(again.version, claimed.version)
  assert.throws(
    () => h.service.claim({ taskId: task.taskId, threadId: 'thread-b', ifVersion: claimed.version, actor: agent() }),
    (error: unknown) => code(error) === 'thread_conflict',
  )
  assert.throws(
    () => h.service.claim({ taskId: task.taskId, threadId: '  ', ifVersion: claimed.version, actor: agent() }),
    (error: unknown) => code(error) === 'invalid_request',
  )
  h.db.close()
})

void test('rollback：别名映射，显式 targetStatus 优先', () => {
  const h = harness()
  const task = createAdmittedTask(h.service, { projectId: h.projectId, title: 't', status: 'validating' })
  const rolled = h.service.rollback({ taskId: task.taskId, alias: 'local', reason: '修复不完整', ifVersion: task.version, actor: user() })
  assert.equal(rolled.status, 'in_progress')
  const events = h.db.prepare("SELECT payload FROM task_events WHERE event_type = 'rolled_back'").all() as {
    payload: string
  }[]
  assert.match((JSON.parse(events[0]!.payload) as { reason: string }).reason, /修复不完整/)

  const task2 = createAdmittedTask(h.service, { projectId: h.projectId, title: 't2', status: 'validating' })
  const explicit = h.service.rollback({
    taskId: task2.taskId,
    alias: 'global',
    targetStatus: 'discussing',
    reason: '方案错',
    ifVersion: task2.version,
    actor: user(),
  })
  assert.equal(explicit.status, 'discussing')
  h.db.close()
})

void test('close：验收未通过时返回 close_blocked 并列出阻塞项', () => {
  const h = harness()
  const task = createAdmittedTask(h.service, { projectId: h.projectId, title: 't', status: 'validating' })
  h.db
    .prepare("INSERT INTO acceptance_criteria(criteria_id, task_id, description) VALUES ('c1', ?, '导出不重复')")
    .run(task.taskId)
  assert.throws(
    () => h.service.close({ taskId: task.taskId, ifVersion: task.version, actor: user() }),
    (error: unknown) => {
      if (!(error instanceof TaskServiceError)) return false
      const blockers = error.details.blockers as string[]
      return error.code === 'close_blocked' && blockers.some(blocker => blocker.startsWith('criteria:c1:pending'))
    },
  )
  h.db.prepare("UPDATE acceptance_criteria SET status = 'passed' WHERE criteria_id = 'c1'").run()
  const closed = h.service.close({ taskId: task.taskId, ifVersion: task.version, actor: user() })
  assert.equal(closed.status, 'closed')
  assert.equal(closed.version, task.version + 1)
  assert.notEqual(closed.closedAt, null)
  h.db.close()
})

void test('close：agent 不能关闭，P0 任务不能走 close', () => {
  const h = harness()
  const task = createAdmittedTask(h.service, { projectId: h.projectId, title: 't', status: 'validating' })
  assert.throws(
    () => h.service.close({ taskId: task.taskId, ifVersion: task.version, actor: agent() }),
    (error: unknown) => code(error) === 'user_approval_required',
  )
  const p0 = createAdmittedTask(h.service, { projectId: h.projectId, title: 'p0', lifecycleMode: 'p0' })
  assert.throws(
    () => h.service.close({ taskId: p0.taskId, ifVersion: p0.version, actor: user() }),
    (error: unknown) => code(error) === 'invalid_request',
  )
  h.db.close()
})

void test('P0 模式：只认五状态与九条边', () => {
  const h = harness()
  const task = createAdmittedTask(h.service, { projectId: h.projectId, title: 'p0', lifecycleMode: 'p0' })
  const advanced = h.service.advance({ taskId: task.taskId, to: 'backlog', ifVersion: task.version, actor: agent() })
  assert.equal(advanced.status, 'backlog')
  assert.throws(
    () => h.service.advance({ taskId: task.taskId, to: 'in_progress', ifVersion: advanced.version, actor: user() }),
    (error: unknown) => code(error) === 'invalid_transition',
  )
  const allowed = h.service.getTask(task.taskId).allowed
  assert.deepEqual(allowed.map(entry => entry.to).sort(), ['closed', 'discussing'])
  h.db.close()
})

void test('直接创建任务被拒绝，Candidate 捕获校验项目存在', () => {
  const h = harness()
  assert.throws(
    () => h.service.createTask({ projectId: 'missing', title: 't' }),
    (error: unknown) => code(error) === 'admission_required',
  )
  assert.throws(
    () => h.service.captureCandidate({ projectId: 'missing', title: 't', actor: user() }),
    (error: unknown) => code(error) === 'project_not_found',
  )
  h.db.close()
})

void test('addComment：正文、mention 白名单与 review 决定校验', () => {
  const h = harness()
  const task = createAdmittedTask(h.service, { projectId: h.projectId, title: 't' })
  const comment = h.service.addComment({
    taskId: task.taskId,
    body: '开始处理',
    ifVersion: task.version,
    actor: agent(),
    mentions: ['coding_agent'],
  })
  assert.equal(comment.commentType, 'discussion')
  assert.throws(
    () => h.service.addComment({ taskId: task.taskId, body: 'x', ifVersion: task.version + 1, actor: user(), mentions: ['task_dispatcher'] }),
    (error: unknown) => code(error) === 'invalid_request',
  )
  assert.throws(
    () => h.service.addComment({ taskId: task.taskId, body: 'x', ifVersion: task.version + 1, actor: user(), decision: 'approve' }),
    (error: unknown) => code(error) === 'invalid_request',
  )
  h.db.close()
})

void test('request_changes 先写 review 评论再回退', () => {
  const h = harness()
  const task = createAdmittedTask(h.service, { projectId: h.projectId, title: 't', status: 'validating' })
  const comment = h.service.addComment({
    taskId: task.taskId,
    body: '失败分支没恢复按钮',
    commentType: 'review',
    decision: 'request_changes',
    rollbackTarget: 'in_progress',
    ifVersion: task.version,
    actor: user(),
  })
  assert.equal(comment.decision, 'request_changes')
  const current = h.service.getTask(task.taskId).task
  assert.equal(current.status, 'in_progress')
  assert.equal(current.version, task.version + 2)
  h.db.close()
})

void test('回退目标非法时评论保留并返回 rollback_failed', () => {
  const h = harness()
  const task = createAdmittedTask(h.service, { projectId: h.projectId, title: 't', status: 'validating' })
  assert.throws(
    () => h.service.addComment({
      taskId: task.taskId,
      body: '请求修改',
      commentType: 'review',
      decision: 'request_changes',
      rollbackTarget: 'closed',
      ifVersion: task.version,
      actor: user(),
    }),
    (error: unknown) => {
      if (!(error instanceof TaskServiceError)) return false
      return error.code === 'rollback_failed' && typeof error.details.commentId === 'string'
    },
  )
  const comments = h.db.prepare('SELECT COUNT(*) AS n FROM task_comments').get() as { n: number }
  assert.equal(comments.n, 1)
  assert.equal(h.service.getTask(task.taskId).task.status, 'validating')
  h.db.close()
})

void test('criteria：新增与置为 passed', () => {
  const h = harness()
  const task = createAdmittedTask(h.service, { projectId: h.projectId, title: 't', status: 'validating' })
  const criteria = h.service.addCriteria({ taskId: task.taskId, description: '导出不重复', ifVersion: task.version, actor: user() })
  assert.equal(criteria.status, 'pending')
  const passed = h.service.setCriteriaStatus({
    taskId: task.taskId,
    criteriaId: criteria.criteriaId,
    status: 'passed',
    ifVersion: h.service.getTask(task.taskId).task.version,
    actor: user(),
  })
  assert.equal(passed.status, 'passed')
  assert.throws(
    () => h.service.setCriteriaStatus({
      taskId: task.taskId,
      criteriaId: 'missing',
      status: 'passed',
      ifVersion: h.service.getTask(task.taskId).task.version,
      actor: user(),
    }),
    (error: unknown) => code(error) === 'invalid_request',
  )
  h.db.close()
})

void test('报告：提交、自批拒绝与用户审批', () => {
  const h = harness()
  const task = createAdmittedTask(h.service, { projectId: h.projectId, title: 't', status: 'in_progress' })
  assert.throws(
    () => h.service.submitReport({ taskId: task.taskId, content: '   ', ifVersion: task.version, actor: agent() }),
    (error: unknown) => code(error) === 'invalid_request',
  )
  const report = h.service.submitReport({
    taskId: task.taskId,
    content: '已修复导出按钮',
    agentId: 'coding_agent',
    acceptanceSelfCheck: { passed: true },
    ifVersion: task.version,
    actor: agent(),
  })
  assert.equal(report.status, 'submitted')
  assert.deepEqual(report.acceptanceSelfCheck, { passed: true })
  assert.throws(
    () => h.service.reviewReport({ taskId: task.taskId, reportId: report.reportId, decision: 'approve', comment: 'ok', ifVersion: h.service.getTask(task.taskId).task.version, actor: agent() }),
    (error: unknown) => code(error) === 'user_approval_required',
  )
  const approved = h.service.reviewReport({
    taskId: task.taskId,
    reportId: report.reportId,
    decision: 'approve',
    comment: '通过',
    ifVersion: h.service.getTask(task.taskId).task.version,
    actor: user(),
  })
  assert.equal(approved.status, 'approved')
  h.db.close()
})

void test('关系：parent 同步 parent_task_id，成环被拒绝', () => {
  const h = harness()
  const a = createAdmittedTask(h.service, { projectId: h.projectId, title: 'a', status: 'backlog' })
  const b = createAdmittedTask(h.service, { projectId: h.projectId, title: 'b', status: 'backlog' })
  h.service.addRelation({ taskId: a.taskId, relationType: 'parent', targetTaskId: b.taskId, ifVersion: a.version, actor: user() })
  const child = h.db.prepare('SELECT parent_task_id FROM tasks WHERE task_id = ?').get(a.taskId) as { parent_task_id: string }
  assert.equal(child.parent_task_id, b.taskId)
  assert.throws(
    () => { h.service.addRelation({ taskId: b.taskId, relationType: 'parent', targetTaskId: a.taskId, ifVersion: b.version, actor: user() }) },
    (error: unknown) => code(error) === 'relation_cycle',
  )
  h.db.close()
})

void test('执行：幂等键、单活跃运行、终态与状态门禁', () => {
  const h = harness()
  const idea = createAdmittedTask(h.service, { projectId: h.projectId, title: 'idea' })
  assert.throws(
    () => h.service.execute({ taskId: idea.taskId, ifVersion: idea.version, actor: agent() }),
    (error: unknown) => code(error) === 'invalid_transition',
  )
  const task = createAdmittedTask(h.service, { projectId: h.projectId, title: 't', status: 'backlog' })
  const run = h.service.execute({ taskId: task.taskId, idempotencyKey: 'k1', ifVersion: task.version, actor: agent() })
  assert.equal(run.status, 'pending')
  const again = h.service.execute({ taskId: task.taskId, idempotencyKey: 'k1', ifVersion: task.version, actor: agent() })
  assert.equal(again.linkId, run.linkId)
  assert.throws(
    () => h.service.execute({ taskId: task.taskId, ifVersion: task.version + 1, actor: agent() }),
    (error: unknown) => code(error) === 'active_run_conflict',
  )
  const done = h.service.finishRun({ taskId: task.taskId, linkId: run.linkId, status: 'succeeded', actor: agent() })
  assert.equal(done.status, 'succeeded')
  assert.throws(
    () => h.service.finishRun({ taskId: task.taskId, linkId: run.linkId, status: 'failed', actor: agent() }),
    (error: unknown) => code(error) === 'invalid_request',
  )
  const second = h.service.execute({ taskId: task.taskId, ifVersion: task.version + 2, actor: agent() })
  assert.notEqual(second.linkId, run.linkId)
  assert.equal(h.service.listRuns(task.taskId).length, 2)
  h.db.close()
})
