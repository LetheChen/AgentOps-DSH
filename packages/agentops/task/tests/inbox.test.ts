/**
 * Inbox tests: capture idempotency, source-system allowlist and triage gates.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'

import { createTaskSchema } from '../src/schema.ts'
import { TaskService, TaskServiceError } from '../src/service.ts'

const NOW = '2026-11-07T00:00:00Z'
const USER = { type: 'user', name: 'pm' } as const
const AGENT = { type: 'agent', name: 'coding_agent' } as const

function harness(options: { allowedSourceSystems?: string[] } = {}): {
  service: TaskService
  db: DatabaseSync
  close: () => void
} {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  createTaskSchema(db)
  const service = new TaskService(db, {
    now: () => NOW,
    ...(options.allowedSourceSystems === undefined ? {} : { allowedSourceSystems: options.allowedSourceSystems }),
  })
  service.createProject({ name: '订单后台', projectId: 'p1' })
  service.createProject({ name: '第二个项目', projectId: 'p2' })
  return { service, db, close: () => { db.close() } }
}

function code(error: unknown): string {
  return error instanceof TaskServiceError ? error.code : 'not-a-service-error'
}

void test('手动采集：默认 captured，三轴齐全', () => {
  const h = harness()
  const idea = h.service.captureIdea({ channel: 'manual', content: '加个导出', actor: USER })
  assert.equal(idea.status, 'captured')
  assert.equal(idea.channel, 'manual')
  assert.equal(idea.kind, 'idea')
  assert.equal(idea.revision, 1)
  h.close()
})

void test('自动采集：同 content_hash 幂等，不同内容产生新记录', () => {
  const h = harness()
  const first = h.service.captureIdea({
    channel: 'connector',
    sourceSystem: 'github',
    sourceRef: 'issue#42',
    contentHash: 'h1',
    content: '导出按钮重复点击',
    actor: AGENT,
  })
  const again = h.service.captureIdea({
    channel: 'connector',
    sourceSystem: 'github',
    sourceRef: 'issue#42',
    contentHash: 'h1',
    content: '导出按钮重复点击',
    actor: AGENT,
  })
  assert.equal(again.ideaId, first.ideaId)
  const changed = h.service.captureIdea({
    channel: 'connector',
    sourceSystem: 'github',
    sourceRef: 'issue#42',
    contentHash: 'h2',
    content: '导出按钮重复点击（补充失败分支）',
    actor: AGENT,
  })
  assert.notEqual(changed.ideaId, first.ideaId)
  h.close()
})

void test('source_system 必须命中配置允许列表', () => {
  const h = harness()
  assert.throws(
    () => h.service.captureIdea({ channel: 'connector', sourceSystem: 'unknown', content: 'x', actor: AGENT }),
    (error: unknown) => code(error) === 'invalid_request',
  )
  const custom = harness({ allowedSourceSystems: ['github', 'tianyancha'] })
  const idea = custom.service.captureIdea({
    channel: 'connector',
    sourceSystem: 'tianyancha',
    sourceRef: 'company-1',
    contentHash: 'h1',
    content: '风险信息',
    actor: AGENT,
  })
  assert.equal(idea.sourceSystem, 'tianyancha')
  custom.close()
  h.close()
})

void test('分诊门槛：doc 不能 ready，bot 记录需要用户分诊', () => {
  const h = harness()
  const doc = h.service.captureIdea({
    channel: 'manual',
    kind: 'doc',
    projectId: 'p1',
    content: '设计文档',
    actor: USER,
  })
  assert.throws(
    () => h.service.triageIdea({ ideaId: doc.ideaId, action: 'ready', actor: USER }),
    (error: unknown) => code(error) === 'invalid_request',
  )

  const bot = h.service.captureIdea({ channel: 'bot', content: '群里说的需求', actor: AGENT })
  assert.throws(
    () => h.service.triageIdea({ ideaId: bot.ideaId, action: 'classify', actor: AGENT }),
    (error: unknown) => code(error) === 'user_approval_required',
  )
  const classified = h.service.triageIdea({
    ideaId: bot.ideaId,
    action: 'classify',
    kind: 'requirement',
    projectId: 'p1',
    actor: USER,
  })
  assert.equal(classified.status, 'triaged')
  const ready = h.service.triageIdea({ ideaId: bot.ideaId, action: 'ready', actor: USER })
  assert.equal(ready.status, 'ready')
  h.close()
})

void test('ready 需要项目；忽略后不能再转换', () => {
  const h = harness()
  const idea = h.service.captureIdea({ channel: 'manual', kind: 'bug', content: '崩溃', actor: USER })
  assert.throws(
    () => h.service.triageIdea({ ideaId: idea.ideaId, action: 'ready', actor: USER }),
    (error: unknown) => code(error) === 'invalid_request',
  )
  const ignored = h.service.triageIdea({ ideaId: idea.ideaId, action: 'ignore', actor: USER })
  assert.equal(ignored.status, 'ignored')
  assert.throws(
    () => h.service.convertIdea({ ideaId: idea.ideaId, actor: USER }),
    (error: unknown) => code(error) === 'invalid_request',
  )
  h.close()
})

void test('listIdeas projectId filter keeps inbox records scoped to one project', () => {
  const h = harness()
  h.service.captureIdea({ channel: 'manual', content: 'p1 item', projectId: 'p1', actor: USER })
  h.service.captureIdea({ channel: 'manual', content: 'p2 item', projectId: 'p2', actor: USER })
  const p1 = h.service.listIdeas({ projectId: 'p1' })
  assert.equal(p1.length, 1)
  assert.equal(p1[0]?.content, 'p1 item')
  assert.equal(p1[0]?.sourceRef, null)
  assert.equal(typeof p1[0]?.createdAt, 'string')
  h.close()
})

void test('转换：只生成 Candidate，重复转换幂等', () => {
  const h = harness()
  const idea = h.service.captureIdea({
    channel: 'manual',
    kind: 'requirement',
    projectId: 'p1',
    title: '导出按钮',
    content: '导出按钮重复点击',
    actor: USER,
  })
  h.service.triageIdea({ ideaId: idea.ideaId, action: 'ready', actor: USER })
  const candidate = h.service.convertIdea({ ideaId: idea.ideaId, actor: USER })
  assert.equal(candidate.sourceIdeaId, idea.ideaId)
  assert.equal(candidate.title, '导出按钮')
  assert.equal(candidate.status, 'captured')
  assert.equal(candidate.convertedTaskId, null)
  const again = h.service.convertIdea({ ideaId: idea.ideaId, actor: USER })
  assert.equal(again.candidateId, candidate.candidateId)
  h.close()
})
