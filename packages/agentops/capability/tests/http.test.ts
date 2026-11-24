import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { CapabilityHttpApi } from '../src/http.ts'
import { CapabilityStore } from '../src/store.ts'
import type { MasterKey } from '../../vault/src/crypto.ts'

const key: MasterKey = { key: Buffer.alloc(32, 9), source: 'env' }

function fixture(): { store: CapabilityStore; api: CapabilityHttpApi } {
  const store = new CapabilityStore(':memory:', key)
  return { store, api: new CapabilityHttpApi(store) }
}

void test('catalog and instance reads use stable capability routes', async () => {
  const { store, api } = fixture()
  try {
    const catalog = await api.handle({ method: 'GET', path: '/api/agentops/capabilities/catalog' })
    assert.equal(catalog.status, 200)
    const catalogBody = catalog.body as { capabilities: unknown[] }
    assert.equal(catalogBody.capabilities.length, 11)

    const created = await api.handle({
      method: 'POST',
      path: '/api/agentops/capabilities/integrations',
      body: {
        instanceId: 'int_wecom',
        capability_id: 'wecom',
        name: 'Ops group',
        config: { webhook_host: 'qyapi.weixin.qq.com' },
        secret: 'webhook-secret',
      },
    })
    assert.equal(created.status, 201)
    const createdBody = created.body as { integration: { credentialConfigured: boolean } }
    assert.equal(createdBody.integration.credentialConfigured, true)

    const list = await api.handle({ method: 'GET', path: '/api/agentops/capabilities/integrations', query: { capability_id: 'wecom' } })
    assert.equal(list.status, 200)
    assert.equal((list.body as { integrations: unknown[] }).integrations.length, 1)
  } finally {
    store.close()
  }
})

void test('tool catalogue exposes runtime and interface declarations with capability filters', async () => {
  const { store, api } = fixture()
  try {
    const all = await api.handle({ method: 'GET', path: '/api/agentops/capabilities/tools' })
    assert.equal(all.status, 200)
    const tools = (all.body as { tools: Array<Record<string, unknown>> }).tools
    assert.equal(tools.length, 25)
    const sql = tools.find(item => item.toolId === 'sql_query')
    assert.equal(sql?.runtimeAvailable, true)
    assert.equal(sql?.declarationKind, 'runtime_tool')
    const oa = tools.find(item => item.toolId === 'oa_rest')
    assert.equal(oa?.runtimeAvailable, true)
    assert.equal(oa?.declarationKind, 'runtime_tool')
    const oaDetail = tools.find(item => item.toolId === 'oa_affair_detail')
    assert.equal(oaDetail?.declarationKind, 'runtime_tool')
    assert.equal(oaDetail?.runtimeAvailable, true)
    const feishuDocs = tools.find(item => item.toolId === 'feishu_docs_rest')
    assert.equal(feishuDocs?.runtimeAvailable, false)
    assert.equal(feishuDocs?.declarationKind, 'interface')
    const browser = tools.find(item => item.toolId === 'browser_use_chrome_devtools_mcp')
    assert.equal(browser?.runtimeAvailable, true)
    assert.equal(browser?.declarationKind, 'runtime_tool')
    assert.equal(browser?.requiresCapabilityInstance, false)
    const feishuDocsList = tools.find(item => item.toolId === 'feishu_docs_list')
    assert.equal(feishuDocsList?.runtimeAvailable, true)
    assert.equal(feishuDocsList?.declarationKind, 'runtime_tool')
    const feishuDocsRead = tools.find(item => item.toolId === 'feishu_docs_read')
    assert.equal(feishuDocsRead?.runtimeAvailable, true)
    assert.equal(feishuDocsRead?.declarationKind, 'runtime_tool')

    const filtered = await api.handle({
      method: 'GET', path: '/api/agentops/capabilities/tools', query: { capability_id: 'database' },
    })
    assert.equal(filtered.status, 200)
    const databaseTools = (filtered.body as { tools: Array<{ capabilityId: string }> }).tools
    assert.equal(databaseTools.length, 3)
    assert.equal(databaseTools.every(item => item.capabilityId === 'database'), true)
  } finally {
    store.close()
  }
})

