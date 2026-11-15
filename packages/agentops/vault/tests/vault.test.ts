import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import { openSecret, resolveKeyPath, sealSecret, secretAad, type MasterKey } from '../src/crypto.ts'
import { resolveVaultPath } from '../src/index.ts'
import { ConnectionStore } from '../src/store.ts'
import { probeConnection } from '../src/probe.ts'
import { appendAudit, listCredentialAudit, resolveSecurityDbPath } from '../src/audit.ts'

function withoutHomeOverrides(run: () => void): void {
  const previous = {
    dshHome: process.env.DSH_HOME,
    credDb: process.env.AGENTOPS_CRED_DB,
    credKey: process.env.AGENTOPS_CRED_KEY_FILE,
    securityDb: process.env.AGENTOPS_SECURITY_DB,
  }
  delete process.env.DSH_HOME
  delete process.env.AGENTOPS_CRED_DB
  delete process.env.AGENTOPS_CRED_KEY_FILE
  delete process.env.AGENTOPS_SECURITY_DB
  try {
    run()
  } finally {
    for (const [name, value] of Object.entries({
      DSH_HOME: previous.dshHome,
      AGENTOPS_CRED_DB: previous.credDb,
      AGENTOPS_CRED_KEY_FILE: previous.credKey,
      AGENTOPS_SECURITY_DB: previous.securityDb,
    })) {
      if (value === undefined) Reflect.deleteProperty(process.env, name)
      else process.env[name] = value
    }
  }
}

test('路径：未设 DSH_HOME 时使用 ~/.dsh，不落在仓库工作目录', () => {
  withoutHomeOverrides(() => {
    const home = join(homedir(), '.dsh', 'agentops')
    assert.equal(resolveVaultPath({}), join(home, 'credentials.db'))
    assert.equal(resolveKeyPath(), join(home, 'cred.key'))
    assert.equal(resolveSecurityDbPath(), join(home, 'security.db'))
    assert.notEqual(resolveVaultPath({}), join(process.cwd(), '.dsh', 'agentops', 'credentials.db'))
  })
})

test('路径：DSH_HOME 生效，显式配置优先', () => {
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = join(tmpdir(), 'agentops-home')
  try {
    assert.equal(resolveVaultPath({}), join(tmpdir(), 'agentops-home', 'agentops', 'credentials.db'))
    assert.equal(resolveKeyPath(), join(tmpdir(), 'agentops-home', 'agentops', 'cred.key'))
    assert.equal(resolveSecurityDbPath(), join(tmpdir(), 'agentops-home', 'agentops', 'security.db'))
    assert.equal(resolveVaultPath({ dbPath: join(tmpdir(), 'explicit.db') }), join(tmpdir(), 'explicit.db'))
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
})

function withStore(run: (store: ConnectionStore, dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'agentops-vault-'))
  const key: MasterKey = { key: randomBytes(32), source: 'env' }
  const store = new ConnectionStore(join(dir, 'credentials.db'), key)
  return run(store, dir).finally(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })
}

test('加密：同一明文两次加密密文不同，AAD 不同则打不开', () => {
  const key = randomBytes(32)
  const aad = secretAad('database', 'audit_reader')
  const first = sealSecret(key, 'p@ss', aad)
  const second = sealSecret(key, 'p@ss', aad)
  assert.notEqual(first, second, 'nonce 必须随机')
  assert.equal(openSecret(key, first, aad), 'p@ss')
  assert.throws(() => openSecret(key, first, secretAad('database', 'other')), /unable to authenticate|bad decrypt/i)
  assert.throws(() => openSecret(randomBytes(32), first, aad), /unable to authenticate|bad decrypt/i)
})

