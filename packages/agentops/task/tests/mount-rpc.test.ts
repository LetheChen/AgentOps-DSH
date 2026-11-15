/**
 * RPC mounting tests: endpoint decoding, owner-only admission and error mapping.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'

import { TaskHttpApi } from '../src/http.ts'
import { decodeTaskEndpoint, handleTaskRpc } from '../src/mount-rpc.ts'
import { createTaskSchema } from '../src/schema.ts'
import { TaskService } from '../src/service.ts'
import { createAdmittedTask } from './admission-fixture.ts'

const NOW = '2026-11-07T00:00:00Z'



function harness(): { api: TaskHttpApi; service: TaskService; db: DatabaseSync } {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  createTaskSchema(db)
  const service = new TaskService(db, { now: () => NOW })
  service.createProject({ name: '订单后台', projectId: 'p1' })
  return { api: new TaskHttpApi(service, db), service, db }
}

void test('endpoint 解码：接受 tasks、candidates 与 decisions 前缀', () => {
  assert.equal(decodeTaskEndpoint('agentops/tasks'), '/api/agentops/tasks')
  assert.equal(decodeTaskEndpoint('agentops/tasks/t1/advance'), '/api/agentops/tasks/t1/advance')
  assert.equal(decodeTaskEndpoint('agentops/candidates'), '/api/agentops/candidates')
  assert.equal(decodeTaskEndpoint('agentops/candidates/c1/gate'), '/api/agentops/candidates/c1/gate')
  assert.equal(decodeTaskEndpoint('agentops/decisions/search'), '/api/agentops/decisions/search')
  assert.equal(decodeTaskEndpoint('agentops/agents'), undefined)
  assert.equal(decodeTaskEndpoint('agentops/tasksx'), undefined)
})

void test('RPC：直接建 Task 被拒，Candidate 捕获走同一 router', () => {
  const h = harness()
  const listed = handleTaskRpc(h.api, 'agentops/tasks', { method: 'GET' }, true)
  assert.equal(listed.ok, true)
  assert.deepEqual((listed as { value: { tasks: unknown[] } }).value.tasks, [])

  const refused = handleTaskRpc(h.api, 'agentops/tasks', {
    method: 'POST',
    body: { project_id: 'p1', title: '修复导出按钮' },
  }, true)
  assert.equal(refused.ok, false)
  assert.equal((refused as { error: { code: string } }).error.code, 'admission_required')

  const captured = handleTaskRpc(h.api, 'agentops/candidates', {
    method: 'POST',
    body: { project_id: 'p1', title: '修复导出按钮' },
  }, true)
  assert.equal(captured.ok, true)
  const candidate = (captured as { value: { candidate: { candidateId: string; status: string } } }).value.candidate
  assert.match(candidate.candidateId, /^cand_/)
  assert.equal(candidate.status, 'captured')
  h.db.close()
})

void test('RPC：全局 activities 静态路由不会被 task_id 动态路由截获', () => {
  const h = harness()
  const result = handleTaskRpc(h.api, 'agentops/tasks/activities', { method: 'GET' }, true)
  assert.equal(result.ok, true)
  assert.deepEqual((result as { value: { activities: unknown[] } }).value.activities, [])
  h.db.close()
})

void test('RPC：PATCH 语义通过 payload 表达', () => {
  const h = harness()
  const task = createAdmittedTask(h.service, { projectId: 'p1', title: 't' })
  const patched = handleTaskRpc(h.api, `agentops/tasks/${task.taskId}`, {
    method: 'PATCH',
    body: { patch: { title: '新标题' }, if_version: task.version },
  }, true)
  assert.equal(patched.ok, true)
  assert.equal((patched as { value: { task: { title: string } } }).value.task.title, '新标题')
  h.db.close()
})

void test('RPC：业务错误映射为错误码', () => {
  const h = harness()
  const task = createAdmittedTask(h.service, { projectId: 'p1', title: 't', status: 'discussing' })
  const stale = handleTaskRpc(h.api, `agentops/tasks/${task.taskId}/advance`, {
    method: 'POST',
    body: { target_status: 'decomposing', if_version: task.version + 9 },
  }, true)
  assert.equal(stale.ok, false)
  assert.equal((stale as { error: { code: string } }).error.code, 'version_conflict')
  h.db.close()
})

void test('RPC：未知端点与非 owner 被拒绝', () => {
  const h = harness()
  const unknown = handleTaskRpc(h.api, 'agentops/other', { method: 'GET' }, true)
  assert.equal((unknown as { error: { code: string } }).error.code, 'not_found')

  const forbidden = handleTaskRpc(h.api, 'agentops/tasks', { method: 'GET' }, false)
  assert.equal((forbidden as { error: { code: string } }).error.code, 'forbidden')
  h.db.close()
})
