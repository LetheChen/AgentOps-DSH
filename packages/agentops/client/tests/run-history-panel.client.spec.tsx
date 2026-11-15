// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'

import { zh } from '../src/client/run-history-locales.js'
import { RunHistoryPanel } from '../src/client/run-history-panel.js'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const t = makeTranslate(zh)

interface ApiCall {
  readonly url: string
  readonly init: RequestInit | undefined
}

type ApiHandler = (url: string, init: RequestInit | undefined) => Response | Promise<Response>

interface DeferredResponse {
  readonly promise: Promise<Response>
  readonly resolve: (response: Response) => void
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function deferredResponse(): DeferredResponse {
  let resolve!: (response: Response) => void
  const promise = new Promise<Response>((done) => { resolve = done })
  return { promise, resolve }
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.href
  return input.url
}

function installApi(handler: ApiHandler): ApiCall[] {
  const calls: ApiCall[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = requestUrl(input)
    calls.push({ url, init })
    return handler(url, init)
  }))
  return calls
}

function listRequests(calls: readonly ApiCall[]): ApiCall[] {
  return calls.filter(call => new URL(call.url, 'http://localhost').pathname === '/api/agentops/runs')
}

function detailRequests(calls: readonly ApiCall[]): ApiCall[] {
  return calls.filter(call => new URL(call.url, 'http://localhost').pathname === '/api/agentops/run')
}

function runSummary(
  runId: string,
  workflowId: string,
  status: 'running' | 'completed' | 'failed' | 'cancelled',
  options: { finishedAt?: string; error?: string } = {},
): Record<string, unknown> {
  return {
    runId,
    workflowId,
    status,
    startedAt: '2026-10-25T00:00:00.000Z',
    ...options,
  }
}

function runDetail(
  runId: string,
  workflowId: string,
  options: { error?: string; nodes?: readonly Record<string, unknown>[] } = {},
): Record<string, unknown> {
  return {
    runId,
    workflowId,
    status: 'failed',
    startedAt: '2026-10-25T00:00:00.000Z',
    finishedAt: '2026-10-25T00:00:08.000Z',
    ...options,
    nodes: options.nodes ?? [],
  }
}

