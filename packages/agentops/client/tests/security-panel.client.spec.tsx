// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'

import { zh } from '../src/client/security-locales.js'
import {
  SecurityRolesPanel,
  SecuritySessionsPanel,
  SecurityTokensPanel,
  SecurityUsersPanel,
} from '../src/client/security-panel.js'

afterEach(cleanup)

const t = makeTranslate(zh)

interface ApiCall {
  readonly url: string
  readonly init: RequestInit | undefined
}

type ApiHandler = (url: string, init: RequestInit | undefined) => Response | Promise<Response>

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.href
  return input.url
}

function installApi(handler: ApiHandler): { readonly calls: ApiCall[]; readonly fetchImpl: typeof fetch } {
  const calls: ApiCall[] = []
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = urlOf(input)
    calls.push({ url, init })
    return handler(url, init)
  }
  return { calls, fetchImpl }
}

const user = {
  id: 'u1',
  name: 'Ada',
  email: 'ada@example.com',
  status: 'active',
  createdAt: '2026-11-01T00:00:00.000Z',
  roleIds: ['admin', 'operator'],
} as const

const role = {
  id: 'admin',
  name: 'Administrator',
  description: 'Full access',
  permissions: ['user.read', 'token.issue'],
} as const

const session = {
  id: 's1',
  userId: 'u1',
  agent: 'manager',
  startedAt: '2026-11-01T00:00:00.000Z',
  endedAt: null,
  status: 'active',
} as const

const token = {
  id: 't1',
  userId: 'u1',
  name: 'CI',
  prefix: 'ao_12345',
  createdAt: '2026-11-01T00:00:00.000Z',
  revokedAt: null,
} as const

describe('security panels', () => {
  it('loads only the endpoint owned by each page', async () => {
    const { calls, fetchImpl } = installApi((url) => {
      if (url.endsWith('/users')) return jsonResponse({ users: [user] })
      if (url.endsWith('/roles')) return jsonResponse({ roles: [role] })
      if (url.endsWith('/sessions')) return jsonResponse({ sessions: [session] })
      return jsonResponse({ tokens: [token] })
    })

    render(
      <>
        <SecurityUsersPanel t={t} fetchImpl={fetchImpl} />
        <SecurityRolesPanel t={t} fetchImpl={fetchImpl} />
        <SecuritySessionsPanel t={t} fetchImpl={fetchImpl} />
        <SecurityTokensPanel t={t} fetchImpl={fetchImpl} />
      </>,
    )

    await screen.findByText('Ada')
    await screen.findByText('Administrator')
    await screen.findByText('manager')
    await screen.findByText('CI')

    expect(calls.map(call => call.url).sort()).toEqual([
      '/api/agentops/security/roles',
      '/api/agentops/security/sessions',
      '/api/agentops/security/tokens',
      '/api/agentops/security/users',
    ])
    expect(calls.every(call => call.init?.credentials === 'include')).toBe(true)
  })

  it('renders every assigned role id and the user status', async () => {
    const { fetchImpl } = installApi(() => jsonResponse({ users: [user] }))
    render(<SecurityUsersPanel t={t} fetchImpl={fetchImpl} />)

    await screen.findByText('Ada')
    expect(screen.getByText('admin')).toBeTruthy()
    expect(screen.getByText('operator')).toBeTruthy()
    expect(screen.getByText(t('userStatus.active'))).toBeTruthy()
    expect(screen.getByText(t('page.count', { count: '1' }))).toBeTruthy()
  })

  it('shows a skeleton while the first request is pending', async () => {
    let resolve!: (response: Response) => void
    const pending = new Promise<Response>((done) => { resolve = done })
    const fetchImpl: typeof fetch = async () => pending

    render(<SecurityUsersPanel t={t} fetchImpl={fetchImpl} />)
    expect(screen.getByRole('status').textContent).toContain(t('page.loading'))

    await act(async () => { resolve(jsonResponse({ users: [user] })) })
    await screen.findByText('Ada')
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('renders the localized empty state', async () => {
    const { fetchImpl } = installApi(() => jsonResponse({ roles: [] }))
    render(<SecurityRolesPanel t={t} fetchImpl={fetchImpl} />)

    expect(await screen.findByText(t('empty.roles'))).toBeTruthy()
    expect(screen.queryByRole('table')).toBeNull()
  })

  it('shows a first-load failure and retries through the same endpoint', async () => {
    let attempts = 0
    const { calls, fetchImpl } = installApi(() => {
      attempts += 1
      return attempts === 1
        ? jsonResponse({ error: 'unavailable' }, 503)
        : jsonResponse({ users: [user] })
    })
    render(<SecurityUsersPanel t={t} fetchImpl={fetchImpl} />)

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain(t('page.loadFailed', {
      message: t('error.http', { status: '503' }),
    }))
    expect(screen.queryByText('Ada')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: t('page.retry') }))
    await screen.findByText('Ada')
    expect(calls.map(call => call.url)).toEqual([
      '/api/agentops/security/users',
      '/api/agentops/security/users',
    ])
  })

  it('keeps the last successful rows visible when refresh fails', async () => {
    let attempts = 0
    const { fetchImpl } = installApi(() => {
      attempts += 1
      return attempts === 1
        ? jsonResponse({ users: [user] })
        : jsonResponse({ error: 'unavailable' }, 503)
    })
    render(<SecurityUsersPanel t={t} fetchImpl={fetchImpl} />)

    await screen.findByText('Ada')
    fireEvent.click(screen.getByRole('button', { name: t('page.refresh') }))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain(t('page.refreshFailed', {
      message: t('error.http', { status: '503' }),
    }))
    expect(screen.getByText('Ada')).toBeTruthy()
    expect(screen.getByText(t('page.count', { count: '1' }))).toBeTruthy()
  })

  it('offers no token mutation controls and explains the audited issuance path', async () => {
    const { fetchImpl } = installApi(() => jsonResponse({ tokens: [] }))
    render(<SecurityTokensPanel t={t} fetchImpl={fetchImpl} />)

    await screen.findByText(t('empty.tokens'))
    expect(screen.getAllByRole('button').map(button => button.textContent)).toEqual([t('page.refresh')])
    expect(screen.getByText(t('token.issueNote'))).toBeTruthy()
    expect(screen.queryByRole('button', { name: /(add|create|issue|delete|edit|revoke)/i })).toBeNull()
  })

  it('rejects a response whose status is outside the server contract', async () => {
    const { fetchImpl } = installApi(() => jsonResponse({
      users: [{ ...user, status: 'locked' }],
    }))
    render(<SecurityUsersPanel t={t} fetchImpl={fetchImpl} />)

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain(t('error.invalidResponse'))
  })
})
