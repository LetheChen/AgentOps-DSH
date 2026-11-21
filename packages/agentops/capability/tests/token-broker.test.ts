import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import test from 'node:test'

import { RestTransport } from '../src/rest.ts'
import { TokenBroker } from '../src/token-broker.ts'
import { CapabilityError } from '../src/errors.ts'
import type { CapabilityRuntime } from '../src/types.ts'

interface FakeServer {
  readonly server: Server
  readonly baseUrl: string
  readonly tokenRequests: () => number
  readonly businessRequests: () => number
  readonly seenTokens: () => readonly string[]
  readonly tokenUrls: () => readonly string[]
  readonly tokenBodies: () => readonly string[]
  readonly rejectNext: (count?: number) => void
  readonly invalidateToken: () => void
  close: () => Promise<void>
}

async function startFakeServer(): Promise<FakeServer> {
  let tokenRequests = 0
  let businessRequests = 0
  const seenTokens: string[] = []
  const tokenUrls: string[] = []
  const tokenBodies: string[] = []
  let rejectCount = 0
  let invalidToken = false
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', (chunk: Buffer) => { body += chunk.toString('utf8') })
    request.on('end', () => {
      if (request.url?.startsWith('/seeyon/rest/token') === true) {
        tokenRequests += 1
        tokenUrls.push(request.url)
        tokenBodies.push(body)
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ bindingUser: 'zhangsan', id: invalidToken ? '-1' : `token-${tokenRequests}` }))
        return
      }
      businessRequests += 1
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      const headerToken = request.headers['token']
      const token = typeof headerToken === 'string' ? headerToken : url.searchParams.get('token')
      if (token !== null) seenTokens.push(token)
      if (rejectCount > 0) {
        rejectCount -= 1
        response.writeHead(401, { 'content-type': 'application/json' })
        response.end('{"error":"Invalid token, please authenticate again"}')
        return
      }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end('[{"id":"affair-1","subject":"差旅报销","createDate":1402906375000,"app":1,"objectId":"OBJ-1","state":3,"subState":11}]')
    })
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('the fake server has no port')
  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
    tokenRequests: () => tokenRequests,
    businessRequests: () => businessRequests,
    seenTokens: () => seenTokens,
    tokenUrls: () => tokenUrls,
    tokenBodies: () => tokenBodies,
    rejectNext: (count = 1) => { rejectCount = count },
    invalidateToken: () => { invalidToken = true },
    close: () => new Promise<void>((resolve) => { server.close(() => { resolve() }) }),
  }
}

