import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'

import { createTaskSchema } from '../src/schema.ts'
import { createServiceTaskTools } from '../src/tools-v1.ts'
import { setTaskToolExecutionContext } from '../src/execution-context.ts'
import { createTaskExecutionHandler } from '../src/execution.ts'
import { assertAgentPresetCapable, selectAgentForTask } from '../src/agent-dispatch.ts'
import { TaskService, TaskServiceError } from '../src/service.ts'
import { ADMISSION_USER, createAdmittedTask } from './admission-fixture.ts'

function harness(): { db: DatabaseSync; service: TaskService } {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  createTaskSchema(db)
  const service = new TaskService(db)
  return { db, service }
}

function code(error: unknown): string {
  return error instanceof TaskServiceError ? error.code : 'not-a-service-error'
}

void test('project create writes one human owner and activates a verified workspace', () => {
  const h = harness()
  const projectId = h.service.createProject({
    name: 'workspace project',
    projectId: 'p1',
    localPath: process.cwd(),
    actor: ADMISSION_USER,
  })
  const project = h.service.getProject(projectId)
  assert.equal(project.ownershipState, 'active')
  assert.equal(project.localPath, process.cwd())
  const members = h.db.prepare('SELECT principal_type, role FROM project_members WHERE project_id = ?').all(projectId) as { principal_type: string; role: string }[]
  assert.deepEqual(members.map(row => ({ ...row })), [{ principal_type: 'user', role: 'owner' }])
  h.db.close()
})

void test('candidate inherits project workspace and rejects a redirected root', () => {
  const h = harness()
  const projectId = h.service.createProject({ name: 'a', projectId: 'p1', localPath: process.cwd(), actor: ADMISSION_USER })
  const candidate = h.service.captureCandidate({ projectId, title: 'task', actor: ADMISSION_USER })
  assert.equal(candidate.workspaceId, process.cwd())
  assert.equal(candidate.mandateScope.workspace_id, process.cwd())
  assert.throws(
    () => h.service.captureCandidate({ projectId, title: 'escape', actor: ADMISSION_USER, workspaceId: 'other-workspace' }),
    (error: unknown) => code(error) === 'workspace_context_mismatch',
  )
  h.db.close()
})

void test('execution resolves project workspace and active scope', () => {
  const h = harness()
  const projectId = h.service.createProject({ name: 'a', projectId: 'p1', localPath: process.cwd(), actor: ADMISSION_USER })
  const task = createAdmittedTask(h.service, { projectId, title: 'execute', status: 'backlog' })
  const context = h.service.getTaskExecutionContext(task.taskId)
  assert.equal(context.projectId, projectId)
  assert.equal(context.workspaceId, process.cwd())
  assert.equal(context.workspaceSource, 'local_path')
  assert.ok(context.scopeId.startsWith('mandate_'))
  const run = h.service.execute({ taskId: task.taskId, ifVersion: task.version, actor: { type: 'agent', name: 'coding_agent' } })
  assert.equal(run.status, 'pending')
  assert.equal(run.lease.status, 'active')
  const started = h.service.startRun({ taskId: task.taskId, linkId: run.linkId, actor: { type: 'agent', name: 'coding_agent' } })
  assert.equal(started.status, 'running')
  assert.ok(run.lease.leaseToken.length >= 32)
  const heartbeat = h.service.heartbeatLease({
    taskId: task.taskId,
    leaseId: run.lease.leaseId,
    leaseToken: run.lease.leaseToken,
    actor: { type: 'agent', name: 'coding_agent' },
  })
  assert.ok(heartbeat.version > run.lease.version)
  assert.throws(
    () => h.service.assertLease({ taskId: task.taskId, leaseId: run.lease.leaseId, leaseToken: 'wrong-token' }),
    (error: unknown) => code(error) === 'lease_conflict',
  )
  h.service.finishRun({ taskId: task.taskId, linkId: run.linkId, status: 'succeeded', actor: { type: 'agent', name: 'coding_agent' } })
  assert.equal(h.service.listLeases(task.taskId)[0]?.status, 'released')
  h.db.close()
})

void test('registered workspace is required and is bound as the project root', () => {
  const h = harness()
  const registered = h.service.createProject({
    name: 'registered',
    projectId: 'p1',
    workspaceId: 'ws-p1',
    actor: ADMISSION_USER,
  })
  assert.equal(h.service.getProject(registered).workspaceId, 'ws-p1')
  const candidate = h.service.captureCandidate({ projectId: registered, title: 'registered task', actor: ADMISSION_USER })
  assert.equal(candidate.workspaceId, 'ws-p1')
  h.db.close()
})

