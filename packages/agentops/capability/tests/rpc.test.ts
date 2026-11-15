import assert from 'node:assert/strict'
import test from 'node:test'

import { CapabilityHttpApi } from '../src/http.ts'
import { decodeCapabilityEndpoint, handleCapabilityRpc } from '../src/mount-rpc.ts'
import { CapabilityStore } from '../src/store.ts'
import type { MasterKey } from '../../vault/src/crypto.ts'

const key: MasterKey = { key: Buffer.alloc(32, 7), source: 'env' }

void test('endpoint decoding leaves unrelated surfaces alone', () => {
  assert.equal(decodeCapabilityEndpoint('agentops/capabilities/catalog'), '/api/agentops/capabilities/catalog')
  assert.equal(decodeCapabilityEndpoint('agentops/capabilities/integrations/int_a'), '/api/agentops/capabilities/integrations/int_a')
  assert.equal(decodeCapabilityEndpoint('agentops/tasks'), undefined)
  assert.equal(decodeCapabilityEndpoint('agentops/capabilitiesx'), undefined)
})

void test('RPC dispatch preserves method, query and body and admits only owner', async () => {
  const store = new CapabilityStore(':memory:', key)
  try {
    const api = new CapabilityHttpApi(store)
    const created = await handleCapabilityRpc(api, 'agentops/capabilities/integrations', {
      method: 'POST',
      body: { instanceId: 'int_wecom', capabilityId: 'wecom', name: 'Ops', config: { webhook_host: 'qyapi.weixin.qq.com' }, secret: 'secret' },
    }, true)
    assert.equal(created.ok, true)

    const patched = await handleCapabilityRpc(api, 'agentops/capabilities/integrations/int_wecom', {
      method: 'PATCH',
      body: { name: 'Ops v2' },
    }, true)
    assert.equal(patched.ok, true)
    if (patched.ok) {
      const body = patched.value as { integration: { name: string } }
      assert.equal(body.integration.name, 'Ops v2')
    }

    const forbidden = await handleCapabilityRpc(api, 'agentops/capabilities/integrations', { method: 'GET' }, false)
    assert.deepEqual(forbidden, {
      ok: false,
      error: { code: 'forbidden', message: 'capability surface is owner-only', details: {} },
    })
  } finally {
    store.close()
  }
})

void test('RPC error envelope carries stable capability codes', async () => {
  const store = new CapabilityStore(':memory:', key)
  try {
    const api = new CapabilityHttpApi(store)
    const result = await handleCapabilityRpc(api, 'agentops/capabilities/bindings', {
      method: 'PUT',
      body: { agent_preset: 'manager', bindings: [] },
    }, true)
    assert.equal(result.ok, true)
    if (result.ok) {
      assert.deepEqual((result.value as { bindings: unknown[] }).bindings, [])
    }
    const invalid = await handleCapabilityRpc(api, 'agentops/capabilities/integrations', {
      method: 'POST',
      body: { name: 'missing capability' },
    }, true)
    assert.equal(invalid.ok, false)
    if (!invalid.ok) assert.equal(invalid.error.code, 'CAPABILITY_CONFIG_INVALID')
  } finally {
    store.close()
  }
})
