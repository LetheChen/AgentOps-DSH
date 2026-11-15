// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'

import { zh } from '../src/client/page-locales.js'
import { VaultPanel } from '../src/client/vault-panel.js'

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

const databaseConnection = {
  id: 'audit_reader',
  kind: 'database',
  name: 'Audit reader',
  driver: 'mysql',
  host: '192.0.2.10',
  port: 3306,
  username: 'audit',
  defaultDatabase: 'audit_example',
  enabled: true,
  hasSecret: true,
  secretUpdatedAt: '2026-11-01T00:00:00.000Z',
  lastTestAt: null,
  lastTestOk: null,
  lastTestError: null,
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-01T00:00:00.000Z',
} as const

const serverConnection = {
  id: 'MaxKB',
  kind: 'server',
  name: 'MaxKB',
  driver: 'ssh',
  host: '192.0.2.10',
  port: 2222,
  username: 'root',
  defaultDatabase: null,
  enabled: true,
  hasSecret: true,
  secretUpdatedAt: '2026-11-01T00:00:00.000Z',
  lastTestAt: null,
  lastTestOk: null,
  lastTestError: null,
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-01T00:00:00.000Z',
} as const

function connectionsApi(rows: readonly unknown[]): ApiHandler {
  return (url) => {
    if (url.includes('/audit')) return jsonResponse({ events: [] })
    if (url.includes('/connections')) return jsonResponse({ connections: rows })
    return jsonResponse({}, 404)
  }
}

