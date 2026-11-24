import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { CapabilityStore } from '@agentops/dsh-capability'

import { LogCollectionHttpApi } from '../src/http.ts'
import { LogCollectionStore } from '../src/store.ts'

const key = { key: Buffer.alloc(32, 11), source: 'env' as const }

interface Fixture {
  readonly api: LogCollectionHttpApi
  readonly db: DatabaseSync
  readonly store: LogCollectionStore
  readonly capabilities: CapabilityStore
  readonly root: string
  close(): void
}

/** One in-memory control plane with a ready SSH instance. */
function fixture(options: { readonly withSsh?: boolean } = {}): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'log-collection-http-'))
  const db = new DatabaseSync(':memory:')
  const store = new LogCollectionStore(db, { localRoot: root })
  const capabilities = new CapabilityStore(':memory:', key)
  if (options.withSsh !== false) {
    capabilities.saveInstance({
      instanceId: 'MaxKB',
      capabilityId: 'ssh',
      name: 'MaxKB',
      config: {
        host: '192.0.2.10', port: 2222, username: 'root',
        auth_type: 'password', host_key_sha256: 'SHA256:' + 'A'.repeat(43),
      },
      secret: 'secret',
    }, 'test')
  }
  return {
    api: new LogCollectionHttpApi(store, capabilities),
    db,
    store,
    capabilities,
    root,
    close: () => {
      db.close()
      capabilities.close()
      rmSync(root, { recursive: true, force: true })
    },
  }
}

void test('creates a task that references an enabled SSH instance', async () => {
  const f = fixture()
  try {
    const created = await f.api.handle({
      method: 'POST',
      path: '/api/agentops/log-collection/tasks',
      body: {
        task_id: 'oa_approval',
        name: '智能审批日志',
        ssh_instance_id: 'MaxKB',
        remote_paths: ['/opt/AI_Agent_Platform/logs/app/oa_audit.log'],
        local_max_days: 30,
      },
    })
    assert.equal(created.status, 201, JSON.stringify(created.body))
    const task = (created.body as { task: Record<string, unknown> }).task
    assert.equal(task.task_id, 'oa_approval')
    // The local root is derived, never accepted from the request.
    assert.equal(task.storage_key, 'default/oa_approval')
    assert.deepEqual(task.remote_paths, ['/opt/AI_Agent_Platform/logs/app/oa_audit.log'])

    const acl = await f.api.handle({ method: 'GET', path: '/api/agentops/log-collection/tasks/oa_approval/acl' })
    assert.equal(acl.status, 200)
    assert.deepEqual((acl.body as { acl: { agentPreset: string; canPull: boolean; canQuery: boolean }[] }).acl, [
      { agentPreset: 'log_analyst', canPull: false, canQuery: true, revoked: false },
      { agentPreset: 'log_puller', canPull: true, canQuery: false, revoked: false },
    ])

    const listed = await f.api.handle({ method: 'GET', path: '/api/agentops/log-collection/tasks' })
    assert.equal(listed.status, 200)
    const body = listed.body as { tasks: unknown[]; ssh_instances: { instance_id: string }[] }
    assert.equal(body.tasks.length, 1)
    assert.deepEqual(body.ssh_instances.map(i => i.instance_id), ['MaxKB'])
  } finally {
    f.close()
  }
})

void test('rejects a task whose SSH instance does not exist or lacks a pin', async () => {
  const f = fixture({ withSsh: false })
  try {
    const missing = await f.api.handle({
      method: 'POST',
      path: '/api/agentops/log-collection/tasks',
      body: { name: 'X', ssh_instance_id: 'nope', remote_paths: ['/a.log'] },
    })
    assert.equal(missing.status, 400)
    assert.equal((missing.body as { error: { code: string } }).error.code, 'CAPABILITY_INSTANCE_MISMATCH')

    f.capabilities.saveInstance({
      instanceId: 'NoPin',
      capabilityId: 'ssh',
      name: 'NoPin',
      config: { host: 'h', port: 22, username: 'u' },
      secret: 's',
    }, 'test')
    const unpinned = await f.api.handle({
      method: 'POST',
      path: '/api/agentops/log-collection/tasks',
      body: { name: 'Y', ssh_instance_id: 'NoPin', remote_paths: ['/a.log'] },
    })
    assert.equal(unpinned.status, 400)
    assert.equal((unpinned.body as { error: { code: string } }).error.code, 'SSH_HOST_KEY_REJECTED')
  } finally {
    f.close()
  }
})

void test('rejects a disabled SSH instance and an empty remote path list', async () => {
  const f = fixture()
  try {
    f.capabilities.saveInstance({
      instanceId: 'MaxKB', capabilityId: 'ssh', name: 'MaxKB',
      config: {
        host: '192.0.2.10', port: 2222, username: 'root',
        host_key_sha256: 'SHA256:' + 'A'.repeat(43),
      },
      status: 'disabled',
    }, 'test')
    const disabled = await f.api.handle({
      method: 'POST', path: '/api/agentops/log-collection/tasks',
      body: { name: 'X', ssh_instance_id: 'MaxKB', remote_paths: ['/a.log'] },
    })
    assert.equal((disabled.body as { error: { code: string } }).error.code, 'CAPABILITY_INSTANCE_UNAVAILABLE')

    f.capabilities.saveInstance({
      instanceId: 'MaxKB', capabilityId: 'ssh', name: 'MaxKB',
      config: {
        host: '192.0.2.10', port: 2222, username: 'root',
        host_key_sha256: 'SHA256:' + 'A'.repeat(43),
      },
      status: 'enabled',
    }, 'test')
    const empty = await f.api.handle({
      method: 'POST', path: '/api/agentops/log-collection/tasks',
      body: { name: 'X', ssh_instance_id: 'MaxKB', remote_paths: [] },
    })
    assert.equal(empty.status, 400)
    assert.equal((empty.body as { error: { code: string } }).error.code, 'LOG_TASK_INVALID')
  } finally {
    f.close()
  }
})

