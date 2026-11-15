/**
 * HTTP surface tests: routing precedence, error mapping and the mutation
 * contract the Web client and SDK will rely on.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'

import { TaskHttpApi } from '../src/http.ts'
import { createTaskSchema } from '../src/schema.ts'
import { TaskService } from '../src/service.ts'
import { createAdmittedTask } from './admission-fixture.ts'

const NOW = '2026-11-07T00:00:00Z'
const USER = { type: 'user', name: 'pm' } as const
const AGENT = { type: 'agent', name: 'coding_agent' } as const

interface Harness {
  api: TaskHttpApi
  service: TaskService
  db: DatabaseSync
  projectId: string
}

function harness(): Harness {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  createTaskSchema(db)
  const service = new TaskService(db, { now: () => NOW })
  const projectId = service.createProject({ name: '订单后台', projectId: 'p1', localPath: process.cwd() })
  return { api: new TaskHttpApi(service, db), service, db, projectId }
}

function call(
  h: Harness,
  method: string,
  path: string,
  options: { body?: unknown; query?: Record<string, string>; actor?: typeof USER | typeof AGENT } = {},
): { status: number; body: unknown } {
  return h.api.handle({
    method,
    path,
    body: options.body,
    query: options.query ?? {},
    actor: options.actor ?? USER,
  })
}

function errorCode(body: unknown): string {
  const value = body as { error?: { code?: string } }
  return value.error?.code ?? ''
}

void test('静态路径先于 {task_id}，未知路径返回 404', () => {
  const h = harness()
  assert.equal(call(h, 'GET', '/api/agentops/tasks/search').status, 200)
  assert.equal(call(h, 'GET', '/api/agentops/tasks/projects').status, 200)
  assert.equal(call(h, 'GET', '/api/agentops/tasks/dashboard').status, 200)
  const missing = call(h, 'GET', '/api/agentops/tasks/task_missing')
  assert.equal(missing.status, 404)
  assert.equal(errorCode(missing.body), 'task_not_found')
  const unknown = call(h, 'GET', '/api/other')
  assert.equal(unknown.status, 404)
  assert.equal(errorCode(unknown.body), 'not_found')
  h.db.close()
})

void test('graph nodes include their project identity', () => {
  const h = harness()
  const task = createAdmittedTask(h.service, { projectId: 'p1', title: 'graph node', status: 'discussing' })
  const graph = call(h, 'GET', '/api/agentops/tasks/graph', { query: { project_id: 'p1' } })
  assert.equal(graph.status, 200)
  const nodes = (graph.body as {
    nodes: { task_id: string; project_id: string | null; project_name: string | null }[]
  }).nodes
  const node = nodes.find(row => row.task_id === task.taskId)
  assert.equal(node?.project_id, 'p1')
  assert.equal(node?.project_name, '订单后台')
  h.db.close()
})

void test('Candidate 准入：直接建 Task 被拒，用户 Gate 后创建 discussing Task', () => {
  const h = harness()
  const direct = call(h, 'POST', '/api/agentops/tasks', {
    body: { project_id: 'p1', title: '修复导出按钮' },
  })
  assert.equal(direct.status, 410)
  assert.equal(errorCode(direct.body), 'admission_required')
  assert.equal(
    (direct.body as { error: { details: { replacement_endpoint: string } } }).error.details.replacement_endpoint,
    '/api/agentops/candidates',
  )

  const captured = call(h, 'POST', '/api/agentops/candidates', {
    body: { project_id: 'p1', title: '修复导出按钮' },
  })
  assert.equal(captured.status, 200)
  const candidate = (captured.body as { candidate: { candidateId: string; status: string; version: number } }).candidate
  assert.equal(candidate.status, 'captured')
  assert.equal(candidate.version, 0)

  const firstAnalysis = call(h, 'POST', `/api/agentops/candidates/${candidate.candidateId}/analyze`, {
    body: {
      if_version: 0,
      analysis_problem: '导出按钮可重复点击',
      analysis_deliverables: '导出按钮防重',
      acceptance_criteria: [{ description: '导出只触发一次' }],
    },
  })
  assert.equal(firstAnalysis.status, 200)
  assert.equal((firstAnalysis.body as { candidate: { status: string } }).candidate.status, 'analyzing')

  const secondAnalysis = call(h, 'POST', `/api/agentops/candidates/${candidate.candidateId}/analyze`, {
    body: { if_version: 1, analysis_non_goals: '', dependencies: [] },
  })
  assert.equal(secondAnalysis.status, 200)
  assert.equal((secondAnalysis.body as { candidate: { status: string } }).candidate.status, 'awaiting_gate')

  const snapshot = call(h, 'POST', `/api/agentops/candidates/${candidate.candidateId}/preflight-search`, {
    body: { if_version: 2, query: { q: '导出' }, search_coverage: 'complete' },
  })
  assert.equal(snapshot.status, 200)

  const admitted = call(h, 'POST', `/api/agentops/candidates/${candidate.candidateId}/gate`, {
    body: { if_version: 3 },
  })
  assert.equal(admitted.status, 200)
  const admittedBody = admitted.body as {
    candidate: { status: string; convertedTaskId: string }
    task: { taskId: string; version: number; status: string }
  }
  assert.equal(admittedBody.candidate.status, 'converted')
  assert.equal(admittedBody.candidate.convertedTaskId, admittedBody.task.taskId)
  const task = admittedBody.task
  assert.equal(task.version, 0)
  assert.equal(task.status, 'discussing')

  const list = call(h, 'GET', '/api/agentops/tasks', { query: { projectId: 'p1' } })
  assert.equal((list.body as { tasks: unknown[] }).tasks.length, 1)

  const detail = call(h, 'GET', `/api/agentops/tasks/${task.taskId}`)
  assert.equal(detail.status, 200)
  const payload = detail.body as { task: { status: string }; allowed: unknown[]; events: unknown[] }
  assert.equal(payload.task.status, 'discussing')
  assert.ok(payload.allowed.length >= 1)
  assert.equal(payload.events.length, 1)
  h.db.close()
})

void test('错误映射：403 / 409 / 400', () => {
  const h = harness()
  const task = createAdmittedTask(h.service, { projectId: 'p1', title: 't', status: 'reviewing' })

  const forbidden = call(h, 'POST', `/api/agentops/tasks/${task.taskId}/advance`, {
    body: { target_status: 'discussing', if_version: task.version },
    actor: AGENT,
  })
  assert.equal(forbidden.status, 403)
  assert.equal(errorCode(forbidden.body), 'user_approval_required')

  const advanced = call(h, 'POST', `/api/agentops/tasks/${task.taskId}/advance`, {
    body: { target_status: 'discussing', if_version: task.version },
  })
  assert.equal(advanced.status, 200)

  const stale = call(h, 'POST', `/api/agentops/tasks/${task.taskId}/advance`, {
    body: { target_status: 'reviewing', if_version: task.version },
  })
  assert.equal(stale.status, 409)
  assert.equal(errorCode(stale.body), 'version_conflict')

  const invalid = call(h, 'POST', `/api/agentops/tasks/${task.taskId}/advance`, {
    body: { target_status: 'closed', if_version: task.version + 1 },
  })
  assert.equal(invalid.status, 400)
  assert.equal(errorCode(invalid.body), 'invalid_transition')
  h.db.close()
})

void test('PATCH 拒绝非白名单字段，并校验版本', () => {
  const h = harness()
  const task = createAdmittedTask(h.service, { projectId: 'p1', title: 't' })
  const rejected = call(h, 'PATCH', `/api/agentops/tasks/${task.taskId}`, {
    body: { patch: { status: 'closed' }, if_version: task.version },
  })
  assert.equal(rejected.status, 400)
  const ok = call(h, 'PATCH', `/api/agentops/tasks/${task.taskId}`, {
    body: { patch: { title: '新标题' }, if_version: task.version },
  })
  assert.equal(ok.status, 200)
  assert.equal((ok.body as { task: { title: string } }).task.title, '新标题')
  h.db.close()
})

void test('评论：mention 白名单与请求修改顺序', () => {
  const h = harness()
  const task = createAdmittedTask(h.service, { projectId: 'p1', title: 't', status: 'validating' })

  const badMention = call(h, 'POST', `/api/agentops/tasks/${task.taskId}/comments`, {
    body: { body: 'x', mentions: ['task_dispatcher'], if_version: task.version },
  })
  assert.equal(badMention.status, 400)

  const review = call(h, 'POST', `/api/agentops/tasks/${task.taskId}/comments`, {
    body: {
      body: '失败分支未恢复',
      comment_type: 'review',
      decision: 'request_changes',
      rollback_target: 'in_progress',
      if_version: task.version,
    },
  })
  assert.equal(review.status, 200)
  const detail = call(h, 'GET', `/api/agentops/tasks/${task.taskId}`)
  assert.equal((detail.body as { task: { status: string } }).task.status, 'in_progress')
  h.db.close()
})

void test('关闭门禁阻塞返回 close_blocked 与阻塞项', () => {
  const h = harness()
  const task = createAdmittedTask(h.service, { projectId: 'p1', title: 't', status: 'validating' })
  call(h, 'POST', `/api/agentops/tasks/${task.taskId}/criteria`, {
    body: { description: '导出不重复', if_version: task.version },
  })
  const blocked = call(h, 'POST', `/api/agentops/tasks/${task.taskId}/close`, { body: { if_version: task.version + 1 } })
  assert.equal(blocked.status, 400)
  assert.equal(errorCode(blocked.body), 'close_blocked')
  const details = (blocked.body as { error: { details: { blockers: string[] } } }).error.details
  assert.ok(details.blockers.length >= 1)
  h.db.close()
})

void test('execute：幂等键与活跃运行冲突', () => {
  const h = harness()
  const task = createAdmittedTask(h.service, { projectId: 'p1', title: 't', status: 'backlog' })

  const first = call(h, 'POST', `/api/agentops/tasks/${task.taskId}/execute`, {
    body: { idempotency_key: 'k1', if_version: task.version },
    actor: AGENT,
  })
  assert.equal(first.status, 200)
  const linkId = (first.body as { run: { linkId: string } }).run.linkId

  const again = call(h, 'POST', `/api/agentops/tasks/${task.taskId}/execute`, {
    body: { idempotency_key: 'k1', if_version: task.version },
    actor: AGENT,
  })
  assert.equal((again.body as { run: { linkId: string } }).run.linkId, linkId)

  const conflict = call(h, 'POST', `/api/agentops/tasks/${task.taskId}/execute`, {
    body: { if_version: task.version + 1 },
    actor: AGENT,
  })
  assert.equal(conflict.status, 409)
  assert.equal(errorCode(conflict.body), 'active_run_conflict')
  h.db.close()
})

void test('提案：列表与 apply 需 approved，重复应用被拒', () => {
  const h = harness()
  const task = createAdmittedTask(h.service, { projectId: 'p1', title: 't' })
  h.db.prepare("INSERT INTO design_docs(doc_id, project_id, title, path) VALUES ('d1','p1','设计','d.md')").run()
  h.db
    .prepare(
      `INSERT INTO doc_change_proposals(proposal_id, doc_id, task_id, change_type, status, new_content, version, created_at)
       VALUES ('prop1','d1',?,'modify','approved','新内容',0,'n')`,
    )
    .run(task.taskId)

  const listed = call(h, 'GET', '/api/agentops/tasks/proposals', { query: { status: 'approved' } })
  assert.equal((listed.body as { proposals: unknown[] }).proposals.length, 1)

  const applied = call(h, 'POST', '/api/agentops/tasks/proposals/prop1/apply', { body: { if_version: 0 } })
  assert.equal(applied.status, 200)
  assert.equal((applied.body as { proposal: { status: string } }).proposal.status, 'applied')
  const changes = h.db.prepare('SELECT COUNT(*) AS n FROM design_doc_changes').get() as { n: number }
  assert.equal(changes.n, 1)

  const again = call(h, 'POST', '/api/agentops/tasks/proposals/prop1/apply', { body: { if_version: 1 } })
  assert.equal(again.status, 409)
  assert.equal(errorCode(again.body), 'invalid_request')
  h.db.close()
})

void test('设计笔记状态更新', () => {
  const h = harness()
  const task = createAdmittedTask(h.service, { projectId: 'p1', title: 't' })
  h.db
    .prepare(
      "INSERT INTO design_notes(note_id, task_id, project_id, content, created_at, updated_at) VALUES ('n1',?,'p1','笔记','n','n')",
    )
    .run(task.taskId)
  const updated = call(h, 'POST', `/api/agentops/tasks/${task.taskId}/design-notes/n1/status`, {
    body: { status: 'implemented', if_version: 0 },
  })
  assert.equal(updated.status, 200)
  assert.equal((updated.body as { note: { status: string } }).note.status, 'implemented')
  const missing = call(h, 'POST', `/api/agentops/tasks/${task.taskId}/design-notes/nope/status`, {
    body: { status: 'implemented', if_version: 1 },
  })
  assert.equal(missing.status, 404)
  h.db.close()
})

void test('收件箱：采集、分诊就绪、转换与幂等转换', () => {
  const h = harness()
  const created = call(h, 'POST', '/api/agentops/tasks/ideas', {
    body: {
      channel: 'manual',
      kind: 'requirement',
      project_id: 'p1',
      title: '导出按钮重复点击',
      content: '导出按钮重复点击，成功失败都要恢复',
    },
  })
  assert.equal(created.status, 200)
  const idea = (created.body as { idea: { ideaId: string; status: string; kind: string } }).idea
  assert.equal(idea.status, 'captured')
  assert.equal(idea.kind, 'requirement')

  const confirmed = call(h, 'POST', `/api/agentops/tasks/ideas/${idea.ideaId}/confirm`)
  assert.equal(confirmed.status, 200)
  assert.equal((confirmed.body as { idea: { status: string } }).idea.status, 'ready')

  const converted = call(h, 'POST', `/api/agentops/tasks/ideas/${idea.ideaId}/convert`)
  assert.equal(converted.status, 200)
  const candidate = (converted.body as {
    candidate: { candidateId: string; title: string; status: string; convertedTaskId: string | null }
  }).candidate
  assert.equal(candidate.title, '导出按钮重复点击')
  assert.equal(candidate.status, 'captured')
  assert.equal(candidate.convertedTaskId, null)

  const again = call(h, 'POST', `/api/agentops/tasks/ideas/${idea.ideaId}/convert`)
  assert.equal((again.body as { candidate: { candidateId: string } }).candidate.candidateId, candidate.candidateId)
  h.db.close()
})

void test('关系：顶层创建与按任务列出', () => {
  const h = harness()
  const a = createAdmittedTask(h.service, { projectId: 'p1', title: 'a' })
  const b = createAdmittedTask(h.service, { projectId: 'p1', title: 'b' })
  const created = call(h, 'POST', '/api/agentops/tasks/relations', {
    body: { task_id: a.taskId, relation_type: 'blocks', target_task_id: b.taskId, if_version: 0 },
  })
  assert.equal(created.status, 200)
  const listed = call(h, 'GET', '/api/agentops/tasks/relations', { query: { taskId: a.taskId } })
  assert.equal((listed.body as { relations: unknown[] }).relations.length, 1)
  h.db.close()
})
void test('验收标准状态与报告审批：两条新路由', () => {
  const h = harness()
  const task = createAdmittedTask(h.service, { projectId: 'p1', title: 't', status: 'validating' })
  const criterion = h.service.addCriteria({
    taskId: task.taskId, description: '导出成功', ifVersion: h.service.getTask(task.taskId).task.version, actor: USER,
  })
  const passed = call(h, 'POST', `/api/agentops/tasks/${task.taskId}/criteria/${criterion.criteriaId}/status`, {
    body: { status: 'passed', if_version: h.service.getTask(task.taskId).task.version },
  })
  assert.equal(passed.status, 200)

  const report = h.service.submitReport({
    taskId: task.taskId, content: '# 报告', ifVersion: h.service.getTask(task.taskId).task.version, actor: USER,
  })
  const reviewed = call(h, 'POST', `/api/agentops/tasks/${task.taskId}/reports/${report.reportId}/review`, {
    body: { decision: 'approve', comment: '验收通过', if_version: h.service.getTask(task.taskId).task.version },
  })
  assert.equal(reviewed.status, 200)
  h.db.close()
})

void test('Decision HTTP: propose -> search -> user implement -> archive -> detail', () => {
  const h = harness()
  const proposed = call(h, 'POST', '/api/agentops/decisions', {
    body: {
      project_id: 'p1',
      decision_id: 'd1',
      decision_key: 'task-admission-gate',
      title: 'Admission gate',
      subject_type: 'project',
      authority_scope: 'project',
      authority_level: 'policy',
      problem: 'Draft tasks bypass analysis.',
      proposal: 'Candidates must pass a gate.',
      rationale: 'Preserve lifecycle quality.',
      note_class: 'architecture',
    },
  })
  assert.equal(proposed.status, 200)
  const decision = (proposed.body as { decision: { decisionId: string; status: string; version: number } }).decision
  assert.equal(decision.status, 'proposed')
  assert.equal(decision.version, 0)

  const searched = call(h, 'GET', '/api/agentops/decisions/search', {
    query: { project_id: 'p1', collection: 'proposed' },
  })
  assert.equal(searched.status, 200)
  assert.equal((searched.body as { total: number }).total, 1)

  const refused = call(h, 'POST', '/api/agentops/decisions/d1/implement', {
    actor: AGENT,
    body: { if_version: 0, evidence: [{ kind: 'manual', ref: 'agent-approval' }] },
  })
  assert.equal(refused.status, 403)
  assert.equal(errorCode(refused.body), 'user_approval_required')

  const implemented = call(h, 'POST', '/api/agentops/decisions/d1/implement', {
    body: {
      if_version: 0,
      effective_from: '2026-11-06T00:00:00Z',
      evidence: [{ kind: 'pull_request', ref: 'https://example.test/pr/1' }],
    },
  })
  assert.equal(implemented.status, 200)
  const implementedDecision = (implemented.body as { decision: { status: string; version: number } }).decision
  assert.equal(implementedDecision.status, 'implemented')
  assert.equal(implementedDecision.version, 1)

  const archived = call(h, 'POST', '/api/agentops/decisions/d1/archive', {
    body: { if_version: 1, reason: 'obsolete' },
  })
  assert.equal(archived.status, 200)
  assert.equal((archived.body as { decision: { status: string } }).decision.status, 'archived')

  const detail = call(h, 'GET', '/api/agentops/decisions/d1')
  assert.equal(detail.status, 200)
  assert.equal((detail.body as { evidence: unknown[] }).evidence.length, 1)
  assert.equal((detail.body as { audit: unknown[] }).audit.length, 3)
  h.db.close()
})

void test('Decision HTTP: reject, version conflict and not-found mapping', () => {
  const h = harness()
  const body = {
    project_id: 'p1',
    decision_key: 'reject-me',
    title: 'Reject me',
    subject_type: 'project',
    authority_scope: 'project',
    authority_level: 'policy',
    problem: 'Problem',
    proposal: 'Proposal',
    rationale: 'Rationale',
    note_class: 'architecture',
  }
  const proposed = call(h, 'POST', '/api/agentops/decisions', { body: { ...body, decision_id: 'd2' } })
  assert.equal(proposed.status, 200)
  const rejected = call(h, 'POST', '/api/agentops/decisions/d2/reject', {
    body: { if_version: 0, reason: 'Not viable.' },
  })
  assert.equal(rejected.status, 200)
  assert.equal((rejected.body as { decision: { status: string } }).decision.status, 'rejected')

  assert.equal(call(h, 'POST', '/api/agentops/decisions', { body: { ...body, decision_id: 'd3', decision_key: 'stale' } }).status, 200)
  const stale = call(h, 'POST', '/api/agentops/decisions/d3/implement', {
    body: { if_version: 99, evidence: [{ kind: 'test', ref: 'suite' }] },
  })
  assert.equal(stale.status, 409)
  assert.equal(errorCode(stale.body), 'version_conflict')

  const missing = call(h, 'GET', '/api/agentops/decisions/nope')
  assert.equal(missing.status, 404)
  assert.equal(errorCode(missing.body), 'decision_not_found')
  h.db.close()
})

void test('rebind route validates registered workspaces and returns the updated project', () => {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  createTaskSchema(db)
  const service = new TaskService(db, { now: () => NOW })
  service.createProject({ name: 'unbound', projectId: 'p1' })
  const api = new TaskHttpApi(service, db, {
    listWorkspaces: () => [{ workspace_id: 'ws-ok', title: 'ok', path: process.cwd() }],
  })
  const callRebind = (body: Record<string, unknown>) => api.handle({
    method: 'POST',
    path: '/api/agentops/tasks/projects/p1/rebind',
    body,
    query: {},
    actor: USER,
  })
  const unknown = callRebind({ if_version: 0, workspace_id: 'missing' })
  assert.equal(unknown.status, 400)
  assert.equal(errorCode(unknown.body), 'workspace_invalid')
  const ok = callRebind({ if_version: 0, workspace_id: 'ws-ok' })
  assert.equal(ok.status, 200)
  const project = (ok.body as { project: { workspaceId: string; ownershipState: string; version: number } }).project
  assert.equal(project.workspaceId, 'ws-ok')
  assert.equal(project.ownershipState, 'active')
  assert.equal(project.version, 1)
  const stale = callRebind({ if_version: 0, local_path: process.cwd() })
  assert.equal(stale.status, 409)
  assert.equal(errorCode(stale.body), 'version_conflict')
  db.close()
})

void test('project list resolves a workspace UUID to its registered real path', () => {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  createTaskSchema(db)
  const service = new TaskService(db, { now: () => NOW })
  service.createProject({ name: 'resolved', projectId: 'p1', workspaceId: 'ws-ok' })
  const api = new TaskHttpApi(service, db, {
    listWorkspaces: () => [{ workspace_id: 'ws-ok', title: 'root', path: process.cwd() }],
  })
  const result = api.handle({ method: 'GET', path: '/api/agentops/tasks/projects', query: {}, actor: USER })
  assert.equal(result.status, 200)
  const project = (result.body as {
    projects: { workspace_id: string; workspace_path: string | null; workspace_title: string | null }[]
  }).projects[0]
  assert.equal(project?.workspace_id, 'ws-ok')
  assert.equal(project?.workspace_path, process.cwd())
  assert.equal(project?.workspace_title, 'root')
  db.close()
})