describe('credential page', () => {
  it('counts both connection families so a server connection is not hidden behind the default tab', async () => {
    const { fetchImpl } = installApi(connectionsApi([databaseConnection, serverConnection]))
    render(<VaultPanel t={t} fetchImpl={fetchImpl} />)

    await screen.findByText('Audit reader')
    expect(screen.getByRole('tab', { name: /数据库/ }).textContent).toContain('1')
    expect(screen.getByRole('tab', { name: /服务器/ }).textContent).toContain('1')

    fireEvent.click(screen.getByRole('tab', { name: /服务器/ }))
    expect((await screen.findAllByText('MaxKB')).length).toBeGreaterThan(0)
  })

  it('reports whether a secret is stored without echoing it', async () => {
    const { fetchImpl } = installApi(connectionsApi([databaseConnection]))
    render(<VaultPanel t={t} fetchImpl={fetchImpl} />)

    await screen.findByText('Audit reader')
    expect(screen.getByText(t('vault.secret.set'))).toBeTruthy()
    expect(screen.queryByText(t('vault.secret.missing'))).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: t('vault.action.edit') }))
    const dialog = await screen.findByRole('dialog')
    const password = within(dialog).getByLabelText(/^密码/)
    expect((password as HTMLInputElement).value).toBe('')
  })

  it('keeps the stored password when the dialog leaves the field blank', async () => {
    const { calls, fetchImpl } = installApi((url) => {
      if (url.includes('/audit')) return jsonResponse({ events: [] })
      if (url.endsWith('/connections/save')) return jsonResponse({ ok: true, connection: databaseConnection })
      if (url.includes('/connections')) return jsonResponse({ connections: [databaseConnection] })
      return jsonResponse({}, 404)
    })
    render(<VaultPanel t={t} fetchImpl={fetchImpl} />)

    await screen.findByText('Audit reader')
    fireEvent.click(screen.getByRole('button', { name: t('vault.action.edit') }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: t('vault.save') }))

    await screen.findByText(t('vault.notice.saved', { id: 'audit_reader' }))
    const save = calls.find(call => call.url.endsWith('/connections/save'))
    expect(save).toBeDefined()
    const body = JSON.parse(String(save?.init?.body)) as Record<string, unknown>
    expect(Object.prototype.hasOwnProperty.call(body, 'password')).toBe(false)
  })

  it('sends a new password once and never returns it', async () => {
    const { calls, fetchImpl } = installApi((url) => {
      if (url.includes('/audit')) return jsonResponse({ events: [] })
      if (url.endsWith('/connections/save')) return jsonResponse({ ok: true, connection: databaseConnection })
      if (url.includes('/connections')) return jsonResponse({ connections: [] })
      return jsonResponse({}, 404)
    })
    render(<VaultPanel t={t} fetchImpl={fetchImpl} />)

    await screen.findByText(t('vault.empty', { label: t('vault.tab.database') }))
    fireEvent.click(screen.getByRole('button', { name: t('vault.new') }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.change(within(dialog).getByLabelText('连接 ID（创建后不可改）'), { target: { value: 'new_conn' } })
    fireEvent.change(within(dialog).getByLabelText('地址'), { target: { value: '10.0.0.1' } })
    fireEvent.change(within(dialog).getByLabelText(/^密码/), { target: { value: 'hunter2' } })
    fireEvent.click(within(dialog).getByRole('button', { name: t('vault.save') }))

    await screen.findByText(t('vault.notice.created', { id: 'new_conn' }))
    const save = calls.find(call => call.url.endsWith('/connections/save'))
    const body = JSON.parse(String(save?.init?.body)) as Record<string, unknown>
    expect(body.password).toBe('hunter2')
    expect(screen.queryByDisplayValue('hunter2')).toBeNull()
  })

  it('refuses an invalid id before contacting the host', async () => {
    const { calls, fetchImpl } = installApi(connectionsApi([databaseConnection]))
    render(<VaultPanel t={t} fetchImpl={fetchImpl} />)

    await screen.findByText('Audit reader')
    fireEvent.click(screen.getByRole('button', { name: t('vault.new') }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.change(within(dialog).getByLabelText('连接 ID（创建后不可改）'), { target: { value: 'a' } })
    fireEvent.change(within(dialog).getByLabelText('地址'), { target: { value: '10.0.0.1' } })
    fireEvent.click(within(dialog).getByRole('button', { name: t('vault.save') }))

    expect(await within(dialog).findByText(t('vault.error.id'))).toBeTruthy()
    expect(calls.some(call => call.url.endsWith('/connections/save'))).toBe(false)
  })

  it('deletes through a confirmation dialog instead of a browser prompt', async () => {
    const { calls, fetchImpl } = installApi((url) => {
      if (url.includes('/audit')) return jsonResponse({ events: [] })
      if (url.endsWith('/connections/remove')) return jsonResponse({ ok: true })
      if (url.includes('/connections')) return jsonResponse({ connections: [databaseConnection] })
      return jsonResponse({}, 404)
    })
    render(<VaultPanel t={t} fetchImpl={fetchImpl} />)

    await screen.findByText('Audit reader')
    fireEvent.click(screen.getByRole('button', { name: t('vault.action.delete') }))
    const dialog = await screen.findByRole('dialog')
    expect(dialog.getAttribute('aria-label')).toBe(t('vault.confirm.title'))
    expect(calls.some(call => call.url.endsWith('/connections/remove'))).toBe(false)

    fireEvent.click(within(dialog).getByRole('button', { name: t('vault.confirm.action') }))
    await screen.findByText(t('vault.notice.deleted', { id: 'audit_reader' }))
    const remove = calls.find(call => call.url.endsWith('/connections/remove'))
    expect(JSON.parse(String(remove?.init?.body))).toEqual({ id: 'audit_reader' })
  })

  it('keeps the last rows visible when a refresh fails', async () => {
    let attempts = 0
    const { fetchImpl } = installApi((url) => {
      if (url.includes('/audit')) return jsonResponse({ events: [] })
      attempts += 1
      return attempts === 1
        ? jsonResponse({ connections: [databaseConnection] })
        : jsonResponse({}, 503)
    })
    render(<VaultPanel t={t} fetchImpl={fetchImpl} />)

    await screen.findByText('Audit reader')
    fireEvent.click(screen.getByRole('button', { name: t('page.refresh') }))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain(t('page.error.http', { status: '503' }))
    expect(screen.getByText('Audit reader')).toBeTruthy()
  })

  it('shows a first-load failure and retries through the same endpoint', async () => {
    let attempts = 0
    const { calls, fetchImpl } = installApi((url) => {
      if (url.includes('/audit')) return jsonResponse({ events: [] })
      attempts += 1
      return attempts === 1 ? jsonResponse({}, 503) : jsonResponse({ connections: [databaseConnection] })
    })
    render(<VaultPanel t={t} fetchImpl={fetchImpl} />)

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain(t('page.error.http', { status: '503' }))
    fireEvent.click(screen.getByRole('button', { name: t('page.retry') }))
    await screen.findByText('Audit reader')
    expect(calls.filter(call => call.url.endsWith('/connections')).length).toBe(2)
  })

  it('sends every credential request with the session cookie', async () => {
    const { calls, fetchImpl } = installApi(connectionsApi([databaseConnection]))
    render(<VaultPanel t={t} fetchImpl={fetchImpl} />)

    await screen.findByText('Audit reader')
    expect(calls.length).toBeGreaterThan(0)
    expect(calls.every(call => call.init?.credentials === 'include')).toBe(true)
  })
})
