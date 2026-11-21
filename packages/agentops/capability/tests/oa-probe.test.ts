import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import test from 'node:test'

import { probeCapabilityInstance } from '../src/probe.ts'
import type { CapabilityRuntime } from '../src/types.ts'

interface FakeOa {
  readonly server: Server
  readonly baseUrl: string
  close: () => Promise<void>
}

async function startFakeOa(): Promise<FakeOa> {
  const server = createServer((request, response) => {
    if (request.url?.startsWith('/seeyon/rest/token') === true) {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end('{"id":"token-1","bindingUser":"zhangsan"}')
      return
    }
    if (request.url?.startsWith('/seeyon/rest/affairs/pending/code/0001') === true) {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end('[{"id":"affair-1","subject":"差旅报销","createDate":1402906375000,"app":1}]')
      return
    }
    response.writeHead(404, { 'content-type': 'application/json' })
    response.end('{}')
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('the fake OA has no port')
  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve) => { server.close(() => { resolve() }) }),
  }
}

function runtime(baseUrl: string): CapabilityRuntime {
  return {
    agentPreset: 'oa_assistant',
    capabilityId: 'oa',
    instanceId: 'oa-production',
    name: 'OA',
    config: {
      base_url: baseUrl,
      username: 'rest',
      login_name: 'zhangsan',
      member_code: '0001',
      auth: {
        type: 'token-endpoint',
        token_url: '/seeyon/rest/token',
        token_method: 'POST',
        token_params_in: 'json',
        token_params: { userName: 'config.username', password: 'secret', loginName: 'config.login_name' },
        token_path: 'id',
        identity_path: 'bindingUser',
        default_ttl_seconds: 900,
        token_invalid_values: ['-1'],
        transport: 'header',
        token_name: 'token',
      },
    },
    accessPolicy: {},
    secret: 'pa55',
    credentialGeneration: 'gen-1',
  }
}

void test('the OA probe obtains a token and reads one pending row', async () => {
  const fake = await startFakeOa()
  try {
    const result = await probeCapabilityInstance(runtime(fake.baseUrl))
    assert.equal(result.ok, true)
    assert.match(result.detail, /token 获取成功/)
    assert.match(result.detail, /1 条/)
  } finally {
    await fake.close()
  }
})
