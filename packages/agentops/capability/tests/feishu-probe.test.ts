import assert from 'node:assert/strict'
import test from 'node:test'

import { probeCapabilityInstance } from '../src/probe.ts'
import type { CapabilityRuntime } from '../src/types.ts'

function runtime(overrides: Partial<CapabilityRuntime> = {}): CapabilityRuntime {
  return {
    agentPreset: '',
    capabilityId: 'feishu-docs',
    instanceId: 'int_feishu_docs',
    name: 'Feishu docs',
    config: { app_id: 'cli_test', base_url: 'https://open.feishu.cn' },
    accessPolicy: {},
    secret: 'app-secret',
    credentialGeneration: 'gen-1',
    ...overrides,
  }
}

void test('Feishu docs probe mints a tenant token and reads one drive page', async () => {
  const requests: Array<{ url: string; init: RequestInit | undefined }> = []
  const original = globalThis.fetch
  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input)
    requests.push({ url, init })
    if (url.endsWith('/open-apis/auth/v3/tenant_access_token/internal')) {
      return Response.json({ code: 0, msg: 'ok', tenant_access_token: 't-test-token', expire: 7200 })
    }
    if (url.endsWith('/open-apis/drive/v1/files?page_size=1')) {
      return Response.json({ code: 0, msg: 'ok', data: { files: [{ token: 'doc-token' }] } })
    }
    throw new Error(`unexpected URL ${url}`)
  }
  try {
    const result = await probeCapabilityInstance(runtime(), 1000)
    assert.equal(result.ok, true)
    assert.match(result.detail, /tenant_access_token 获取成功/)
    assert.equal(result.detail.includes('app-secret'), false)
    assert.equal(result.detail.includes('t-test-token'), false)
  } finally {
    globalThis.fetch = original
  }

  assert.equal(requests.length, 2)
  assert.equal(requests[0]?.url, 'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal')
  assert.equal(requests[0]?.init?.method, 'POST')
  assert.deepEqual(JSON.parse(typeof requests[0]?.init?.body === 'string' ? requests[0].init.body : '{}'), {
    app_id: 'cli_test',
    app_secret: 'app-secret',
  })
  const headers = new Headers(requests[1]?.init?.headers)
  assert.equal(headers.get('authorization'), 'Bearer t-test-token')
})

void test('Feishu docs probe reports token rejection without returning the secret', async () => {
  const original = globalThis.fetch
  globalThis.fetch = async () => Response.json({ code: 10014, msg: 'app secret invalid' })
  try {
    const result = await probeCapabilityInstance(runtime(), 1000)
    assert.equal(result.ok, false)
    assert.match(result.detail, /code=10014/)
    assert.equal(result.detail.includes('app-secret'), false)
  } finally {
    globalThis.fetch = original
  }
})

void test('Feishu docs probe rejects an insecure API origin before sending credentials', async () => {
  let calls = 0
  const original = globalThis.fetch
  globalThis.fetch = async () => {
    calls += 1
    return Response.json({ code: 0 })
  }
  try {
    const result = await probeCapabilityInstance(runtime({
      config: { app_id: 'cli_test', base_url: 'http://open.feishu.cn' },
    }), 1000)
    assert.equal(result.ok, false)
    assert.match(result.detail, /https:\/\//)
  } finally {
    globalThis.fetch = original
  }
  assert.equal(calls, 0)
})
