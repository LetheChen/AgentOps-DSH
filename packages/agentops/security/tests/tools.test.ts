import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../src/tools.ts'
import { SecurityStore } from '../src/store.ts'

interface Tool {
  name: string
  execute: (args: Record<string, unknown>, exec: unknown) => Promise<Record<string, unknown>>
}

function mount(): { tools: Map<string, Tool>; dir: string; store: SecurityStore } {
  const dir = mkdtempSync(join(tmpdir(), 'agentops-sectools-'))
  const store = new SecurityStore(join(dir, 'security.db'))
  const tools = new Map<string, Tool>()
  const ctx = {
    tools: { register: (tool: Tool) => { tools.set(tool.name, tool); return () => {} } },
  }
  apply(ctx as never, { dbPath: join(dir, 'security.db'), store })
  return { tools, dir, store }
}

void test('工具挂载：四个写工具都在，且都注入 tools', () => {
  const { tools, dir, store } = mount()
  try {
    assert.deepEqual([...tools.keys()].sort(), [
      'security_role_assign', 'security_token_issue', 'security_user_create', 'security_user_set_status',
    ])
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

void test('security_user_create：缺 reason 由参数 schema 拦截（execute 仍写审计）', async () => {
  const { tools, dir, store } = mount()
  try {
    const created = await tools.get('security_user_create')!.execute(
      { name: '陈工', email: 'chen@example.com', reason: '入职开通' }, {},
    )
    assert.equal(created.ok, true)
    assert.ok(typeof created.id === 'string')

    const actions = store.listAudit().map(event => event.action)
    assert.ok(actions.includes('user.create'))
    assert.ok(actions.includes('user.create.reason'))
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

void test('security_user_set_status：无 confirm 拒绝，陈旧版本拒绝，正常路径升版本', async () => {
  const { tools, dir, store } = mount()
  try {
    const created = await tools.get('security_user_create')!.execute({ name: 'A', reason: 'r' }, {})
    const id = created.id as string
    const version = created.version as number

    const refused = await tools.get('security_user_set_status')!.execute(
      { userId: id, status: 'disabled', expectedVersion: version, confirm: false }, {},
    )
    assert.equal(refused.ok, false)
    assert.match(refused.error as string, /confirm/)

    const bad = await tools.get('security_user_set_status')!.execute(
      { userId: id, status: 'magic', expectedVersion: version, confirm: true }, {},
    )
    assert.equal(bad.ok, false)

    const ok = await tools.get('security_user_set_status')!.execute(
      { userId: id, status: 'disabled', expectedVersion: version, confirm: true, reason: '离职' }, {},
    )
    assert.equal(ok.ok, true)
    assert.equal(ok.version, version + 1)

    const stale = await tools.get('security_user_set_status')!.execute(
      { userId: id, status: 'active', expectedVersion: version, confirm: true }, {},
    )
    assert.equal(stale.ok, false)
    assert.match(stale.error as string, /version conflict/)
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

void test('security_role_assign：角色/用户不存在被拒，成功返回合并权限', async () => {
  const { tools, dir, store } = mount()
  try {
    const created = await tools.get('security_user_create')!.execute({ name: 'B', reason: 'r' }, {})
    const id = created.id as string
    store.createRole({ id: 'viewer', name: '只读', permissions: ['kb.read', 'task.read'], actor: 'seed' })

    const missingRole = await tools.get('security_role_assign')!.execute(
      { userId: id, roleId: 'nope', justification: 'x' }, {},
    )
    assert.equal(missingRole.ok, false)

    const granted = await tools.get('security_role_assign')!.execute(
      { userId: id, roleId: 'viewer', justification: '只读排查' }, {},
    )
    assert.equal(granted.ok, true)
    assert.deepEqual(granted.permissions, ['kb.read', 'task.read'])
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

void test('security_token_issue：无 confirm 拒绝；成功后只回一次明文，库里只有哈希', async () => {
  const { tools, dir, store } = mount()
  try {
    const created = await tools.get('security_user_create')!.execute({ name: 'C', reason: 'r' }, {})
    const id = created.id as string

    const refused = await tools.get('security_token_issue')!.execute(
      { userId: id, name: 'CI', reason: 'x', confirm: false }, {},
    )
    assert.equal(refused.ok, false)

    const issued = await tools.get('security_token_issue')!.execute(
      { userId: id, name: 'CI', reason: '流水线', confirm: true }, {},
    )
    assert.equal(issued.ok, true)
    const token = issued.token as string
    assert.match(token, /^aops_/)

    assert.equal(JSON.stringify(store.listTokens(id)).includes(token), false, '明文不得落库')
    assert.equal(store.verifyToken(token)?.id, issued.id)
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
