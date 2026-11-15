// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'

import { zh } from '../src/client/page-locales.js'
import { A2uiPanel } from '../src/client/a2ui-panel.js'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

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

const renderableView = {
  id: 7,
  viewId: 'view-7',
  title: '日志抽取看板',
  createdAt: '2026-11-01T09:00:00.000Z',
  surface: { components: [{ component: 'Text', props: { text: '日志抽取看板' } }] },
}

const brokenView = {
  id: 8,
  viewId: 'view-8',
  title: '缺组件的看板',
  createdAt: '2026-11-01T10:00:00.000Z',
  surface: { components: [{ props: {} }] },
}

function viewsApi(views: readonly unknown[]): ApiHandler {
  return (url) => {
    if (url.includes('/surfaces/views')) return jsonResponse({ views })
    return jsonResponse({}, 404)
  }
}

describe('generative UI page', () => {
  it('lists the boards agents published', async () => {
    const { fetchImpl } = installApi(viewsApi([renderableView, brokenView]))
    render(<A2uiPanel t={t} fetchImpl={fetchImpl} />)

    expect(await screen.findByText('日志抽取看板')).toBeTruthy()
    expect(screen.getByText('view-7')).toBeTruthy()
    expect(screen.getByText(t('a2ui.status.renderable'))).toBeTruthy()
    expect(screen.getByText(t('a2ui.status.skipped'))).toBeTruthy()
    expect(screen.getByText(t('a2ui.count', { count: '2' }))).toBeTruthy()
  })

  it('opens the selected publication in a read-only in-page preview', async () => {
    vi.stubGlobal('ResizeObserver', class {
      observe(): void {}
      disconnect(): void {}
    })
    const { fetchImpl } = installApi(viewsApi([renderableView]))
    render(<A2uiPanel t={t} fetchImpl={fetchImpl} />)

    await screen.findByText('日志抽取看板')
    fireEvent.click(screen.getByRole('button', { name: t('a2ui.preview') }))

    expect(await screen.findByRole('button', { name: new RegExp(t('a2ui.back')) })).toBeTruthy()
    expect(screen.queryByText('清空看板')).toBeNull()
    expect(screen.queryByTitle('从看板删除这张卡片')).toBeNull()
    expect(screen.queryByText(/当前没有打开的会话/)).toBeNull()
  })

  it('keeps the last rows visible when a refresh fails', async () => {
    let attempts = 0
    const { fetchImpl } = installApi((url) => {
      if (!url.includes('/surfaces/views')) return jsonResponse({}, 404)
      attempts += 1
      return attempts === 1 ? jsonResponse({ views: [renderableView] }) : jsonResponse({}, 503)
    })
    render(<A2uiPanel t={t} fetchImpl={fetchImpl} />)

    await screen.findByText('日志抽取看板')
    fireEvent.click(screen.getByRole('button', { name: t('page.refresh') }))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain(t('page.error.http', { status: '503' }))
    expect(screen.getByText('日志抽取看板')).toBeTruthy()
  })

  it('sends the publication request with the session cookie', async () => {
    const { calls, fetchImpl } = installApi(viewsApi([renderableView]))
    render(<A2uiPanel t={t} fetchImpl={fetchImpl} />)

    await screen.findByText('日志抽取看板')
    expect(calls.length).toBeGreaterThan(0)
    expect(calls.every(call => call.init?.credentials === 'include')).toBe(true)
  })
})