void test('updates with an expected revision and rejects a stale one', async () => {
  const f = fixture()
  try {
    await f.api.handle({
      method: 'POST', path: '/api/agentops/log-collection/tasks',
      body: { task_id: 't1', name: 'T1', ssh_instance_id: 'MaxKB', remote_paths: ['/a.log'] },
    })
    const ok = await f.api.handle({
      method: 'PATCH', path: '/api/agentops/log-collection/tasks/t1',
      body: { expected_revision: 1, name: 'T1 renamed', enabled: false },
    })
    assert.equal(ok.status, 200, JSON.stringify(ok.body))
    const task = (ok.body as { task: { name: string; enabled: boolean; revision: number } }).task
    assert.equal(task.name, 'T1 renamed')
    assert.equal(task.enabled, false)
    assert.equal(task.revision, 2)

    const stale = await f.api.handle({
      method: 'PATCH', path: '/api/agentops/log-collection/tasks/t1',
      body: { expected_revision: 1, name: 'stale write' },
    })
    assert.equal(stale.status, 400)
    assert.equal((stale.body as { error: { code: string } }).error.code, 'LOG_TASK_CONFLICT')
  } finally {
    f.close()
  }
})

void test('soft-deletes a task and keeps its id reserved', async () => {
  const f = fixture()
  try {
    await f.api.handle({
      method: 'POST', path: '/api/agentops/log-collection/tasks',
      body: { task_id: 'gone', name: 'Gone', ssh_instance_id: 'MaxKB', remote_paths: ['/a.log'] },
    })
    const removed = await f.api.handle({ method: 'DELETE', path: '/api/agentops/log-collection/tasks/gone' })
    assert.equal(removed.status, 200)
    const list = await f.api.handle({ method: 'GET', path: '/api/agentops/log-collection/tasks' })
    assert.deepEqual((list.body as { tasks: unknown[] }).tasks, [])

    const reuse = await f.api.handle({
      method: 'POST', path: '/api/agentops/log-collection/tasks',
      body: { task_id: 'gone', name: 'Again', ssh_instance_id: 'MaxKB', remote_paths: ['/b.log'] },
    })
    assert.equal(reuse.status, 400)
    assert.equal((reuse.body as { error: { code: string } }).error.code, 'LOG_TASK_CONFLICT')
  } finally {
    f.close()
  }
})

void test('grants, lists and revokes task access for one preset', async () => {
  const f = fixture()
  try {
    await f.api.handle({
      method: 'POST', path: '/api/agentops/log-collection/tasks',
      body: { task_id: 't1', name: 'T1', ssh_instance_id: 'MaxKB', remote_paths: ['/a.log'] },
    })
    const granted = await f.api.handle({
      method: 'PUT', path: '/api/agentops/log-collection/tasks/t1/acl',
      body: { agent_preset: 'smart_ops', can_pull: true },
    })
    assert.equal(granted.status, 200, JSON.stringify(granted.body))
    assert.deepEqual(
      (granted.body as { acl: { agentPreset: string; canPull: boolean }[] }).acl.map(entry => ({
        agentPreset: entry.agentPreset,
        canPull: entry.canPull,
      })),
      [
        { agentPreset: 'log_analyst', canPull: false },
        { agentPreset: 'log_puller', canPull: true },
        { agentPreset: 'smart_ops', canPull: true },
      ],
    )

    const revoked = await f.api.handle({
      method: 'DELETE', path: '/api/agentops/log-collection/tasks/t1/acl/smart_ops',
    })
    assert.equal(revoked.status, 200)
    assert.deepEqual(
      (revoked.body as { acl: { agentPreset: string }[] }).acl.map(entry => entry.agentPreset),
      ['log_analyst', 'log_puller'],
    )
  } finally {
    f.close()
  }
})

void test('lists recorded runs filtered by task', async () => {
  const f = fixture()
  try {
    f.store.runs.record({
      runId: 'r1', tenantKey: 'default', taskId: 't1', sshInstanceId: 'MaxKB',
      actor: 'owner', origin: 'manual', status: 'succeeded',
      startedAt: '2026-01-01T00:00:00.000Z', finishedAt: '2026-01-01T00:00:01.000Z',
      elapsedMs: 1000, fileCount: 1, byteCount: 512,
      files: [{ remotePath: '/a.log', localPath: '/tmp/a.log', bytes: 512, deltaStart: 0, deltaEnd: 512, skipped: false }],
      errorCode: null, errorMessage: null,
    })
    const listed = await f.api.handle({
      method: 'GET', path: '/api/agentops/log-collection/runs', query: { task_id: 't1' },
    })
    assert.equal(listed.status, 200)
    const runs = (listed.body as { runs: { runId: string; byteCount: number }[] }).runs
    assert.equal(runs.length, 1)
    assert.equal(runs[0]?.runId, 'r1')
    assert.equal(runs[0]?.byteCount, 512)
  } finally {
    f.close()
  }
})

void test('run-now reports unavailable when no pull service is mounted', async () => {
  const f = fixture()
  try {
    await f.api.handle({
      method: 'POST', path: '/api/agentops/log-collection/tasks',
      body: { task_id: 't1', name: 'T1', ssh_instance_id: 'MaxKB', remote_paths: ['/a.log'] },
    })
    const ran = await f.api.handle({
      method: 'POST', path: '/api/agentops/log-collection/tasks/t1/run',
    })
    assert.equal(ran.status, 503)
  } finally {
    f.close()
  }
})