void test('catalog exposes schema options for fields that constrain runtime values', async () => {
  const { store, api } = fixture()
  try {
    const response = await api.handle({ method: 'GET', path: '/api/agentops/capabilities/catalog' })
    assert.equal(response.status, 200)
    const capabilities = (response.body as {
      capabilities: Array<{ capabilityId: string; configSchema: Array<{ key: string; options?: string[] }> }>
    }).capabilities
    const database = capabilities.find(item => item.capabilityId === 'database')
    assert.deepEqual(database?.configSchema.find(field => field.key === 'engine')?.options, ['mysql', 'postgres', 'sqlite'])
    const ssh = capabilities.find(item => item.capabilityId === 'ssh')
    assert.deepEqual(ssh?.configSchema.find(field => field.key === 'auth_type')?.options, ['password', 'private_key'])
  } finally {
    store.close()
  }
})

void test('patch updates an instance and preserves credential presence', async () => {
  const { store, api } = fixture()
  try {
    const created = await api.handle({
      method: 'POST', path: '/api/agentops/capabilities/integrations',
      body: { instanceId: 'int_wecom', capabilityId: 'wecom', name: 'Old', config: { webhook_host: 'qyapi.weixin.qq.com' }, secret: 'secret' },
    })
    assert.equal(created.status, 201, JSON.stringify(created.body))
    const patched = await api.handle({
      method: 'PATCH', path: '/api/agentops/capabilities/integrations/int_wecom',
      body: { name: 'New' },
    })
    assert.equal(store.getInstance('int_wecom') !== null, true, JSON.stringify(store.listInstances()))
    assert.equal(patched.status, 200, JSON.stringify(patched.body))
    const body = patched.body as { integration: { name: string; credentialConfigured: boolean } }
    assert.equal(body.integration.name, 'New')
    assert.equal(body.integration.credentialConfigured, true)
  } finally {
    store.close()
  }
})

void test('binding replacement validates the complete set before committing', async () => {
  const { store, api } = fixture()
  try {
    const created = await api.handle({
      method: 'POST', path: '/api/agentops/capabilities/integrations',
      body: { instanceId: 'int_wecom', capabilityId: 'wecom', name: 'Ops', config: { webhook_host: 'qyapi.weixin.qq.com' }, secret: 'secret' },
    })
    assert.equal(created.status, 201, JSON.stringify(created.body))
    const response = await api.handle({
      method: 'PUT', path: '/api/agentops/capabilities/bindings',
      body: {
        agent_preset: 'manager',
        bindings: [
          { capability_id: 'wecom', instance_id: 'int_wecom', enabled: true },
          { capability_id: 'wecom', instance_id: 'missing', enabled: true },
        ],
      },
    })
    assert.equal(response.status, 400)
    const state = await api.handle({
      method: 'GET', path: '/api/agentops/capabilities/bindings', query: { agent_preset: 'manager' },
    })
    assert.deepEqual((state.body as { bindings: unknown[] }).bindings, [])
  } finally {
    store.close()
  }
})

void test('safe views never expose credential references or ciphertext', async () => {
  const { store, api } = fixture()
  try {
    const response = await api.handle({
      method: 'POST', path: '/api/agentops/capabilities/integrations',
      body: { instanceId: 'int_wecom', capabilityId: 'wecom', name: 'Ops', config: { webhook_host: 'qyapi.weixin.qq.com' }, secret: 'secret' },
    })
    const serialized = JSON.stringify(response.body)
    assert.equal(serialized.includes('secret"),'), false)
    assert.equal(serialized.includes('credential_cipher'), false)
    assert.equal(serialized.includes('credentialConfigured'), true)
  } finally {
    store.close()
  }
})

