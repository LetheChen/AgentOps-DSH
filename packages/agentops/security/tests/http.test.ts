import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { SecurityStore } from '../src/store.ts'
import { registerSecurityRoutes } from '../src/http.ts'

const NOW = '2026-11-02T00:00:00.000Z'
const ROUTE_PATHS = [
  '/api/agentops/security/users',
  '/api/agentops/security/roles',
  '/api/agentops/security/sessions',
  '/api/agentops/security/tokens',
  '/api/agentops/security/usage',
  '/api/agentops/security/audit',
  '/api/agentops/monitor',
] as const

interface CapturedRoute {
  readonly path: string
  readonly methods: readonly string[]
  readonly fetch: (request: Request) => Promise<Response>
}

interface Harness {
  readonly ctx: never
  readonly routes: Map<string, CapturedRoute>
  readonly labels: readonly string[]
  readonly disposeAll: () => Promise<void>
}

function harness(): Harness {
  const routes = new Map<string, CapturedRoute>()
  const labels: string[] = []
  const disposers: (() => void | Promise<void>)[] = []
  const ctx = {
    effect: (factory: () => unknown, label: string): void => {
      labels.push(label)
      const disposer = factory()
      if (typeof disposer === 'function') disposers.push(disposer as () => void | Promise<void>)
    },
    connection: {
      fetch: {
        register: (route: CapturedRoute): (() => Promise<void>) => {
          routes.set(route.path, route)
          return async () => { routes.delete(route.path) }
        },
      },
    },
  }
  return {
    ctx: ctx as never,
    routes,
    labels,
    disposeAll: async () => {
      for (const dispose of disposers.reverse()) await dispose()
    },
  }
}

async function withStore(run: (store: SecurityStore) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'agentops-security-http-'))
  const store = new SecurityStore(join(dir, 'security.db'))
  try {
    await run(store)
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

function route(h: Harness, path: string): CapturedRoute {
  const found = h.routes.get(path)
  assert.ok(found, `missing route ${path}`)
  return found
}

function get(path: string): Request {
  return new Request(`https://example.test${path}`)
}

void test('security routes：七条接口全部只读，并可随 effect 注销', async () => {
  await withStore(async (store) => {
    const h = harness()
    registerSecurityRoutes(h.ctx, store)

    assert.deepEqual([...h.routes.keys()].sort(), [...ROUTE_PATHS].sort())
    for (const path of ROUTE_PATHS) {
      assert.deepEqual(route(h, path).methods, ['GET'])
      const response = await route(h, path).fetch(get(path))
      assert.equal(response.status, 200)
      assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8')
    }
    assert.equal(h.labels.length, ROUTE_PATHS.length)

    await h.disposeAll()
    assert.equal(h.routes.size, 0)
  })
})

void test('security routes：用户返回真实角色，Token 只返回描述字段', async () => {
  await withStore(async (store) => {
    store.createUser({ id: 'u1', name: 'Ada', email: 'ada@example.com', actor: 'admin', now: NOW })
    store.createRole({ id: 'viewer', name: 'Viewer', permissions: ['task.read'], actor: 'admin', now: NOW })
    store.createRole({ id: 'operator', name: 'Operator', permissions: ['task.advance'], actor: 'admin', now: NOW })
    store.assignRole({ userId: 'u1', roleId: 'viewer', grantedBy: 'admin', now: NOW })
    store.assignRole({ userId: 'u1', roleId: 'operator', grantedBy: 'admin', now: NOW })
    store.startSession({ id: 's1', userId: 'u1', agent: 'manager', now: NOW })
    const secret = 'aops_secret_value'
    store.createToken({ id: 't1', userId: 'u1', name: 'CI', secret, actor: 'admin', now: NOW })

    const h = harness()
    registerSecurityRoutes(h.ctx, store)

    const usersResponse = await route(h, '/api/agentops/security/users').fetch(
      get('/api/agentops/security/users'),
    )
    const usersBody = await usersResponse.json() as {
      users: { id: string; roleIds: string[] }[]
    }
    assert.equal(usersBody.users.length, 1)
    assert.equal(usersBody.users[0]?.id, 'u1')
    assert.deepEqual(usersBody.users[0]?.roleIds.slice().sort(), ['operator', 'viewer'])

    const tokensResponse = await route(h, '/api/agentops/security/tokens').fetch(
      get('/api/agentops/security/tokens'),
    )
    const tokensBody = await tokensResponse.json() as {
      tokens: Record<string, unknown>[]
    }
    assert.deepEqual(tokensBody.tokens, [{
      id: 't1',
      userId: 'u1',
      name: 'CI',
      prefix: 'aops_sec',
      createdAt: NOW,
      revokedAt: null,
    }])
    const serialized = JSON.stringify(tokensBody)
    assert.equal(serialized.includes(secret), false)
    assert.equal(serialized.includes('hash'), false)
  })
})
