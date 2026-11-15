import { describe, expect, it } from 'vitest'

import {
  SecurityRequestError,
  SecurityResponseError,
  loadSecurityRoles,
  loadSecuritySessions,
  loadSecurityTokens,
  loadSecurityUsers,
} from '../src/client/security-api.js'

interface ApiCall {
  readonly url: string
  readonly init: RequestInit | undefined
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function rawResponse(text: string, status = 200): Response {
  return new Response(text, {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.href
  return input.url
}

const user = {
  id: 'u1',
  name: 'Ada',
  email: null,
  status: 'active',
  createdAt: '2026-11-01T00:00:00.000Z',
  roleIds: ['admin', 'operator'],
  metadata: { ignored: true },
} as const

const role = {
  id: 'admin',
  name: 'Administrator',
  description: 'Full access',
  permissions: ['user.read', 'token.issue'],
  version: 2,
} as const

const session = {
  id: 's1',
  userId: 'u1',
  agent: 'manager',
  startedAt: '2026-11-01T00:00:00.000Z',
  endedAt: null,
  status: 'active',
  metadata: { ignored: true },
} as const

const token = {
  id: 't1',
  userId: 'u1',
  name: 'CI',
  prefix: 'ao_12345',
  createdAt: '2026-11-01T00:00:00.000Z',
  revokedAt: null,
  secret: 'plaintext-must-not-survive',
  hash: 'hash-must-not-survive',
} as const

describe('security API', () => {
  it('requests each exact route with included credentials', async () => {
    const calls: ApiCall[] = []
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = urlOf(input)
      calls.push({ url, init })
      if (url.endsWith('/users')) return jsonResponse({ users: [user] })
      if (url.endsWith('/roles')) return jsonResponse({ roles: [role] })
      if (url.endsWith('/sessions')) return jsonResponse({ sessions: [session] })
      return jsonResponse({ tokens: [token] })
    }

    await loadSecurityUsers(fetchImpl)
    await loadSecurityRoles(fetchImpl)
    await loadSecuritySessions(fetchImpl)
    await loadSecurityTokens(fetchImpl)

    expect(calls.map(call => call.url)).toEqual([
      '/api/agentops/security/users',
      '/api/agentops/security/roles',
      '/api/agentops/security/sessions',
      '/api/agentops/security/tokens',
    ])
    expect(calls.map(call => call.init?.credentials)).toEqual(['include', 'include', 'include', 'include'])
  })

  it('parses complete rows, preserves role ids, and drops additive fields', async () => {
    const rows = new Map<string, unknown>([
      ['/api/agentops/security/users', { users: [user] }],
      ['/api/agentops/security/roles', { roles: [role] }],
      ['/api/agentops/security/sessions', { sessions: [session] }],
      ['/api/agentops/security/tokens', { tokens: [token] }],
    ])
    const fetchImpl: typeof fetch = async input => jsonResponse(rows.get(urlOf(input)))

    await expect(loadSecurityUsers(fetchImpl)).resolves.toEqual([{
      id: 'u1',
      name: 'Ada',
      email: null,
      status: 'active',
      createdAt: '2026-11-01T00:00:00.000Z',
      roleIds: ['admin', 'operator'],
    }])
    await expect(loadSecurityRoles(fetchImpl)).resolves.toEqual([{
      id: 'admin',
      name: 'Administrator',
      description: 'Full access',
      permissions: ['user.read', 'token.issue'],
    }])
    await expect(loadSecuritySessions(fetchImpl)).resolves.toEqual([{
      id: 's1',
      userId: 'u1',
      agent: 'manager',
      startedAt: '2026-11-01T00:00:00.000Z',
      endedAt: null,
      status: 'active',
    }])
    await expect(loadSecurityTokens(fetchImpl)).resolves.toEqual([{
      id: 't1',
      userId: 'u1',
      name: 'CI',
      prefix: 'ao_12345',
      createdAt: '2026-11-01T00:00:00.000Z',
      revokedAt: null,
    }])
  })

  it('never returns plaintext token material or hashes', async () => {
    const fetchImpl: typeof fetch = async () => jsonResponse({ tokens: [token] })

    const rows = await loadSecurityTokens(fetchImpl)
    const serialized = JSON.stringify(rows)

    expect(serialized).not.toContain(token.secret)
    expect(serialized).not.toContain(token.hash)
    expect(rows[0]).not.toHaveProperty('secret')
    expect(rows[0]).not.toHaveProperty('hash')
  })

  it('retains the HTTP status on request errors', async () => {
    const fetchImpl: typeof fetch = async () => rawResponse('unavailable', 503)

    try {
      await loadSecurityUsers(fetchImpl)
      throw new Error('expected request to fail')
    } catch (reason) {
      expect(reason).toBeInstanceOf(SecurityRequestError)
      if (reason instanceof SecurityRequestError) expect(reason.status).toBe(503)
    }
  })

  it('retains the JSON parser error as the cause', async () => {
    const fetchImpl: typeof fetch = async () => rawResponse('{')

    try {
      await loadSecurityRoles(fetchImpl)
      throw new Error('expected parsing to fail')
    } catch (reason) {
      expect(reason).toBeInstanceOf(SecurityResponseError)
      if (reason instanceof Error) expect(reason.cause).toBeInstanceOf(SyntaxError)
    }
  })

  it('rejects unknown statuses, malformed rows, and missing collections', async () => {
    const unknownStatus: typeof fetch = async () => jsonResponse({
      users: [{ ...user, status: 'locked' }],
    })
    await expect(loadSecurityUsers(unknownStatus)).rejects.toBeInstanceOf(SecurityResponseError)

    const malformedRole: typeof fetch = async () => jsonResponse({
      roles: [{ ...role, permissions: 'user.read' }],
    })
    await expect(loadSecurityRoles(malformedRole)).rejects.toBeInstanceOf(SecurityResponseError)

    const malformedBodies: readonly (typeof fetch)[] = [
      async () => jsonResponse({}),
      async () => jsonResponse([]),
    ]
    for (const fetchImpl of malformedBodies) {
      await expect(loadSecuritySessions(fetchImpl)).rejects.toBeInstanceOf(SecurityResponseError)
    }
  })
})