function runtime(baseUrl: string, overrides: Partial<CapabilityRuntime> = {}): CapabilityRuntime {
  return {
    agentPreset: 'oa_assistant',
    capabilityId: 'oa',
    instanceId: 'oa-production',
    name: 'OA',
    config: {
      base_url: baseUrl,
      username: 'rest',
      login_name: 'zhangsan',
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
    ...overrides,
  }
}

function runtimeWithAuth(baseUrl: string, authOverrides: Record<string, unknown>): CapabilityRuntime {
  const subject = runtime(baseUrl)
  return {
    ...subject,
    config: {
      ...subject.config,
      auth: { ...(subject.config['auth'] as Record<string, unknown>), ...authOverrides },
    },
  }
}

void test('the broker mints a token from the declared endpoint and caches it', async () => {
  const fake = await startFakeServer()
  try {
    const broker = new TokenBroker()
    const subject = runtime(fake.baseUrl)
    const first = await broker.token(subject)
    assert.equal(first.token, 'token-1')
    assert.equal(first.identity, 'zhangsan')
    assert.equal(first.source, 'token-endpoint')
    assert.ok(first.expiresAt > first.obtainedAt)

    const second = await broker.token(subject)
    assert.equal(second.token, 'token-1')
    assert.equal(fake.tokenRequests(), 1)
  } finally {
    await fake.close()
  }
})

void test('concurrent requests share one token mint', async () => {
  const fake = await startFakeServer()
  try {
    const broker = new TokenBroker()
    const subject = runtime(fake.baseUrl)
    const [first, second] = await Promise.all([broker.token(subject), broker.token(subject)])
    assert.equal(first.token, second.token)
    assert.equal(fake.tokenRequests(), 1)
  } finally {
    await fake.close()
  }
})

void test('the broker separates cached tokens by request subject', async () => {
  const fake = await startFakeServer()
  try {
    const broker = new TokenBroker()
    const subject = runtime(fake.baseUrl)
    await broker.token(subject, { subject: { loginName: 'zhangsan' } })
    await broker.token(subject, { subject: { loginName: 'lisi' } })
    assert.equal(fake.tokenRequests(), 2)
    await broker.token(subject, { subject: { loginName: 'zhangsan' } })
    assert.equal(fake.tokenRequests(), 2)
  } finally {
    await fake.close()
  }
})

void test('rotating the credential invalidates the cached token', async () => {
  const fake = await startFakeServer()
  try {
    const broker = new TokenBroker()
    await broker.token(runtime(fake.baseUrl))
    await broker.token(runtime(fake.baseUrl, { credentialGeneration: 'gen-2' }))
    assert.equal(fake.tokenRequests(), 2)
  } finally {
    await fake.close()
  }
})

void test('a rejected token is re-minted once and the call is retried once', async () => {
  const fake = await startFakeServer()
  try {
    const broker = new TokenBroker()
    const transport = new RestTransport(broker)
    const subject = runtime(fake.baseUrl)
    await broker.token(subject)
    fake.rejectNext()
    const response = await transport.request(subject, { method: 'GET', path: '/seeyon/rest/affairs/pending/code/0001' })
    assert.equal(response.status, 200)
    assert.equal(fake.tokenRequests(), 2)
    assert.equal(fake.businessRequests(), 2)
  } finally {
    await fake.close()
  }
})

void test('a token the vendor keeps rejecting fails with a stable code', async () => {
  const fake = await startFakeServer()
  try {
    const broker = new TokenBroker()
    const transport = new RestTransport(broker)
    const subject = runtime(fake.baseUrl)
    fake.rejectNext(2)
    await assert.rejects(
      () => transport.request(subject, { method: 'GET', path: '/seeyon/rest/affairs/pending/code/0001' }),
      (error: unknown) => error instanceof CapabilityError && error.code === 'TOKEN_INVALID',
    )
  } finally {
    await fake.close()
  }
})

void test('the token travels in the declared header', async () => {
  const fake = await startFakeServer()
  try {
    const broker = new TokenBroker()
    const transport = new RestTransport(broker)
    await transport.request(runtime(fake.baseUrl), { method: 'GET', path: '/seeyon/rest/affairs/pending/code/0001' })
    assert.deepEqual(fake.seenTokens(), ['token-1'])
  } finally {
    await fake.close()
  }
})

void test('the token may travel in the query when the profile declares it', async () => {
  const fake = await startFakeServer()
  try {
    const broker = new TokenBroker()
    const transport = new RestTransport(broker)
    const subject = runtimeWithAuth(fake.baseUrl, { transport: 'query' })
    await transport.request(subject, { method: 'GET', path: '/seeyon/rest/affairs/pending/code/0001' })
    assert.deepEqual(fake.seenTokens(), ['token-1'])
  } finally {
    await fake.close()
  }
})

void test('token parameters can mix a JSON body with a query binding field', async () => {
  const fake = await startFakeServer()
  try {
    const broker = new TokenBroker()
    const subject = runtimeWithAuth(fake.baseUrl, {
      token_params: {
        userName: 'config.username',
        password: 'secret',
        loginName: { source: 'subject.loginName', in: 'query' },
      },
    })
    await broker.token(subject, { subject: { loginName: 'lisi' } })
    assert.match(fake.tokenUrls()[0] ?? '', /loginName=lisi/)
    assert.deepEqual(JSON.parse(fake.tokenBodies()[0] ?? '{}'), { userName: 'rest', password: 'pa55' })
  } finally {
    await fake.close()
  }
})

void test('a declared invalid token is rejected before business calls', async () => {
  const fake = await startFakeServer()
  try {
    const broker = new TokenBroker()
    fake.invalidateToken()
    await assert.rejects(
      () => broker.token(runtime(fake.baseUrl)),
      (error: unknown) => error instanceof CapabilityError && error.code === 'TOKEN_ACQUISITION_FAILED',
    )
  } finally {
    await fake.close()
  }
})

void test('an instance without a base_url fails before any request', async () => {
  const broker = new TokenBroker()
  const transport = new RestTransport(broker)
  await assert.rejects(
    () => transport.request(runtime('http://127.0.0.1:1', { config: {} }), { method: 'GET', path: '/x' }),
    (error: unknown) => error instanceof CapabilityError && error.code === 'CAPABILITY_CONFIG_INVALID',
  )
})

void test('an instance without auth fails instead of treating its secret as a token', async () => {
  const broker = new TokenBroker()
  await assert.rejects(
    () => broker.token(runtime('http://127.0.0.1:1', { config: { base_url: 'http://127.0.0.1:1' } })),
    (error: unknown) => error instanceof CapabilityError && error.code === 'CAPABILITY_AUTH_INVALID',
  )
})
