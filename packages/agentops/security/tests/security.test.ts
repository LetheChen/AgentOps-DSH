import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { SecurityStore, summarizeUsage } from '../src/index.ts'

const NOW = '2026-10-25T00:00:00+08:00'

function withStore(run: (store: SecurityStore) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'agentops-security-'))
  const store = new SecurityStore(join(dir, 'security.db'))
  try {
    run(store)
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

void test('用户：创建、查询、邮箱唯一', () => {
  withStore((store) => {
    const user = store.createUser({ id: 'u1', name: '陈工', email: 'chen@example.com', actor: 'admin', now: NOW })
    assert.equal(user.status, 'active')
    assert.equal(store.listUsers().length, 1)

    assert.throws(
      () => store.createUser({ id: 'u2', name: '重复', email: 'chen@example.com', actor: 'admin', now: NOW }),
      /UNIQUE|unique/i,
    )
    // 失败事务不应留下半个用户
    assert.equal(store.listUsers().length, 1)
  })
})

void test('用户：禁用与恢复都写审计', () => {
  withStore((store) => {
    store.createUser({ id: 'u1', name: 'A', actor: 'admin', now: NOW })
    const v1 = store.getUser('u1')!.version
    store.setUserStatus({ id: 'u1', status: 'disabled', actor: 'admin', expectedVersion: v1, now: NOW })
    assert.equal(store.getUser('u1')!.status, 'disabled')
    assert.equal(store.getUser('u1')!.version, v1 + 1)
    store.setUserStatus({ id: 'u1', status: 'active', actor: 'admin', expectedVersion: v1 + 1, now: NOW })

    const actions = store.listAudit().map(event => event.action)
    assert.deepEqual(actions.slice(0, 3), ['user.status', 'user.status', 'user.create'])
    assert.equal(store.listAudit()[0]!.detail.to, 'active')
  })
})

void test('用户：陈旧版本被拒绝，不覆盖并发修改', () => {
  withStore((store) => {
    store.createUser({ id: 'u1', name: 'A', actor: 'admin', now: NOW })
    const version = store.getUser('u1')!.version
    store.setUserStatus({ id: 'u1', status: 'disabled', actor: 'admin', expectedVersion: version, now: NOW })
    assert.throws(
      () => store.setUserStatus({ id: 'u1', status: 'active', actor: 'admin', expectedVersion: version, now: NOW }),
      /version conflict/,
    )
    assert.equal(store.getUser('u1')!.status, 'disabled')
  })
})

void test('Token：只存哈希，明文不可回读，撤销后校验失败', () => {
  withStore((store) => {
    store.createUser({ id: 'u1', name: 'A', actor: 'admin', now: NOW })
    const secret = 'aops_secret_value'
    const token = store.createToken({ id: 't1', userId: 'u1', name: 'CI', secret, actor: 'admin', now: NOW })
    assert.equal(token.prefix, 'aops_sec')

    const raw = JSON.stringify(store.listTokens('u1'))
    assert.equal(raw.includes(secret), false, '明文不得落库或回传')

    assert.equal(store.verifyToken(secret)?.id, 't1')
    store.revokeToken({ id: 't1', actor: 'admin', now: NOW })
    assert.equal(store.verifyToken(secret), null)
    assert.ok(store.listAudit().some(event => event.action === 'token.revoke'))
  })
})

void test('角色：授权合并去重，未授权用户为空', () => {
  withStore((store) => {
    store.createUser({ id: 'u1', name: 'A', actor: 'admin', now: NOW })
    store.createRole({ id: 'viewer', name: '只读', permissions: ['task.read', 'kb.read'], actor: 'admin', now: NOW })
    store.createRole({ id: 'operator', name: '操作', permissions: ['task.read', 'task.advance'], actor: 'admin', now: NOW })

    store.assignRole({ userId: 'u1', roleId: 'viewer', grantedBy: 'admin', now: NOW })
    store.assignRole({ userId: 'u1', roleId: 'operator', grantedBy: 'admin', now: NOW })
    // 重复授权幂等
    store.assignRole({ userId: 'u1', roleId: 'operator', grantedBy: 'admin', now: NOW })

    assert.deepEqual(store.permissionsOf('u1'), ['kb.read', 'task.advance', 'task.read'])
    assert.equal(store.listAssignments('u1').length, 2)
    assert.deepEqual(store.permissionsOf('nobody'), [])
  })
})

void test('用量：按模型与用户聚合，总数为各项之和', () => {
  withStore((store) => {
    store.recordUsage({ id: 'r1', userId: 'u1', agent: 'a', provider: 'p1', model: 'm1', promptTokens: 10, completionTokens: 5, at: NOW })
    store.recordUsage({ id: 'r2', userId: 'u1', agent: 'a', provider: 'p1', model: 'm1', promptTokens: 20, completionTokens: 10, at: NOW })
    store.recordUsage({ id: 'r3', userId: 'u2', agent: 'b', model: 'm2', promptTokens: 1, completionTokens: 1, at: NOW })

    const summary = store.usage()
    assert.equal(summary.calls, 3)
    assert.equal(summary.promptTokens, 31)
    assert.equal(summary.completionTokens, 16)
    assert.equal(summary.totalTokens, 47)
    assert.deepEqual(summary.byModel[0], { model: 'm1', tokens: 45, calls: 2 })
    assert.deepEqual(summary.byUser[0], { userId: 'u1', tokens: 45, calls: 2 })
    assert.equal(store.recentUsage().find(row => row.id === 'r3')!.provider, 'unknown')
  })
})

void test('用量：旧数据库原位补 provider 列，历史行标记为 unknown', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentops-security-legacy-'))
  const path = join(dir, 'security.db')
  const db = new DatabaseSync(path)
  db.exec(`
    CREATE TABLE usage_records (
      id                TEXT PRIMARY KEY,
      user_id           TEXT NOT NULL,
      session_id        TEXT,
      agent             TEXT NOT NULL,
      model             TEXT NOT NULL,
      prompt_tokens     INTEGER NOT NULL,
      completion_tokens INTEGER NOT NULL,
      total_tokens      INTEGER NOT NULL,
      at                TEXT NOT NULL
    );
    INSERT INTO usage_records(id, user_id, session_id, agent, model, prompt_tokens, completion_tokens, total_tokens, at)
    VALUES ('legacy', 'u1', NULL, 'chat', 'old-model', 2, 3, 5, '2026-10-20T00:00:00.000Z');
  `)
  db.close()

  const store = new SecurityStore(path)
  try {
    const legacy = store.recentUsage()[0]!
    assert.equal(legacy.provider, 'unknown')
    store.recordUsage({ id: 'new', userId: 'u1', agent: 'chat', provider: 'ds', model: 'new-model', promptTokens: 1, completionTokens: 1, at: NOW })
    assert.equal(store.recentUsage()[0]!.provider, 'ds')
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

void test('会话：开始与结束，结束后不可再被当作 active', () => {
  withStore((store) => {
    store.createUser({ id: 'u1', name: 'A', actor: 'admin', now: NOW })
    store.startSession({ id: 's1', userId: 'u1', agent: 'manager', now: NOW })
    assert.equal(store.listSessions('u1')[0]!.status, 'active')

    store.endSession({ id: 's1', actor: 'u1', now: NOW })
    const session = store.listSessions('u1')[0]!
    assert.equal(session.status, 'ended')
    assert.equal(session.endedAt, NOW)
    assert.ok(store.listAudit().some(event => event.action === 'session.end'))
  })
})

void test('summarizeUsage：空输入不产生假数据', () => {
  assert.deepEqual(summarizeUsage([]), {
    totalTokens: 0, promptTokens: 0, completionTokens: 0, calls: 0, byModel: [], byUser: [],
  })
})
