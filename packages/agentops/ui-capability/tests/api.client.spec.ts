import { describe, expect, it } from 'vitest'

import { createCapabilityApi } from '../src/client/api.ts'

describe('capability browser api', () => {
  it('maps panel operations to the stable logical capability routes', async () => {
    const calls: { endpoint: string; method: string; payload: unknown }[] = []
    const api = createCapabilityApi(async (endpoint, method, payload) => {
      calls.push({ endpoint, method, payload })
      return { ok: true, value: {} }
    })
    await api.listCatalog()
    await api.listIntegrations()
    await api.listTools('database')
    await api.createIntegration({ name: 'x' })
    await api.updateIntegration('int a/b', { status: 'disabled' })
    await api.deleteIntegration('int a/b')
    await api.testIntegration('int a/b')
    await api.probeSshHostKey('192.0.2.10', 2222)
    await api.listBindings('manager')
    await api.replaceBindings({ agent_preset: 'manager', bindings: [] })
    await api.listAudit()
    expect(calls.map(call => [call.endpoint, call.method])).toEqual([
      ['agentops/capabilities/catalog', 'GET'],
      ['agentops/capabilities/integrations', 'GET'],
      ['agentops/capabilities/tools', 'GET'],
      ['agentops/capabilities/integrations', 'POST'],
      ['agentops/capabilities/integrations/int%20a%2Fb', 'PATCH'],
      ['agentops/capabilities/integrations/int%20a%2Fb', 'DELETE'],
      ['agentops/capabilities/integrations/int%20a%2Fb/test', 'POST'],
      ['agentops/capabilities/ssh/host-key', 'POST'],
      ['agentops/capabilities/bindings', 'GET'],
      ['agentops/capabilities/bindings', 'PUT'],
      ['agentops/capabilities/audit', 'GET'],
    ])
    expect(calls[7]?.payload).toEqual({ body: { host: '192.0.2.10', port: 2222 } })
    expect(calls[8]?.payload).toEqual({ query: { agent_preset: 'manager' } })
  })

  it('keeps RPC failures as machine-readable errors', async () => {
    const api = createCapabilityApi(async () => ({
      ok: false,
      error: { code: 'CREDENTIAL_DECRYPT_FAILED', message: 'cannot decrypt', details: {} },
    }))
    const result = await api.listIntegrations()
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('CREDENTIAL_DECRYPT_FAILED')
  })
})
