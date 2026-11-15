// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'

import { zh } from '../src/client/page-locales.js'
import { SessionReplayPanel } from '../src/client/session-replay-panel.js'

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

const sessions = [
  { id: 'session-a', title: 'Weekly report', live: false, persisted: true, updatedAt: '2026-11-01T09:00:00.000Z' },
  { id: 'session-b', title: 'Log extraction', live: true, persisted: true, updatedAt: '2026-11-01T10:00:00.000Z' },
] as const

function sessionListApi(logHandler: (sessionId: string) => Response | Promise<Response>): ApiHandler {
  return (url) => {
    if (url.includes('/session-log')) {
      const id = new URL(url, 'http://localhost').searchParams.get('id') ?? ''
      return logHandler(id)
    }
    if (url.includes('/sessions')) return jsonResponse({ sessions })
    return jsonResponse({}, 404)
  }
}

describe('session replay page', () => {
  it('lists the persisted sessions and opens the first one', async () => {
    const { fetchImpl } = installApi(sessionListApi(() => jsonResponse({
      title: 'Weekly report',
      total: 2,
      events: [
        { type: 'user_message', at: '2026-11-01T09:00:01.000Z', preview: '抽取本周日志' },
        { type: 'agent_message', at: '2026-11-01T09:00:09.000Z', preview: '已汇总 3 条' },
      ],
    })))
    render(<SessionReplayPanel t={t} fetchImpl={fetchImpl} />)

    expect(await screen.findByText('Weekly report')).toBeTruthy()
    expect(screen.getByText('Log extraction')).toBeTruthy()
    expect(screen.getAllByText(new RegExp(t('replay.persisted'))).length).toBe(2)
    expect(await screen.findByText('抽取本周日志')).toBeTruthy()
    expect(screen.getByText('已汇总 3 条')).toBeTruthy()
    expect(screen.getByText('2026-11-01 09:00:01')).toBeTruthy()
  })

  it('says how many events were left out when the log is longer than the page', async () => {
    const { fetchImpl } = installApi(sessionListApi(() => jsonResponse({
      title: 'Weekly report',
      total: 812,
      events: [{ type: 'user_message', at: null, preview: 'first' }],
    })))
    render(<SessionReplayPanel t={t} fetchImpl={fetchImpl} />)

    await screen.findByText('first')
    expect(screen.getByText(t('replay.truncated', { shown: '1', total: '812' }))).toBeTruthy()
  })

  it('keeps the events of the previous session when the next one fails', async () => {
    const { fetchImpl } = installApi(sessionListApi(sessionId => sessionId === 'session-a'
      ? jsonResponse({
        title: 'Weekly report',
        total: 1,
        events: [{ type: 'user_message', at: null, preview: '仍在屏幕上的事件' }],
      })
      : jsonResponse({ error: 'session not found' })))
    render(<SessionReplayPanel t={t} fetchImpl={fetchImpl} />)

    await screen.findByText('仍在屏幕上的事件')
    fireEvent.click(screen.getByText('Log extraction'))

    expect(await screen.findByText(t('replay.eventsFailed', { message: 'session not found' }))).toBeTruthy()
    expect(screen.getByText('仍在屏幕上的事件')).toBeTruthy()
  })

  it('reports a failed session list and retries through the same endpoint', async () => {
    let attempts = 0
    const { calls, fetchImpl } = installApi((url) => {
      if (url.includes('/sessions')) {
        attempts += 1
        return attempts === 1 ? jsonResponse({}, 503) : jsonResponse({ sessions })
      }
      return jsonResponse({ title: 'Weekly report', total: 0, events: [] })
    })
    render(<SessionReplayPanel t={t} fetchImpl={fetchImpl} />)

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain(t('page.error.http', { status: '503' }))
    fireEvent.click(screen.getByRole('button', { name: t('page.retry') }))
    await screen.findByText('Weekly report')
    expect(calls.filter(call => call.url.endsWith('/sessions')).length).toBe(2)
  })

  it('sends every replay request with the session cookie', async () => {
    const { calls, fetchImpl } = installApi(sessionListApi(() => jsonResponse({
      title: 'Weekly report',
      total: 0,
      events: [],
    })))
    render(<SessionReplayPanel t={t} fetchImpl={fetchImpl} />)

    await screen.findByText('Weekly report')
    expect(calls.length).toBeGreaterThan(0)
    expect(calls.every(call => call.init?.credentials === 'include')).toBe(true)
  })
})