test('存储：列表不含密文，hasSecret 如实反映；留空密码不改动', async () => {
  await withStore(async (store) => {
    store.upsert({
      id: 'audit_reader', kind: 'database', name: '智能审批业务数据', driver: 'mysql',
      host: '192.0.2.10', port: 3306, username: 'audit_reader', defaultDatabase: 'audit_example',
      enabled: true, password: 'secret-1',
    })
    const first = store.list('database')[0]!
    assert.equal(first.hasSecret, true)
    assert.equal(JSON.stringify(first).includes('secret-1'), false, '列表不得回传明文')
    assert.equal(JSON.stringify(first).includes('v1.'), false, '列表不得回传密文')

    // Update without password keeps the old secret.
    store.upsert({
      id: 'audit_reader', kind: 'database', name: '改名', driver: 'mysql',
      host: '192.0.2.10', port: 3306, username: 'audit_reader', defaultDatabase: 'audit_example',
      enabled: false,
    })
    assert.equal(store.readSecret('audit_reader'), 'secret-1')
    assert.equal(store.get('audit_reader')?.name, '改名')
    assert.equal(store.get('audit_reader')?.enabled, false)

    // Rotating replaces it.
    store.upsert({
      id: 'audit_reader', kind: 'database', name: '改名', driver: 'mysql',
      host: '192.0.2.10', port: 3306, username: 'audit_reader', defaultDatabase: 'audit_example',
      enabled: true, password: 'secret-2',
    })
    assert.equal(store.readSecret('audit_reader'), 'secret-2')
  })
})

test('存储：类型不可改，删除后读不到', async () => {
  await withStore(async (store) => {
    store.upsert({
      id: 'host-1', kind: 'server', name: '构建机', driver: 'ssh',
      host: '10.0.0.9', port: 22, username: 'deploy', defaultDatabase: null, enabled: true,
    })
    assert.throws(() => store.upsert({
      id: 'host-1', kind: 'database', name: '构建机', driver: 'mysql',
      host: '10.0.0.9', port: 3306, username: 'deploy', defaultDatabase: null, enabled: true,
    }), /不可修改/)

    assert.equal(store.remove('host-1'), true)
    assert.equal(store.get('host-1'), null)
  })
})

test('探测：SQLite 可读文件成功，缺失文件失败且带原因', async () => {
  await withStore(async (store, dir) => {
    const { DatabaseSync } = await import('node:sqlite')
    const file = join(dir, 'audit.db')
    new DatabaseSync(file).close()

    store.upsert({
      id: 'local', kind: 'database', name: '本地', driver: 'sqlite',
      host: file, port: null, username: '', defaultDatabase: null, enabled: true,
    })
    const ok = await probeConnection(store.get('local')!, null)
    assert.equal(ok.ok, true)

    const missing = await probeConnection({
      ...store.get('local')!, host: join(dir, 'nope.db'),
    }, null)
    assert.equal(missing.ok, false)
    assert.ok(missing.detail.length > 0)
  })
})

test('审计：写进 security.db 的 audit_events，detail 不含密码', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentops-audit-'))
  const path = join(dir, 'security.db')
  try {
    appendAudit({ action: 'connection.create', target: 'audit_reader', result: 'ok', detail: { driver: 'mysql' } }, { path, at: '2026-10-25T21:00:00.000Z' })
    appendAudit({ action: 'connection.secret.set', target: 'audit_reader', result: 'ok' }, { path })
    appendAudit({ action: 'connection.test', target: 'audit_reader', result: 'fail', detail: { error: 'ECONNREFUSED' } }, { path })

    const rows = listCredentialAudit(10, path)
    assert.equal(rows.length, 3)
    assert.equal(rows[0]?.action, 'connection.test')
    assert.equal(rows[0]?.actor, 'owner')
    assert.equal(rows[0]?.detail.result, 'fail')
    const serialized = JSON.stringify(rows)
    assert.equal(serialized.includes('password'), false)
    assert.equal(serialized.includes('v1.'), false)
    assert.deepEqual(listCredentialAudit(10, join(dir, 'missing.db')), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