describe('run history panel', () => {
  it('shows a skeleton before rendering the first list page', async () => {
    const firstPage = deferredResponse()
    installApi(() => firstPage.promise)
    render(<RunHistoryPanel t={t} />)

    expect(screen.getByRole('status').textContent).toContain(t('page.loading'))
    await act(async () => {
      firstPage.resolve(jsonResponse({
        runs: [runSummary('run-1', 'log-patrol', 'running')],
        total: 1,
      }))
    })

    await screen.findByText('run-1')
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('reloads for a status filter and searches the visible rows locally', async () => {
    const calls = installApi((url) => {
      const status = new URL(url, 'http://localhost').searchParams.get('status')
      return jsonResponse({
        runs: status === 'failed'
          ? [runSummary('run-2', 'billing', 'failed', { error: 'charged twice' })]
          : [
            runSummary('run-1', 'checkout', 'completed'),
            runSummary('run-2', 'billing', 'failed', { error: 'charged twice' }),
          ],
        total: status === 'failed' ? 1 : 2,
      })
    })
    render(<RunHistoryPanel t={t} />)

    await screen.findByText('run-1')
    const search = screen.getByRole('searchbox', { name: t('page.searchLabel') })
    fireEvent.change(search, { target: { value: 'BILLING' } })
    expect(screen.queryByText('run-1')).toBeNull()
    expect(screen.getByText('run-2')).toBeTruthy()

    fireEvent.change(search, { target: { value: '' } })
    fireEvent.change(screen.getByRole('combobox', { name: t('page.statusFilter') }), {
      target: { value: 'failed' },
    })

    await waitFor(() => { expect(listRequests(calls)).toHaveLength(2) })
    expect(listRequests(calls)[1]!.url).toContain('status=failed')
    await waitFor(() => { expect(screen.queryByText('run-1')).toBeNull() })
    expect(screen.getByText('run-2')).toBeTruthy()
    expect(screen.getByText(t('page.count', { shown: '1', total: '1' }))).toBeTruthy()
  })

  it('renders detail timings, root and node errors, ports, and outputs', async () => {
    installApi((url) => {
      if (new URL(url, 'http://localhost').pathname === '/api/agentops/runs') {
        return jsonResponse({
          runs: [runSummary('run-detail', 'log-patrol', 'failed', { error: 'summary failed' })],
          total: 1,
        })
      }
      return jsonResponse(runDetail('run-detail', 'log-patrol', {
        error: 'workflow failed',
        nodes: [{
          id: 'scan',
          status: 'failed',
          attempts: 2,
          startedAt: '2026-10-25T00:00:01.000Z',
          finishedAt: '2026-10-25T00:00:07.500Z',
          error: 'model timeout',
          chosenPort: 'retry',
          outputs: { records: ['one', 'two'], nested: { ok: true } },
        }],
      }))
    })
    render(<RunHistoryPanel t={t} />)

    await screen.findByText('run-detail')
    fireEvent.click(screen.getByRole('button', { name: t('page.expandFor', { id: 'run-detail' }) }))

    const region = await screen.findByRole('region', {
      name: t('page.detailAria', { id: 'run-detail' }),
    })
    expect(region).toBeTruthy()
    expect(screen.getByText('workflow failed')).toBeTruthy()
    expect(screen.getByText('model timeout')).toBeTruthy()
    expect(screen.getByText('retry')).toBeTruthy()
    expect(screen.getByText('2026-10-25 00:00:08')).toBeTruthy()
    expect(screen.getByText(t('page.durationSeconds', { value: '8.0' }))).toBeTruthy()
    expect(screen.getByText((content, element) => (
      element?.tagName === 'PRE' && content.includes('"records"') && content.includes('"ok": true')
    ))).toBeTruthy()
  })

  it('keeps a failed detail visible with a retry that loads the run', async () => {
    let detailAttempts = 0
    installApi((url) => {
      if (new URL(url, 'http://localhost').pathname === '/api/agentops/runs') {
        return jsonResponse({
          runs: [runSummary('run-retry', 'log-patrol', 'failed')],
          total: 1,
        })
      }
      detailAttempts += 1
      return detailAttempts === 1
        ? jsonResponse({ error: 'temporarily unavailable' }, 503)
        : jsonResponse(runDetail('run-retry', 'log-patrol'))
    })
    render(<RunHistoryPanel t={t} />)

    await screen.findByText('run-retry')
    fireEvent.click(screen.getByRole('button', { name: t('page.expandFor', { id: 'run-retry' }) }))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain(t('page.detailLoadFailed', {
      message: 'run history request failed with HTTP 503',
    }))

    fireEvent.click(screen.getByRole('button', { name: t('page.retry') }))
    await waitFor(() => { expect(detailAttempts).toBe(2) })
    expect(await screen.findByText(t('page.noNodes'))).toBeTruthy()
  })

  it('ignores a late detail response after another run is expanded', async () => {
    const slowA = deferredResponse()
    const slowB = deferredResponse()
    installApi((url) => {
      if (new URL(url, 'http://localhost').pathname === '/api/agentops/runs') {
        return jsonResponse({
          runs: [
            runSummary('run-a', 'workflow-a', 'failed'),
            runSummary('run-b', 'workflow-b', 'failed'),
          ],
          total: 2,
        })
      }
      return new URL(url, 'http://localhost').searchParams.get('id') === 'run-a'
        ? slowA.promise
        : slowB.promise
    })
    render(<RunHistoryPanel t={t} />)

    await screen.findByText('run-a')
    fireEvent.click(screen.getByRole('button', { name: t('page.expandFor', { id: 'run-a' }) }))
    fireEvent.click(screen.getByRole('button', { name: t('page.expandFor', { id: 'run-b' }) }))

    await act(async () => {
      slowA.resolve(jsonResponse(runDetail('run-a', 'workflow-a', {
        nodes: [{ id: 'node-a', status: 'completed', attempts: 1 }],
      })))
    })
    expect(screen.queryByText('node-a')).toBeNull()
    expect(screen.getByText(t('page.loadingDetail'))).toBeTruthy()

    await act(async () => {
      slowB.resolve(jsonResponse(runDetail('run-b', 'workflow-b', {
        nodes: [{ id: 'node-b', status: 'completed', attempts: 1 }],
      })))
    })
    expect(await screen.findByText('node-b')).toBeTruthy()
    expect(screen.queryByText('node-a')).toBeNull()
  })

  it('keeps the old rows visible when refresh fails', async () => {
    let listAttempts = 0
    installApi(() => {
      listAttempts += 1
      return listAttempts === 1
        ? jsonResponse({ runs: [runSummary('run-1', 'log-patrol', 'completed')], total: 1 })
        : jsonResponse({ error: 'host unavailable' }, 503)
    })
    render(<RunHistoryPanel t={t} />)

    await screen.findByText('run-1')
    fireEvent.click(screen.getByRole('button', { name: t('page.refresh') }))
    await waitFor(() => { expect(listAttempts).toBe(2) })
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain(t('page.refreshFailed', {
      message: 'run history request failed with HTTP 503',
    }))
    expect(screen.getByText('run-1')).toBeTruthy()
    expect(screen.getByText(t('page.count', { shown: '1', total: '1' }))).toBeTruthy()
  })

  it('appends and de-duplicates the next page before updating the total', async () => {
    const calls = installApi((url) => {
      const offset = new URL(url, 'http://localhost').searchParams.get('offset')
      return jsonResponse({
        runs: offset === '2'
          ? [
            runSummary('run-2', 'billing', 'failed'),
            runSummary('run-3', 'receipts', 'completed'),
          ]
          : [
            runSummary('run-1', 'checkout', 'completed'),
            runSummary('run-2', 'billing', 'failed'),
          ],
        total: 3,
      })
    })
    render(<RunHistoryPanel t={t} />)

    await screen.findByText('run-1')
    expect(screen.getByText(t('page.count', { shown: '2', total: '3' }))).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: t('page.showMore') }))

    await screen.findByText('run-3')
    await waitFor(() => { expect(listRequests(calls)).toHaveLength(2) })
    expect(listRequests(calls)[1]!.url).toContain('offset=2')
    expect(screen.getAllByText('run-2')).toHaveLength(1)
    expect(screen.getByText(t('page.count', { shown: '3', total: '3' }))).toBeTruthy()
    expect(screen.queryByRole('button', { name: t('page.showMore') })).toBeNull()
    expect(detailRequests(calls)).toHaveLength(0)
  })

  it('resets load-more state when a filter reload supersedes the append', async () => {
    const pendingAppend = deferredResponse()
    let appendRequests = 0
    installApi((url) => {
      const parsed = new URL(url, 'http://localhost')
      if (parsed.pathname !== '/api/agentops/runs') return jsonResponse({}, 404)
      if (parsed.searchParams.get('status') === 'failed') {
        return jsonResponse({
          runs: [runSummary('run-failed', 'billing', 'failed')],
          total: 2,
        })
      }
      if (parsed.searchParams.get('offset') === '1') {
        appendRequests += 1
        return pendingAppend.promise
      }
      return jsonResponse({
        runs: [runSummary('run-1', 'checkout', 'completed')],
        total: 2,
      })
    })
    render(<RunHistoryPanel t={t} />)

    await screen.findByText('run-1')
    fireEvent.click(screen.getByRole('button', { name: t('page.showMore') }))
    await waitFor(() => { expect(appendRequests).toBe(1) })
    expect(screen.getByRole('button', { name: t('page.refresh') }).hasAttribute('disabled')).toBe(true)

    fireEvent.change(screen.getByRole('combobox', { name: t('page.statusFilter') }), {
      target: { value: 'failed' },
    })
    await screen.findByText('run-failed')
    expect(screen.getByRole('button', { name: t('page.showMore') }).hasAttribute('disabled')).toBe(false)

    await act(async () => {
      pendingAppend.resolve(jsonResponse({
        runs: [runSummary('run-2', 'receipts', 'completed')],
        total: 2,
      }))
    })
    expect(screen.queryByText('run-2')).toBeNull()
    expect(screen.getByText('run-failed')).toBeTruthy()
  })
  it('hands the chosen run to the collaboration panel', async () => {
    installApi(() => jsonResponse({ runs: [runSummary('run-1', 'log-patrol', 'running')], total: 1 }))
    const openCollaboration = vi.fn<(runId: string) => void>()
    render(<RunHistoryPanel t={t} openCollaboration={openCollaboration} />)

    await screen.findByText('run-1')
    fireEvent.click(screen.getByRole('button', { name: t('page.openInCollaborationFor', { id: 'run-1' }) }))

    expect(openCollaboration).toHaveBeenCalledTimes(1)
    expect(openCollaboration).toHaveBeenCalledWith('run-1')
  })

  it('hides the collaboration shortcut when no handler is supplied', async () => {
    installApi(() => jsonResponse({ runs: [runSummary('run-1', 'log-patrol', 'running')], total: 1 }))
    render(<RunHistoryPanel t={t} />)

    await screen.findByText('run-1')
    expect(screen.queryByRole('button', { name: t('page.openInCollaborationFor', { id: 'run-1' }) })).toBeNull()
  })
})
