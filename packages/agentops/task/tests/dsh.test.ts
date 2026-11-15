import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import assert from 'node:assert/strict'

import { apply, resolveTaskDbPath } from '../src/dsh.ts'
import { SCHEMA_VERSION } from '../src/schema.ts'

function fakeContext(intercepted: { matches: (endpoint: string) => boolean }[], routes: string[]): Record<string, unknown> {
  const ctx: Record<string, unknown> = {}
  ctx.inject = (_deps: string[], fn: (value: unknown) => void) => { fn(ctx) }
  ctx.effect = (fn: () => unknown) => { fn(); return () => {} }
  ctx.get = (name: string) => name === 'workspaceRegistry' ? { list: () => [] } : undefined
  ctx.connection = {
    rpc: {
      intercept: (_channel: string, matches: (endpoint: string) => boolean) => {
        intercepted.push({ matches })
        return Promise.resolve(() => Promise.resolve())
      },
    },
    fetch: {
      register: (route: { path: string }) => {
        routes.push(route.path)
        return () => {}
      },
    },
  }
  return ctx
}

void test('dbPath 解析：配置 > 环境变量 > DSH_HOME', () => {
  assert.equal(resolveTaskDbPath({ dbPath: '/x/t.db' }), '/x/t.db')
  assert.equal(resolveTaskDbPath({}, { AGENTOPS_TASK_DB: '/env/t.db' }, '/home/u'), '/env/t.db')
  assert.equal(resolveTaskDbPath({}, { DSH_HOME: '/dsh' }, '/home/u'), join('/dsh', 'agentops', 'agentops.db'))
})

void test('挂载 v1：注册 RPC 拦截与浏览器桥', () => {
  const intercepted: { matches: (endpoint: string) => boolean }[] = []
  const routes: string[] = []
  const ctx = fakeContext(intercepted, routes)
  apply(ctx as never, { dbPath: ':memory:' })
  assert.equal(intercepted.length, 1)
  assert.equal(intercepted[0]!.matches('agentops/tasks'), true)
  assert.equal(intercepted[0]!.matches('agentops/agents'), false)
  assert.deepEqual(routes, ['/api/agentops/task-rpc', '/api/agentops/task-execute'])
})

void test('新文件建库，旧结构拒绝挂载', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentops-task-v1-'))
  const ctx = fakeContext([], [])

  const fresh = join(dir, 'fresh.db')
  apply(ctx as never, { dbPath: fresh })
  const created = new DatabaseSync(fresh)
  assert.equal(created.prepare('PRAGMA user_version').get()?.user_version, SCHEMA_VERSION)
  created.close()

  const legacy = join(dir, 'legacy.db')
  const old = new DatabaseSync(legacy)
  old.exec('CREATE TABLE tasks (id TEXT PRIMARY KEY)')
  old.close()
  assert.throws(
    () => { apply(ctx as never, { dbPath: legacy }) },
    new RegExp(`schema version 0 is not ${SCHEMA_VERSION}`),
  )

  try {
    rmSync(dir, { recursive: true, force: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error
    // The mounted plugin still owns the fresh database handle on Windows.
  }
})
