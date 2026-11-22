import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { LogCollectionError, LogCollectionStore } from '../src/index.ts'

function openStore(): { db: DatabaseSync; store: LogCollectionStore; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'dsh-log-collection-'))
  const db = new DatabaseSync(':memory:')
  return { db, store: new LogCollectionStore(db, { localRoot: root }), root }
}

function createTask(store: LogCollectionStore) {
  return store.create({
    tenantKey: 'tenant-a',
    taskId: 'oa_approval',
    name: 'OA audit',
    ownerDomain: 'smart_approval',
    sshInstanceId: 'maxkb',
    remotePaths: ['/opt/AI_Agent_Platform/logs/app/oa_audit.log'],
    localMaxDays: 7,
    actor: 'owner',
  })
}

void test('creates, lists and resolves a task under tenant/task directory', () => {
  const { db, store, root } = openStore()
  try {
    const task = createTask(store)
    assert.equal(task.taskId, 'oa_approval')
    assert.equal(task.storageKey, 'tenant-a/oa_approval')
    assert.equal(store.list('tenant-a').length, 1)
    assert.equal(store.resolveTaskDirectory(task), join(root, 'tenant-a', 'oa_approval'))
  } finally {
    db.close()
    rmSync(root, { recursive: true, force: true })
  }
})

void test('rejects relative or traversing remote paths', () => {
  const { db, store, root } = openStore()
  try {
    assert.throws(() => store.create({
      tenantKey: 'tenant-a', taskId: 'bad', name: 'bad', ownerDomain: 'domain',
      sshInstanceId: 'maxkb', remotePaths: ['../escape'], localMaxDays: 1, actor: 'owner',
    }), (error: unknown) => error instanceof LogCollectionError && error.code === 'LOG_TASK_INVALID')
  } finally {
    db.close()
    rmSync(root, { recursive: true, force: true })
  }
})

void test('enforces optimistic revision checks', () => {
  const { db, store, root } = openStore()
  try {
    const task = createTask(store)
    const updated = store.update({ tenantKey: 'tenant-a', taskId: task.taskId, expectedRevision: task.revision, actor: 'owner', name: 'OA audit v2' })
    assert.equal(updated.revision, 2)
    assert.throws(() => store.update({ tenantKey: 'tenant-a', taskId: task.taskId, expectedRevision: 1, actor: 'owner', name: 'stale' }), /expected revision/)
  } finally {
    db.close()
    rmSync(root, { recursive: true, force: true })
  }
})

void test('keeps task ids reserved after soft delete', () => {
  const { db, store, root } = openStore()
  try {
    const task = createTask(store)
    store.delete('tenant-a', task.taskId, 'owner')
    assert.equal(store.list('tenant-a').length, 0)
    assert.throws(
      () => createTask(store),
      (error: unknown) => error instanceof LogCollectionError && error.code === 'LOG_TASK_CONFLICT',
    )
  } finally {
    db.close()
    rmSync(root, { recursive: true, force: true })
  }
})

void test('requires an explicit task ACL and supports revoke plus new generation', () => {
  const { db, store, root } = openStore()
  try {
    const task = createTask(store)
    assert.throws(() => store.authorize('tenant-a', task.taskId, 'log_puller', 'pull'), /cannot pull/)
    store.grantAccess('tenant-a', task.taskId, 'log_puller', { canPull: true, canQuery: false }, 'owner')
    assert.equal(store.authorize('tenant-a', task.taskId, 'log_puller', 'pull').taskId, task.taskId)
    store.revokeAccess('tenant-a', task.taskId, 'log_puller', 'owner')
    assert.throws(() => store.authorize('tenant-a', task.taskId, 'log_puller', 'pull'), /cannot pull/)
    store.grantAccess('tenant-a', task.taskId, 'log_puller', { canPull: true, canQuery: false }, 'owner')
    assert.equal(store.listAccess('tenant-a', task.taskId)[0]?.agentPreset, 'log_puller')
  } finally {
    db.close()
    rmSync(root, { recursive: true, force: true })
  }
})

void test('does not leak tasks across tenants', () => {
  const { db, store, root } = openStore()
  try {
    createTask(store)
    assert.equal(store.list('tenant-b').length, 0)
    assert.throws(() => store.get('tenant-b', 'oa_approval'), /not found/)
  } finally {
    db.close()
    rmSync(root, { recursive: true, force: true })
  }
})
void test('resolves a business-local subdirectory and rejects traversal', () => {
  const { db, store, root } = openStore()
  try {
    const task = store.create({
      tenantKey: 'tenant-a',
      taskId: 'oa_approval',
      name: 'OA audit',
      ownerDomain: 'smart_approval',
      sshInstanceId: 'maxkb',
      remotePaths: ['/opt/logs/oa_audit.log'],
      localSubdir: 'smart-approval/logs',
      localMaxDays: 7,
      actor: 'owner',
    })
    assert.equal(task.localSubdir, 'smart-approval/logs')
    assert.equal(store.resolveTaskDirectory(task), join(root, 'smart-approval', 'logs'))
    assert.throws(
      () => store.create({
        tenantKey: 'tenant-a', taskId: 'escape', name: 'Escape', ownerDomain: 'smart_approval',
        sshInstanceId: 'maxkb', remotePaths: ['/opt/logs/a.log'], localSubdir: '../outside',
        localMaxDays: 7, actor: 'owner',
      }),
      (error: unknown) => error instanceof LogCollectionError && error.code === 'LOG_LOCAL_ROOT_INVALID',
    )
  } finally {
    db.close()
    rmSync(root, { recursive: true, force: true })
  }
})