void test('unbound project cannot start execution', () => {
  const h = harness()
  const projectId = h.service.createProject({ name: 'unbound', projectId: 'p1', actor: ADMISSION_USER })
  assert.equal(h.service.getProject(projectId).ownershipState, 'ownership_pending')
  const task = createAdmittedTask(h.service, { projectId, title: 'blocked', status: 'backlog' })
  assert.throws(
    () => h.service.execute({ taskId: task.taskId, ifVersion: task.version, actor: { type: 'agent', name: 'coding_agent' } }),
    (error: unknown) => code(error) === 'workspace_not_bound',
  )
  h.db.close()
})

void test('dispatch matches global capability without project membership', () => {
  assert.equal(selectAgentForTask({ taskType: 'code', riskLevel: 'medium' }).agentPreset, 'coding_agent')
  assert.equal(selectAgentForTask({ taskType: 'code', riskLevel: 'high' }).agentPreset, 'quality_inspector')
  assert.throws(
    () =>{  assertAgentPresetCapable('coding_agent', { taskType: 'code', riskLevel: 'high' }) },
    (error: unknown) => code(error) === 'no_capable_agent',
  )
})

void test('task tools fail closed on project context mismatch', async () => {
  const h = harness()
  h.service.createProject({ name: 'a', projectId: 'p1', localPath: process.cwd(), actor: ADMISSION_USER })
  h.service.createProject({ name: 'b', projectId: 'p2', localPath: process.cwd(), actor: ADMISSION_USER })
  const task = createAdmittedTask(h.service, { projectId: 'p1', title: 'other project' })
  setTaskToolExecutionContext({
    sessionId: 'sess-b',
    taskId: 'other-task',
    projectId: 'p2',
    workspaceId: process.cwd(),
    workspaceSource: 'local_path',
    scopeId: 'scope-b',
    leaseId: 'lease-b',
    leaseToken: 'token-b',
    agentPreset: 'coding_agent',
  })
  const tool = createServiceTaskTools(h.service).find(item => item.name === 'task_get')
  assert.ok(tool !== undefined)
  const result = await tool.execute({ id: task.taskId }, {
    agent: { id: 'sess-b' },
  } as never)
  assert.equal((result as { ok: boolean; code: string }).ok, false)
  assert.equal((result as { code: string }).code, 'project_context_mismatch')
  h.db.close()
})

void test('task execution switches the newly created Session to danger-full-access', async () => {
  const h = harness()
  const projectId = h.service.createProject({ name: 'a', projectId: 'p1', localPath: process.cwd(), actor: ADMISSION_USER })
  const task = createAdmittedTask(h.service, { projectId, title: 'execute with browser', status: 'backlog' })
  const seen: unknown[] = []
  const handler = createTaskExecutionHandler(
    h.service,
    {
      async create() { return { sessionId: 'session-browser' as never, agentPreset: 'coding_agent' } },
      async prompt() { return { accepted: true } },
    },
    { set(session, name) { seen.push({ session, name }) } },
    { get(sessionId) { return sessionId === 'session-browser' ? { id: sessionId, session: { id: sessionId } } : undefined } },
  )
  const response = await handler(new Request('http://host/api/agentops/task-execute', {
    method: 'POST',
    body: JSON.stringify({ task_id: task.taskId, if_version: task.version, idempotency_key: 'browser-permission' }),
  }))
  assert.equal(response.status, 200)
  assert.equal(seen.length, 1)
  assert.equal((seen[0] as { name: string }).name, 'danger-full-access')
  assert.deepEqual((seen[0] as { session: unknown }).session, { id: 'session-browser' })
  const run = h.service.listRuns(task.taskId)[0]
  assert.equal(run?.status, 'running')
  h.db.close()
})

void test('project first binding is allowed with active tasks, but a bound project cannot move', () => {
  const h = harness()
  const projectId = h.service.createProject({ name: 'unbound', projectId: 'p1', actor: ADMISSION_USER })
  const task = createAdmittedTask(h.service, { projectId, title: 'active task', status: 'discussing' })
  assert.ok(task.taskId.length > 0)
  const rebound = h.service.rebindProject({
    projectId,
    ifVersion: 0,
    localPath: process.cwd(),
    actor: ADMISSION_USER,
  })
  assert.equal(rebound.ownershipState, 'active')
  assert.equal(rebound.localPath, process.cwd())
  assert.equal(rebound.version, 1)
  assert.throws(
    () => h.service.rebindProject({ projectId, ifVersion: 1, workspaceId: 'ws-new', actor: { type: 'agent', name: 'coding_agent' } }),
    (error: unknown) => code(error) === 'user_approval_required',
  )
  assert.throws(
    () => h.service.rebindProject({ projectId, ifVersion: 1, workspaceId: 'ws-new', actor: ADMISSION_USER }),
    (error: unknown) => code(error) === 'project_has_active_tasks',
  )
  h.db.close()
})
