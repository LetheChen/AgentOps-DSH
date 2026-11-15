/**
 * Service-backed tool tests: the model-facing surface must refuse gated edges,
 * report structured failures, and never bypass `TaskService`.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'

import { createTaskSchema } from '../src/schema.ts'
import { TaskService } from '../src/service.ts'
import { createServiceTaskTools } from '../src/tools-v1.ts'
import { apply as mountApply, TOOL_NAMES as mountToolNames } from '../src/tools-mount-v1.ts'
import { ADMISSION_USER, createAdmittedTask } from './admission-fixture.ts'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'

interface Harness {
  service: TaskService
  db: DatabaseSync
  call: (name: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>
  close: () => void
}

function harness(): Harness {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  createTaskSchema(db)
  const service = new TaskService(db, { now: () => '2026-11-07T00:00:00Z' })
  service.createProject({ name: '订单后台', projectId: 'p1' })
  const tools = createServiceTaskTools(service)
  const call = async (name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const tool = tools.find(candidate => candidate.name === name)
    if (tool === undefined) throw new Error(`tool ${name} not found`)
    const result = await tool.execute(args, {
      deferContext: () => undefined,
      concludeTurn: () => undefined,
      rootCallId: 'test-call' as never,
      callId: 'test-call' as never,
      token: Symbol('test-call') as never,
      name: 'test-tool',
      arguments: args,
      signal: new AbortController().signal,
    } satisfies ToolRunContext)
    return result as Record<string, unknown>
  }
  return { service, db, call, close: () => { db.close() } }
}

void test('candidate_create 只捕获 Candidate，不直接创建 Task', async () => {
  const h = harness()
  const created = await h.call('candidate_create', { projectId: 'p1', title: '修复导出按钮' })
  assert.equal(created.ok, true)
  assert.equal((created.candidate as { status: string }).status, 'captured')
  const listed = await h.call('task_list', { projectId: 'p1' })
  assert.equal((listed.tasks as unknown[]).length, 0)
  assert.equal(listed.total, 0)
  h.close()
})

void test('task_advance：agent 被 requires_user 边拒绝，返回结构化 code', async () => {
  const h = harness()
  const task = createAdmittedTask(h.service, { projectId: 'p1', title: 't', status: 'reviewing' })
  const refused = await h.call('task_advance', { id: task.taskId, to: 'discussing', expectedVersion: task.version })
  assert.equal(refused.ok, false)
  assert.equal(refused.code, 'user_approval_required')
  h.close()
})

void test('task_claim 与 task_comment', async () => {
  const h = harness()
  const task = createAdmittedTask(h.service, { projectId: 'p1', title: 't', status: 'in_progress' })
  const claimed = await h.call('task_claim', { id: task.taskId, threadId: 'thread-a', expectedVersion: task.version })
  assert.equal(claimed.ok, true)
  const comment = await h.call('task_comment', {
    id: task.taskId,
    body: '开始处理',
    expectedVersion: h.service.getTask(task.taskId).task.version,
  })
  assert.equal(comment.ok, true)
  h.close()
})

void test('task_validate 与 task_report_submit', async () => {
  const h = harness()
  const task = createAdmittedTask(h.service, { projectId: 'p1', title: 't', status: 'validating' })
  h.service.addCriteria({
    taskId: task.taskId,
    description: '导出不重复',
    ifVersion: h.service.getTask(task.taskId).task.version,
    actor: ADMISSION_USER,
  })
  const criteriaId = (h.db
    .prepare('SELECT criteria_id FROM acceptance_criteria WHERE task_id = ?')
    .get(task.taskId) as { criteria_id: string }).criteria_id

  const validation = await h.call('task_validate', {
    id: task.taskId,
    criteriaId,
    status: 'passed',
    expectedVersion: h.service.getTask(task.taskId).task.version,
  })
  assert.equal(validation.ok, true)

  const report = await h.call('task_report_submit', {
    id: task.taskId,
    content: '已修复',
    expectedVersion: h.service.getTask(task.taskId).task.version,
  })
  assert.equal(report.ok, true)
  assert.match(String(report.reportId), /^rep_/)
  h.close()
})

void test('task_rollback：需要用户确认的目标被拒绝', async () => {
  const h = harness()
  const task = createAdmittedTask(h.service, { projectId: 'p1', title: 't', status: 'validating' })
  const refused = await h.call('task_rollback', {
    id: task.taskId,
    targetStatus: 'in_progress',
    reason: '失败分支未恢复',
    expectedVersion: task.version,
  })
  assert.equal(refused.ok, false)
  assert.equal(refused.code, 'user_approval_required')
  assert.equal(h.service.getTask(task.taskId).task.status, 'validating')
  h.close()
})

void test('idea_capture 与 idea_triage：bot/agent 捕获与 task_inbox 就绪', async () => {
  const h = harness()
  const captured = await h.call('idea_capture', {
    channel: 'manual',
    kind: 'requirement',
    projectId: 'p1',
    content: '导出按钮重复点击',
  })
  assert.equal(captured.ok, true)
  const idea = captured.idea as { ideaId: string; status: string }
  assert.equal(idea.status, 'captured')

  const ready = await h.call('idea_triage', {
    ideaId: idea.ideaId,
    action: 'ready',
  })
  assert.equal(ready.ok, true)
  assert.equal((ready.idea as { status: string }).status, 'ready')

  const listed = await h.call('idea_list', { status: 'ready' })
  assert.equal((listed.ideas as unknown[]).length, 1)
  h.close()
})

void test('idea_triage：bot 捕获的记录需要用户，工具拒绝', async () => {
  const h = harness()
  const captured = await h.call('idea_capture', { channel: 'bot', content: '群里提到的需求' })
  const idea = captured.idea as { ideaId: string }
  const refused = await h.call('idea_triage', { ideaId: idea.ideaId, action: 'classify', kind: 'requirement' })
  assert.equal(refused.ok, false)
  assert.equal(refused.code, 'user_approval_required')
  h.close()
})

void test('tools-v1 挂载：注册全部工具，only 过滤且未知名报错', () => {
  const registered: string[] = []
  const ctx = { tools: { register: (def: { name: string }) => { registered.push(def.name); return () => {} } } }
  mountApply(ctx as never, { dbPath: ':memory:' })
  assert.deepEqual(registered.sort(), [...mountToolNames].sort())
  assert.equal(registered.length, 17)

  const filtered: string[] = []
  const ctx2 = { tools: { register: (def: { name: string }) => { filtered.push(def.name); return () => {} } } }
  mountApply(ctx2 as never, { dbPath: ':memory:', only: ['idea_capture', 'task_list'] })
  assert.deepEqual(filtered.sort(), ['idea_capture', 'task_list'])

  assert.throws(
    () => { mountApply(ctx as never, { dbPath: ':memory:', only: ['nope'] }) },
    /does not register/,
  )
})

void test('tools-v1 的摘要在空库上可用', async () => {
  const registered: { name: string; execute: (args: never, ctx: never) => Promise<unknown> }[] = []
  const ctx = {
    tools: {
      register: (def: { name: string; execute: (args: never, ctx: never) => Promise<unknown> }) => {
        registered.push(def)
        return () => {}
      },
    },
  }
  mountApply(ctx as never, { dbPath: ':memory:' })
  const list = registered.find(tool => tool.name === 'idea_list')
  assert.ok(list !== undefined)
  const result = await list.execute({} as never, {} as never) as { ideas: unknown[]; total: number }
  assert.equal(result.total, 0)
})

void test('Decision tools: agent can propose, revise, search and read but cannot approve', async () => {
  const h = harness()
  const proposed = await h.call('decision_propose', {
    projectId: 'p1',
    decisionId: 'd1',
    decisionKey: 'task-admission-gate',
    title: 'Admission gate',
    subjectType: 'project',
    authorityScope: 'project',
    authorityLevel: 'policy',
    problem: 'Draft tasks bypass analysis.',
    proposal: 'Candidates must pass a gate.',
    rationale: 'Preserve lifecycle quality.',
    noteClass: 'architecture',
  })
  assert.equal(proposed.ok, true)
  assert.equal((proposed.decision as { status: string }).status, 'proposed')

  const revised = await h.call('decision_revise', {
    decisionId: 'd1',
    expectedVersion: 0,
    title: 'Admission gate v2',
  })
  assert.equal(revised.ok, true)
  assert.equal((revised.decision as { version: number }).version, 1)

  const searched = await h.call('decision_search', { projectId: 'p1', collection: 'proposed' })
  assert.equal(searched.ok, true)
  assert.equal((searched.result as { total: number }).total, 1)

  const detail = await h.call('decision_get', { decisionId: 'd1' })
  assert.equal(detail.ok, true)
  assert.equal((detail.detail as { decision: { title: string } }).decision.title, 'Admission gate v2')

  const names = createServiceTaskTools(h.service).map(tool => tool.name)
  for (const forbidden of ['decision_implement', 'decision_reject', 'decision_archive', 'decision_supersede']) {
    assert.equal(names.includes(forbidden), false)
  }
  h.close()
})