void test('test route probes a saved SQLite instance and records success', async () => {
  const { store, api } = fixture()
  const dir = mkdtempSync(join(tmpdir(), 'agentops-capability-probe-'))
  const path = join(dir, 'probe.db')
  const db = new DatabaseSync(path)
  db.exec('CREATE TABLE probe(id INTEGER PRIMARY KEY); INSERT INTO probe VALUES (1);')
  db.close()
  try {
    const created = await api.handle({
      method: 'POST', path: '/api/agentops/capabilities/integrations',
      body: {
        instanceId: 'int_probe', capabilityId: 'database', name: 'Probe',
        config: { engine: 'sqlite', host: path }, secret: 'probe-secret',
        access_policy: { allowed_tables: { probe: ['probe'] } },
      },
    })
    assert.equal(created.status, 201, JSON.stringify(created.body))
    const response = await api.handle({
      method: 'POST', path: '/api/agentops/capabilities/integrations/int_probe/test',
    })
    assert.equal(response.status, 200, JSON.stringify(response.body))
    const body = response.body as { ok: boolean; integration: { lastTestStatus: string; lastTestError: string | null } }
    assert.equal(body.ok, true)
    assert.equal(body.integration.lastTestStatus, 'succeeded')
    assert.equal(body.integration.lastTestError, null)
    const audit = await api.handle({ method: 'GET', path: '/api/agentops/capabilities/audit' })
    assert.equal(JSON.stringify(audit.body).includes('secret'), false)
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})


void test('test route probes Feishu docs through the saved encrypted App Secret', async () => {
  const { store, api } = fixture()
  const original = globalThis.fetch
  globalThis.fetch = async (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : String(input)
    if (url.endsWith('/open-apis/auth/v3/tenant_access_token/internal')) {
      return Response.json({ code: 0, msg: 'ok', tenant_access_token: 't-test-token' })
    }
    if (url.endsWith('/open-apis/drive/v1/files?page_size=1')) {
      return Response.json({ code: 0, msg: 'ok', data: { files: [] } })
    }
    throw new Error(`unexpected URL ${url}`)
  }
  try {
    const created = await api.handle({
      method: 'POST', path: '/api/agentops/capabilities/integrations',
      body: {
        instanceId: 'int_feishu_docs', capabilityId: 'feishu-docs', name: 'Feishu docs',
        config: { app_id: 'cli_test', base_url: 'https://open.feishu.cn' }, secret: 'app-secret',
      },
    })
    assert.equal(created.status, 201, JSON.stringify(created.body))
    assert.equal(JSON.stringify(created.body).includes('app-secret'), false)
    const response = await api.handle({
      method: 'POST', path: '/api/agentops/capabilities/integrations/int_feishu_docs/test',
    })
    assert.equal(response.status, 200, JSON.stringify(response.body))
    const body = response.body as { ok: boolean; integration: { lastTestStatus: string } }
    assert.equal(body.ok, true)
    assert.equal(body.integration.lastTestStatus, 'succeeded')
  } finally {
    globalThis.fetch = original
    store.close()
  }
})

void test('test route records a real SQLite failure reason', async () => {
  const { store, api } = fixture()
  try {
    await api.handle({
      method: 'POST', path: '/api/agentops/capabilities/integrations',
      body: {
        instanceId: 'int_missing_db', capabilityId: 'database', name: 'Missing',
        config: { engine: 'sqlite', host: join(tmpdir(), 'agentops-does-not-exist.db') }, secret: 'secret',
        access_policy: { allowed_tables: { probe: ['probe'] } },
      },
    })
    const response = await api.handle({
      method: 'POST', path: '/api/agentops/capabilities/integrations/int_missing_db/test',
    })
    assert.equal(response.status, 200, JSON.stringify(response.body))
    const body = response.body as { ok: boolean; integration: { lastTestStatus: string; lastTestError: string | null } }
    assert.equal(body.ok, false)
    assert.equal(body.integration.lastTestStatus, 'failed')
    assert.match(body.integration.lastTestError ?? '', /cannot open|unable to open/i)
  } finally {
    store.close()
  }
})

void test('test route reports an SSH login failure instead of unsupported', async () => {
  const { store, api } = fixture()
  try {
    await api.handle({
      method: 'POST', path: '/api/agentops/capabilities/integrations',
      body: {
        instanceId: 'int_ssh', capabilityId: 'ssh', name: 'SSH test',
        config: { host: '127.0.0.1', port: 1, username: 'tester' }, secret: 'secret',
      },
    })
    const response = await api.handle({
      method: 'POST', path: '/api/agentops/capabilities/integrations/int_ssh/test',
    })
    assert.equal(response.status, 200, JSON.stringify(response.body))
    const body = response.body as { ok: boolean; message: string; integration: { lastTestStatus: string } }
    assert.equal(body.ok, false)
    assert.equal(body.integration.lastTestStatus, 'failed')
    assert.doesNotMatch(body.message, /尚未接入运行探测/)
  } finally {
    store.close()
  }
})


void test('host-key route reads a fingerprint without a saved instance or secret', async () => {
  const { store, api } = fixture()
  try {
    const missingHost = await api.handle({
      method: 'POST', path: '/api/agentops/capabilities/ssh/host-key', body: { port: 22 },
    })
    assert.equal(missingHost.status, 400)
    assert.equal((missingHost.body as { error: { code: string } }).error.code, 'CAPABILITY_CONFIG_INVALID')

    const badPort = await api.handle({
      method: 'POST', path: '/api/agentops/capabilities/ssh/host-key', body: { host: '127.0.0.1', port: 0 },
    })
    assert.equal(badPort.status, 400)
    assert.equal((badPort.body as { error: { code: string } }).error.code, 'CAPABILITY_CONFIG_INVALID')

    const refused = await api.handle({
      method: 'POST', path: '/api/agentops/capabilities/ssh/host-key', body: { host: '127.0.0.1', port: 1 },
    })
    assert.equal(refused.status, 400, JSON.stringify(refused.body))
    assert.equal((refused.body as { error: { code: string } }).error.code, 'SSH_HOST_KEY_UNREACHABLE')

    const wrongMethod = await api.handle({
      method: 'GET', path: '/api/agentops/capabilities/ssh/host-key',
    })
    assert.equal(wrongMethod.status, 404)
  } finally {
    store.close()
  }
})

void test('tables route lists real base tables for a database instance', async () => {
  const { store, api } = fixture()
  const dir = mkdtempSync(join(tmpdir(), 'agentops-capability-tables-'))
  const path = join(dir, 'tables.db')
  const db = new DatabaseSync(path)
  db.exec('CREATE TABLE audit_records(id INTEGER PRIMARY KEY); CREATE TABLE users(id INTEGER PRIMARY KEY);')
  db.close()
  try {
    const created = await api.handle({
      method: 'POST', path: '/api/agentops/capabilities/integrations',
      body: {
        instanceId: 'int_tables', capabilityId: 'database', name: 'Tables',
        config: { engine: 'sqlite', host: path }, secret: 'probe-secret',
      },
    })
    assert.equal(created.status, 201, JSON.stringify(created.body))
    const response = await api.handle({
      method: 'POST', path: '/api/agentops/capabilities/integrations/int_tables/tables',
    })
    assert.equal(response.status, 200, JSON.stringify(response.body))
    const body = response.body as { ok: boolean; tables: { name: string }[] }
    assert.equal(body.ok, true)
    assert.deepEqual(body.tables.map(table => table.name), ['audit_records', 'users'])

    await api.handle({
      method: 'POST', path: '/api/agentops/capabilities/integrations',
      body: { instanceId: 'int_ssh_tables', capabilityId: 'ssh', name: 'SSH', config: { host: 'h', username: 'u' }, secret: 's' },
    })
    const wrongKind = await api.handle({
      method: 'POST', path: '/api/agentops/capabilities/integrations/int_ssh_tables/tables',
    })
    assert.equal(wrongKind.status, 400)
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

void test('a webhook instance stores only the host and validates the URL credential', async () => {
  const { store, api } = fixture()
  try {
    const created = await api.handle({
      method: 'POST', path: '/api/agentops/capabilities/integrations',
      body: {
        instanceId: 'int_wecom_hook', capabilityId: 'wecom', name: '智能审批运行日志监测',
        config: { webhook_host: 'QYAPI.WEIXIN.QQ.COM', mentions: 'ops, oncall', timeout_seconds: '10' },
        secret: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abc-123',
      },
    })
    assert.equal(created.status, 201, JSON.stringify(created.body))
    const saved = (created.body as { integration: { config: Record<string, unknown> } }).integration
    assert.equal(saved.config.webhook_host, 'qyapi.weixin.qq.com')
    assert.deepEqual(saved.config.mentions, ['ops', 'oncall'])
    assert.equal(saved.config.timeout_seconds, 10)
    // The webhook URL never appears in the browser projection.
    assert.equal(JSON.stringify(created.body).includes('abc-123'), false)

    const tested = await api.handle({
      method: 'POST', path: '/api/agentops/capabilities/integrations/int_wecom_hook/test',
    })
    assert.equal(tested.status, 200, JSON.stringify(tested.body))
    const probe = tested.body as { ok: boolean; message: string }
    assert.equal(probe.ok, true)
    assert.match(probe.message, /未发送消息/)
    assert.equal(probe.message.includes('abc-123'), false)
  } finally {
    store.close()
  }
})

void test('a webhook host rejects a URL, a path and a mismatched credential host', async () => {
  const { store, api } = fixture()
  try {
    for (const host of ['https://qyapi.weixin.qq.com', 'qyapi.weixin.qq.com/cgi-bin/webhook', '']) {
      const rejected = await api.handle({
        method: 'POST', path: '/api/agentops/capabilities/integrations',
        body: { instanceId: 'int_bad_host', capabilityId: 'wecom', name: 'Bad', config: { webhook_host: host }, secret: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=x' },
      })
      assert.equal(rejected.status, 400, `host ${JSON.stringify(host)} should be rejected`)
      assert.equal((rejected.body as { error: { code: string } }).error.code, 'CAPABILITY_CONFIG_INVALID')
    }

    await api.handle({
      method: 'POST', path: '/api/agentops/capabilities/integrations',
      body: {
        instanceId: 'int_mismatch', capabilityId: 'wecom', name: 'Mismatch',
        config: { webhook_host: 'qyapi.weixin.qq.com' },
        secret: 'https://open.feishu.cn/open-apis/bot/v2/hook/token',
      },
    })
    const tested = await api.handle({
      method: 'POST', path: '/api/agentops/capabilities/integrations/int_mismatch/test',
    })
    const probe = tested.body as { ok: boolean; message: string }
    assert.equal(probe.ok, false)
    assert.match(probe.message, /Webhook 主机不在允许范围/)
  } finally {
    store.close()
  }
})

void test('a feishu-bot instance accepts both official hosts and rejects http', async () => {
  const { store, api } = fixture()
  try {
    for (const host of ['open.feishu.cn', 'open.larksuite.com']) {
      const created = await api.handle({
        method: 'POST', path: '/api/agentops/capabilities/integrations',
        body: {
          instanceId: `int_feishu_${host.includes('lark') ? 'lark' : 'feishu'}`,
          capabilityId: 'feishu-bot', name: host, config: { webhook_host: host },
          secret: `https://${host}/open-apis/bot/v2/hook/token`,
        },
      })
      assert.equal(created.status, 201, JSON.stringify(created.body))
    }
    const insecure = await api.handle({
      method: 'POST', path: '/api/agentops/capabilities/integrations',
      body: {
        instanceId: 'int_feishu_http', capabilityId: 'feishu-bot', name: 'Insecure',
        config: { webhook_host: 'open.feishu.cn' },
        secret: 'http://open.feishu.cn/open-apis/bot/v2/hook/token',
      },
    })
    assert.equal(insecure.status, 201, JSON.stringify(insecure.body))
    const tested = await api.handle({
      method: 'POST', path: '/api/agentops/capabilities/integrations/int_feishu_http/test',
    })
    assert.equal((tested.body as { ok: boolean }).ok, false)
    assert.match((tested.body as { message: string }).message, /https/)
  } finally {
    store.close()
  }
})
