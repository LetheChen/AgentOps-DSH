// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'

import type {
  ActivityLane,
  ActivityNode,
  ActivityTimelineEntry,
  RerunErrorCode,
  RunActivity,
} from '../src/client/collaboration-api.js'
import { zh } from '../src/client/collaboration-locales.js'
import { requestCollaborationRun } from '../src/client/collaboration-target.js'
import { CollaborationPanel } from '../src/client/collaboration-panel.js'

const collaborationCss = readFileSync(
  resolve(import.meta.dirname, '../src/client/styles/collaboration.css'),
  'utf8',
)

const t = makeTranslate(zh)

function isDisabled(element: HTMLElement): boolean {
  return element.matches(':disabled')
}

function isChecked(element: HTMLElement): boolean {
  return element.matches(':checked')
}

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

function pathOf(call: ApiCall): string {
  return new URL(call.url, 'http://localhost').pathname
}

function activityCalls(calls: readonly ApiCall[]): ApiCall[] {
  return calls.filter(call => pathOf(call) === '/api/agentops/run-activity')
}

function runPage(status: 'running' | 'completed' | 'failed' | 'cancelled' = 'running'): Record<string, unknown> {
  return {
    runs: [{
      runId: 'run-1',
      workflowId: 'log-patrol',
      status,
      startedAt: '2026-10-30T00:00:00.000Z',
    }],
    total: 1,
  }
}

function lane(id: string, label: string, nodeIds: readonly string[]): ActivityLane {
  return { id, label, nodeIds }
}

function node(id: string, overrides: Partial<ActivityNode> = {}): ActivityNode {
  return {
    id,
    displayName: id,
    type: 'agent',
    laneId: 'default',
    status: 'pending',
    attempts: 0,
    ...overrides,
  }
}

function timelineEntry(
  id: string,
  type: ActivityTimelineEntry['type'],
  occurredAt: string,
  overrides: Partial<ActivityTimelineEntry> = {},
): ActivityTimelineEntry {
  return { id, type, occurredAt, ...overrides }
}

function activity(overrides: Partial<RunActivity> = {}): RunActivity {
  return {
    runId: 'run-1',
    workflowId: 'log-patrol',
    status: 'running',
    startedAt: '2026-10-30T00:00:00.000Z',
    inputs: {
      topic: 'migration',
      retries: 0,
      nested: { tags: ['ops', null] },
    },
    lanes: [],
    nodes: [],
    scheduleEdges: [],
    dataEdges: [],
    timeline: [],
    handoffs: [],
    ...overrides,
  }
}

function renderPanel(
  pollIntervalMs = 3_000,
  publishRerunNotice = vi.fn<(text: string) => void>(),
  initialRunId?: string,
): ReturnType<typeof render> {
  return render(
    <CollaborationPanel
      t={t}
      pollIntervalMs={pollIntervalMs}
      publishRerunNotice={publishRerunNotice}
      {...(initialRunId === undefined ? {} : { initialRunId })}
    />,
  )
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    value: 'visible',
  })
})

async function openRunMenu(): Promise<HTMLElement> {
  fireEvent.click(screen.getByRole('button', { name: t('run.listAria') }))
  return screen.findByRole('menu')
}

function runMenuItem(menu: HTMLElement, runId: string): HTMLElement {
  const item = within(menu).getAllByRole('menuitem').find(candidate => candidate.textContent?.includes(runId))
  if (item === undefined) throw new Error(`run menu item ${runId} is missing`)
  return item
}

describe('collaboration panel', () => {
  it('loads the first run automatically and keeps the run list in a closed picker', async () => {
    const calls = installApi((url) => {
      if (new URL(url, 'http://localhost').pathname === '/api/agentops/runs') {
        return jsonResponse({
          runs: [
            { runId: 'run-1', workflowId: 'log-patrol', status: 'running', startedAt: '2026-10-30T00:00:00.000Z' },
            { runId: 'run-2', workflowId: 'billing', status: 'completed', startedAt: '2026-10-29T00:00:00.000Z' },
          ],
          total: 2,
        })
      }
      return jsonResponse(activity({
        lanes: [lane('ingest', '收单泳道', ['scan'])],
        nodes: [node('scan', { displayName: '扫描票据', laneId: 'ingest', status: 'completed' })],
      }))
    })

    renderPanel()

    expect(await screen.findByText('扫描票据')).toBeTruthy()
    expect(screen.getByRole('group', { name: t('graph.aria', { id: 'run-1' }) })).toBeTruthy()
    expect(screen.queryByText('run-2')).toBeNull()
    expect(screen.queryByRole('menu')).toBeNull()
    const trigger = screen.getByRole('button', { name: t('run.listAria') })
    expect(trigger.textContent).toContain('log-patrol')
    expect(trigger.textContent).toContain('run-1')
    expect(trigger.getAttribute('aria-expanded')).toBe('false')

    const menu = await openRunMenu()
    expect(within(menu).getByText('run-1')).toBeTruthy()
    expect(within(menu).getByText('run-2')).toBeTruthy()
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    expect(activityCalls(calls)).toHaveLength(1)
    expect(activityCalls(calls)[0]?.url).toContain('id=run-1')
    expect(screen.getByText(t('handoff.empty'))).toBeTruthy()
  })

  it('selects the run from the URL even when it is not first', async () => {
    const calls = installApi((url) => {
      const parsed = new URL(url, 'http://localhost')
      if (parsed.pathname === '/api/agentops/runs') {
        return jsonResponse({
          runs: [
            { runId: 'run-1', workflowId: 'log-patrol', status: 'running', startedAt: '2026-10-30T00:00:00.000Z' },
            { runId: 'run-2', workflowId: 'billing', status: 'completed', startedAt: '2026-10-29T00:00:00.000Z' },
          ],
          total: 2,
        })
      }
      return jsonResponse(activity({
        runId: 'run-2',
        workflowId: 'billing',
        status: 'completed',
        lanes: [lane('default', '默认泳道', ['bill-check'])],
        nodes: [node('bill-check', { displayName: '核对账单', status: 'completed' })],
      }))
    })

    renderPanel(3_000, vi.fn(), 'run-2')

    expect(await screen.findByText('核对账单')).toBeTruthy()
    const trigger = screen.getByRole('button', { name: t('run.listAria') })
    expect(trigger.textContent).toContain('billing')
    expect(trigger.textContent).toContain('run-2')
    const menu = await openRunMenu()
    expect(runMenuItem(menu, 'run-1')).toBeTruthy()
    expect(runMenuItem(menu, 'run-2')).toBeTruthy()
    expect(activityCalls(calls)).toHaveLength(1)
    expect(new URL(activityCalls(calls)[0]?.url ?? '', 'http://localhost').searchParams.get('id')).toBe('run-2')
  })
  it('claims the run the history panel parked before the layout switch', async () => {
    const calls = installApi((url) => {
      const parsed = new URL(url, 'http://localhost')
      if (parsed.pathname === '/api/agentops/runs') {
        return jsonResponse({
          runs: [
            { runId: 'run-1', workflowId: 'log-patrol', status: 'running', startedAt: '2026-10-30T00:00:00.000Z' },
            { runId: 'run-2', workflowId: 'billing', status: 'completed', startedAt: '2026-10-29T00:00:00.000Z' },
          ],
          total: 2,
        })
      }
      return jsonResponse(activity({
        runId: 'run-2',
        workflowId: 'billing',
        status: 'completed',
        lanes: [lane('default', '默认泳道', ['bill-check'])],
        nodes: [node('bill-check', { displayName: '核对账单', status: 'completed' })],
      }))
    })

    requestCollaborationRun('run-2')
    renderPanel()

    expect(await screen.findByText('核对账单')).toBeTruthy()
    const trigger = screen.getByRole('button', { name: t('run.listAria') })
    expect(trigger.textContent).toContain('run-2')
    expect(activityCalls(calls)).toHaveLength(1)
    expect(new URL(activityCalls(calls)[0]?.url ?? '', 'http://localhost').searchParams.get('id')).toBe('run-2')
  })

  it('does not select a fallback run when the URL run is not in the current page', async () => {
    const calls = installApi((url) => {
      if (new URL(url, 'http://localhost').pathname === '/api/agentops/runs') return jsonResponse(runPage())
      throw new Error('activity must not be requested without a selected run')
    })

    renderPanel(3_000, vi.fn(), 'run-from-link')

    expect(await screen.findByText(t('run.notInPage'))).toBeTruthy()
    expect(screen.queryByRole('menu')).toBeNull()
    const menu = await openRunMenu()
    expect(within(menu).getAllByRole('menuitem')).toHaveLength(1)
    expect(runMenuItem(menu, 'run-1')).toBeTruthy()
    expect(activityCalls(calls)).toHaveLength(0)
    expect(within(screen.getByRole('main')).queryByText(t('run.noSelection'))).toBeNull()
  })

  it('keeps a manual selection when a later run-list replace no longer has the URL run', async () => {
    const calls = installApi((url) => {
      const parsed = new URL(url, 'http://localhost')
      if (parsed.pathname === '/api/agentops/runs') {
        return jsonResponse({
          runs: [
            { runId: 'run-1', workflowId: 'log-patrol', status: 'running', startedAt: '2026-10-30T00:00:00.000Z' },
            { runId: 'run-2', workflowId: 'billing', status: 'completed', startedAt: '2026-10-29T00:00:00.000Z' },
          ],
          total: 2,
        })
      }
      return jsonResponse(activity({
        runId: 'run-2',
        workflowId: 'billing',
        status: 'completed',
        lanes: [lane('default', '默认泳道', ['bill-check'])],
        nodes: [node('bill-check', { displayName: '核对账单', status: 'completed' })],
      }))
    })
    const publishRerunNotice = vi.fn<(text: string) => void>()
    const rendered = renderPanel(3_000, publishRerunNotice, 'run-from-link')

    expect(await screen.findByText(t('run.notInPage'))).toBeTruthy()
    const menu = await openRunMenu()
    fireEvent.click(runMenuItem(menu, 'run-2'))
    expect(await screen.findByText('核对账单')).toBeTruthy()
    expect(screen.queryByRole('menu')).toBeNull()
    expect(screen.getByRole('button', { name: t('run.listAria') }).textContent).toContain('run-2')

    rendered.rerender(
      <CollaborationPanel
        t={t}
        pollIntervalMs={3_000}
        publishRerunNotice={publishRerunNotice}
        initialRunId="another-run-from-link"
      />,
    )

    await waitFor(() => {
      expect(calls.filter(call => pathOf(call) === '/api/agentops/runs')).toHaveLength(2)
    })
    expect(screen.getByRole('button', { name: t('run.listAria') }).textContent).toContain('run-2')
    expect(screen.queryByText(t('run.notInPage'))).toBeNull()
  })

  it('closes the run picker on Escape and outside pointer input', async () => {
    installApi((url) => {
      if (new URL(url, 'http://localhost').pathname === '/api/agentops/runs') {
        return jsonResponse({
          runs: [
            { runId: 'run-1', workflowId: 'log-patrol', status: 'running', startedAt: '2026-10-30T00:00:00.000Z' },
            { runId: 'run-2', workflowId: 'billing', status: 'completed', startedAt: '2026-10-29T00:00:00.000Z' },
          ],
          total: 2,
        })
      }
      return jsonResponse(activity())
    })

    renderPanel()
    await screen.findByText(t('handoff.empty'))
    await openRunMenu()
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => { expect(screen.queryByRole('menu')).toBeNull() })

    await openRunMenu()
    fireEvent.pointerDown(document.body)
    await waitFor(() => { expect(screen.queryByRole('menu')).toBeNull() })
  })

  it('loads another run page from the open picker without closing it', async () => {
    const calls = installApi((url) => {
      const parsed = new URL(url, 'http://localhost')
      if (parsed.pathname === '/api/agentops/runs') {
        const offset = parsed.searchParams.get('offset')
        return jsonResponse(offset === '1'
          ? {
            runs: [
              { runId: 'run-2', workflowId: 'billing', status: 'completed', startedAt: '2026-10-29T00:00:00.000Z' },
            ],
            total: 2,
          }
          : {
            runs: [
              { runId: 'run-1', workflowId: 'log-patrol', status: 'running', startedAt: '2026-10-30T00:00:00.000Z' },
            ],
            total: 2,
          })
      }
      return jsonResponse(activity())
    })

    renderPanel()
    await screen.findByText(t('handoff.empty'))
    const menu = await openRunMenu()
    fireEvent.click(within(menu).getByRole('menuitem', { name: t('run.loadMore') }))

    await waitFor(() => {
      expect(calls.filter(call => pathOf(call) === '/api/agentops/runs')).toHaveLength(2)
    })
    expect(new URL(calls.filter(call => pathOf(call) === '/api/agentops/runs')[1]?.url ?? '', 'http://localhost').searchParams.get('offset')).toBe('1')
    expect(screen.getByRole('menu')).toBeTruthy()
    expect(within(screen.getByRole('menu')).getByText('run-2')).toBeTruthy()
  })

  it('shows the selected run facts without inventing a live state', async () => {
    installApi((url) => {
      if (new URL(url, 'http://localhost').pathname === '/api/agentops/runs') return jsonResponse(runPage('completed'))
      return jsonResponse(activity({
        runId: 'run-42',
        workflowId: 'claims-review',
        status: 'completed',
        startedAt: '2026-10-30T01:02:03.000Z',
      }))
    })

    renderPanel()

    const summary = await screen.findByRole('group', { name: t('run.summaryAria') })
    expect(within(summary).getByText(t('run.id'))).toBeTruthy()
    expect(within(summary).getByText('run-42')).toBeTruthy()
    expect(within(summary).getByText(t('run.workflow'))).toBeTruthy()
    expect(within(summary).getByText('claims-review')).toBeTruthy()
    expect(within(summary).getByText(t('run.startedAt'))).toBeTruthy()
    expect(within(summary).getByText('2026-10-30 01:02:03')).toBeTruthy()
    expect(within(summary).getByText(t('status.completed'))).toBeTruthy()
    expect(screen.queryByText(/实时状态|live state/i)).toBeNull()
  })

  it('shows the run-list failure instead of the missing-from-page message', async () => {
    const calls = installApi((url) => {
      if (new URL(url, 'http://localhost').pathname === '/api/agentops/runs') {
        return jsonResponse({ error: { code: 'internal_error', message: 'hidden' } }, 500)
      }
      throw new Error('activity must not be requested after a run-list failure')
    })

    renderPanel(3_000, vi.fn(), 'run-from-link')

    expect(await screen.findByText(content => content.startsWith('无法加载运行'))).toBeTruthy()
    expect(screen.queryByText(t('run.notInPage'))).toBeNull()
    expect(activityCalls(calls)).toHaveLength(0)
  })

  it('shows localized structured errors and validation issues without server text', async () => {
    installApi((url) => {
      if (new URL(url, 'http://localhost').pathname === '/api/agentops/runs') {
        return jsonResponse(runPage())
      }
      return jsonResponse({
        error: {
          code: 'workflow_invalid',
          message: 'SQLITE secret stack and implementation details',
          issues: ['node scan: missing command', 'edge scan -> report: cycle'],
        },
      }, 422)
    })

    renderPanel()

    expect(await screen.findByText(t('error.workflowInvalid'))).toBeTruthy()
    expect(screen.queryByText(/SQLITE secret stack/)).toBeNull()
    expect(screen.getByText(t('error.issueTitle'))).toBeTruthy()
    expect(screen.getByText(t('error.issueCount', { count: '2' }))).toBeTruthy()
    expect(screen.getByText('node scan: missing command')).toBeTruthy()
  })

  it('keeps the current activity when a manual refresh fails', async () => {
    let activityRequest = 0
    installApi((url) => {
      if (new URL(url, 'http://localhost').pathname === '/api/agentops/runs') {
        return jsonResponse(runPage())
      }
      activityRequest += 1
      if (activityRequest === 1) {
        return jsonResponse(activity({
          lanes: [lane('ingest', '收单泳道', ['scan'])],
          nodes: [node('scan', { displayName: '扫描票据', laneId: 'ingest', status: 'running' })],
        }))
      }
      return jsonResponse({ error: { code: 'internal_error', message: 'database password leaked' } }, 500)
    })

    renderPanel()
    expect(await screen.findByText('扫描票据')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: t('run.refresh') }))

    expect(await screen.findByText(t('run.refreshFailed', { message: t('error.internalError') }))).toBeTruthy()
    expect(screen.getByText('扫描票据')).toBeTruthy()
    expect(screen.queryByText(/database password leaked/)).toBeNull()
  })

  it('polls a running run and stops after a terminal response', async () => {
    let activityRequest = 0
    const calls = installApi((url) => {
      if (new URL(url, 'http://localhost').pathname === '/api/agentops/runs') {
        return jsonResponse(runPage())
      }
      activityRequest += 1
      return jsonResponse(activity({
        status: activityRequest === 1 ? 'running' : 'completed',
        lanes: [lane('default', '默认泳道', ['scan'])],
        nodes: [node('scan', { displayName: '扫描票据', status: activityRequest === 1 ? 'running' : 'completed' })],
      }))
    })

    renderPanel(20)
    expect(await screen.findByText('扫描票据')).toBeTruthy()
    await waitFor(() => { expect(activityCalls(calls)).toHaveLength(2) }, { timeout: 1_000 })
    await sleep(60)
    expect(activityCalls(calls)).toHaveLength(2)
  })

  it('does not poll while the page is hidden and resumes when visible', async () => {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'hidden',
    })
    const calls = installApi((url) => {
      if (new URL(url, 'http://localhost').pathname === '/api/agentops/runs') {
        return jsonResponse(runPage())
      }
      return jsonResponse(activity({
        lanes: [lane('default', '默认泳道', ['scan'])],
        nodes: [node('scan', { displayName: '扫描票据', status: 'running' })],
      }))
    })

    renderPanel(20)
    expect(await screen.findByText('扫描票据')).toBeTruthy()
    await sleep(60)
    expect(activityCalls(calls)).toHaveLength(1)

    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'visible',
    })
    document.dispatchEvent(new Event('visibilitychange'))
    await waitFor(() => { expect(activityCalls(calls).length).toBeGreaterThanOrEqual(2) }, { timeout: 1_000 })
  })

  it('renders lanes and a Gantt from persisted timestamps only', async () => {
    const calls = installApi((url) => {
      if (new URL(url, 'http://localhost').pathname === '/api/agentops/runs') {
        return jsonResponse(runPage())
      }
      return jsonResponse(activity({
        lanes: [lane('ingest', '收单泳道', ['scan', 'analyze', 'pending', 'ready'])],
        nodes: [
          node('scan', {
            displayName: '扫描票据',
            laneId: 'ingest',
            status: 'completed',
            startedAt: '2026-10-30T00:00:00.000Z',
            finishedAt: '2026-10-30T00:00:01.000Z',
            durationMs: 1_000,
          }),
          node('analyze', {
            displayName: '分析风险',
            laneId: 'ingest',
            status: 'running',
            startedAt: '2026-10-30T00:00:02.000Z',
          }),
          node('pending', { displayName: '等待审批', laneId: 'ingest', status: 'pending' }),
          node('ready', { displayName: '准备通知', laneId: 'ingest', status: 'ready' }),
        ],
        timeline: [timelineEntry('timeline-1', 'run.started', '2026-10-30T00:00:00.000Z')],
      }))
    })

    const { container } = renderPanel()
    expect(await screen.findByText('扫描票据')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: t('view.lanes') }))
    expect(screen.getByText('收单泳道')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: t('view.timeline') }))
    expect(screen.getByText(t('gantt.title'))).toBeTruthy()
    const bars = [...container.querySelectorAll<HTMLElement>('.collab-gantt-bar')]
    expect(bars).toHaveLength(2)
    expect(bars.some(bar => bar.dataset.nodeId === 'pending')).toBe(false)
    expect(bars.some(bar => bar.dataset.nodeId === 'ready')).toBe(false)
    const running = bars.find(bar => bar.dataset.nodeId === 'analyze')
    expect(running?.classList.contains('is-start-only')).toBe(true)
    expect(running?.textContent).toContain(t('gantt.startOnly'))
    expect(screen.getByText(t('duration.seconds', { value: '1.0' }))).toBeTruthy()

    const persistedStyle = running?.getAttribute('style')
    const now = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2099-01-01T00:00:00.000Z'))
    fireEvent.click(screen.getByRole('button', { name: t('run.refresh') }))
    await waitFor(() => { expect(activityCalls(calls)).toHaveLength(2) })
    const rerenderedRunning = container.querySelector<HTMLElement>('[data-node-id="analyze"]')
    expect(rerenderedRunning?.classList.contains('is-start-only')).toBe(true)
    expect(rerenderedRunning?.getAttribute('style')).toBe(persistedStyle)
    expect(now).toHaveBeenCalled()
  })

  it('uses schedule edges for DAG levels and renders data edges as dashed', async () => {
    installApi((url) => {
      if (new URL(url, 'http://localhost').pathname === '/api/agentops/runs') {
        return jsonResponse(runPage())
      }
      return jsonResponse(activity({
        lanes: [lane('main', '主流程', ['scan', 'analyze', 'report'])],
        nodes: [
          node('scan', { displayName: '扫描', laneId: 'main', status: 'completed' }),
          node('analyze', { displayName: '分析', laneId: 'main', status: 'completed' }),
          node('report', { displayName: '报告', laneId: 'main', status: 'pending' }),
        ],
        scheduleEdges: [{ from: 'scan', to: 'report' }],
        dataEdges: [{ from: 'analyze', to: 'report', port: 'records' }],
      }))
    })

    const { container } = renderPanel()
    expect(await screen.findByText('扫描')).toBeTruthy()

    const groups = [...container.querySelectorAll<SVGGElement>('.dag-canvas-node')]
    const analyze = groups.find(group => group.textContent?.includes('analyze'))
    const report = groups.find(group => group.textContent?.includes('report'))
    expect(groupLevel(analyze)).toBe(t('graph.level', { level: '0' }))
    expect(groupLevel(report)).toBe(t('graph.level', { level: '1' }))
    const schedule = container.querySelector('.dag-canvas-edge-schedule')
    const data = container.querySelector('.dag-canvas-edge-data')
    expect(schedule?.getAttribute('stroke-dasharray')).toBeNull()
    expect(data?.getAttribute('stroke-dasharray')).toBe('5 4')
    expect(container.querySelector('.dag-canvas-edge-port')?.textContent).toBe('records')
  })

  it('summarizes persisted actors and selects rows with pointer or keyboard', async () => {
    installApi((url) => {
      if (new URL(url, 'http://localhost').pathname === '/api/agentops/runs') {
        return jsonResponse(runPage('completed'))
      }
      return jsonResponse(activity({
        status: 'completed',
        lanes: [lane('ingest', '收单泳道', ['scan', 'analyze'])],
        nodes: [
          node('scan', {
            displayName: '扫描票据',
            laneId: 'ingest',
            status: 'failed',
            agentRef: 'agent://invoice',
            businessRole: '审核员',
            harness: 'dsh',
            model: 'deepseek-chat',
            durationMs: 2_500,
            error: '票据格式无效',
          }),
          node('analyze', {
            displayName: '分析风险',
            laneId: 'ingest',
            status: 'running',
            agentRef: 'agent://risk',
            businessRole: '风控专员',
            harness: 'dsh',
            model: 'deepseek-reasoner',
          }),
        ],
      }))
    })

    renderPanel()
    expect(await screen.findByText('扫描票据')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: t('view.actors') }))

    const table = screen.getByRole('table', { name: t('actors.aria', { id: 'run-1' }) })
    const tableText = table.textContent ?? ''
    expect(screen.getByText(t('actors.count', { count: '2' }))).toBeTruthy()
    expect(tableText).toContain('agent://invoice')
    expect(tableText).toContain('审核员')
    expect(tableText).toContain('deepseek-chat')
    expect(tableText).toContain('dsh')
    expect(tableText).toContain(t('nodeStatus.failed'))
    expect(tableText).toContain(t('duration.seconds', { value: '2.5' }))
    expect(tableText).toContain('票据格式无效')
    expect(screen.queryByRole('columnheader', { name: /token/i })).toBeNull()

    fireEvent.click(screen.getByRole('row', { name: t('actors.rowAria', { id: 'scan' }) }))
    let inspector = screen.getByRole('complementary', { name: t('inspector.title') })
    let inspectorText = inspector.textContent ?? ''
    expect(inspectorText).toContain('扫描票据')
    expect(inspectorText).toContain('agent://invoice')
    expect(inspectorText).toContain('审核员')
    expect(inspectorText).toContain('deepseek-chat')

    fireEvent.keyDown(screen.getByRole('row', { name: t('actors.rowAria', { id: 'analyze' }) }), {
      key: 'Enter',
    })
    inspector = screen.getByRole('complementary', { name: t('inspector.title') })
    inspectorText = inspector.textContent ?? ''
    expect(inspectorText).toContain('分析风险')
    expect(inspectorText).toContain('agent://risk')
    expect(inspectorText).toContain('风控专员')
    expect(inspectorText).toContain('deepseek-reasoner')
  })

  it('shows the actor summary empty state when a run has no nodes', async () => {
    installApi((url) => {
      if (new URL(url, 'http://localhost').pathname === '/api/agentops/runs') {
        return jsonResponse(runPage('completed'))
      }
      return jsonResponse(activity({ status: 'completed' }))
    })

    renderPanel()
    expect(await screen.findByRole('button', { name: t('view.actors') })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: t('view.actors') }))
    expect(screen.getByText(t('actors.empty'))).toBeTruthy()
    expect(screen.queryByRole('table')).toBeNull()
  })
  it('shows every persisted inspector field and JSON outputs', async () => {
    installApi((url) => {
      if (new URL(url, 'http://localhost').pathname === '/api/agentops/runs') {
        return jsonResponse(runPage())
      }
      return jsonResponse(activity({
        lanes: [lane('ingest', '收单泳道', ['scan'])],
        nodes: [node('scan', {
          displayName: '扫描票据',
          laneId: 'ingest',
          type: 'agent',
          status: 'failed',
          attempts: 3,
          agentRef: 'agent://invoice',
          businessRole: '审核员',
          harness: 'dsh',
          model: 'deepseek-chat',
          startedAt: '2026-10-30T00:00:00.000Z',
          finishedAt: '2026-10-30T00:00:02.500Z',
          durationMs: 2_500,
          chosenPort: 'records',
          error: '票据格式无效',
          outputs: { records: 2, ok: false, note: 'retry' },
        })],
      }))
    })

    renderPanel()
    expect(await screen.findByText('扫描票据')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: t('graph.nodeAria', { id: 'scan' }) }))

    const inspector = screen.getByRole('complementary', { name: t('inspector.title') })
    const text = inspector.textContent ?? ''
    expect(text).toContain(t('field.id'))
    expect(text).toContain('scan')
    expect(text).toContain(t('field.displayName'))
    expect(text).toContain('扫描票据')
    expect(text).toContain(t('type.agent'))
    expect(text).toContain(t('field.lane'))
    expect(text).toContain('收单泳道')
    expect(text).toContain(t('nodeStatus.failed'))
    expect(text).toContain(t('field.attempts'))
    expect(text).toContain('3')
    expect(text).toContain('agent://invoice')
    expect(text).toContain('审核员')
    expect(text).toContain('dsh')
    expect(text).toContain('deepseek-chat')
    expect(text).toContain('2026-10-30 00:00:00')
    expect(text).toContain('2026-10-30 00:00:02')
    expect(text).toContain(t('duration.seconds', { value: '2.5' }))
    expect(text).toContain('records')
    expect(text).toContain('票据格式无效')
    expect(text).toContain('"records": 2')
    expect(text).toContain('"ok": false')
  })

  it('renders only persisted timeline entries and states the empty handoff store', async () => {
    installApi((url) => {
      if (new URL(url, 'http://localhost').pathname === '/api/agentops/runs') {
        return jsonResponse(runPage('completed'))
      }
      return jsonResponse(activity({
        status: 'completed',
        finishedAt: '2026-10-30T00:00:03.000Z',
        lanes: [lane('default', '默认泳道', ['scan'])],
        nodes: [node('scan', {
          displayName: '扫描票据',
          status: 'completed',
          startedAt: '2026-10-30T00:00:01.000Z',
          finishedAt: '2026-10-30T00:00:02.000Z',
        })],
        timeline: [timelineEntry('timeline-1', 'run.started', '2026-10-30T00:00:00.000Z')],
        handoffs: [],
      }))
    })

    const { container } = renderPanel()
    expect(await screen.findByText('扫描票据')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: t('view.timeline') }))

    expect(container.querySelectorAll('.collab-timeline-item')).toHaveLength(1)
    expect(screen.getByText(t('timeline.runStarted'))).toBeTruthy()
    expect(screen.queryByText(t('timeline.nodeStarted'))).toBeNull()
    expect(screen.getByText(t('handoff.empty'))).toBeTruthy()
  })

  it('reports more than 200 nodes instead of drawing a partial graph', async () => {
    const nodes = Array.from({ length: 201 }, (_, index) => node(`node-${index}`, {
      displayName: `节点 ${index}`,
      laneId: 'large',
      status: 'pending',
    }))
    installApi((url) => {
      if (new URL(url, 'http://localhost').pathname === '/api/agentops/runs') {
        return jsonResponse(runPage())
      }
      return jsonResponse(activity({
        lanes: [lane('large', '大流程', nodes.map(item => item.id))],
        nodes,
      }))
    })

    renderPanel()
    expect(await screen.findByText(t('graph.tooMany'))).toBeTruthy()
    expect(screen.queryByRole('group', { name: t('graph.aria', { id: 'run-1' }) })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: t('view.lanes') }))
    expect(screen.getByText('节点 0')).toBeTruthy()
  })

  it('opens a rerun confirmation from the lanes inspector without posting first', async () => {
    const calls = installApi((url) => {
      if (new URL(url, 'http://localhost').pathname === '/api/agentops/runs') {
        return jsonResponse(runPage('completed'))
      }
      return jsonResponse(activity({
        status: 'completed',
        lanes: [lane('default', '默认泳道', ['scan'])],
        nodes: [node('scan', { displayName: '扫描票据', status: 'completed' })],
      }))
    })

    renderPanel()
    expect(await screen.findByText('扫描票据')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: t('view.lanes') }))
    fireEvent.click(screen.getByRole('button', { name: t('graph.nodeAria', { id: 'scan' }) }))

    const rerun = screen.getByRole('button', { name: '重跑节点' })
    expect(isDisabled(rerun)).toBe(false)
    fireEvent.click(rerun)

    expect(screen.getByRole('dialog', { name: '确认重跑' })).toBeTruthy()
    expect(calls.some(call => pathOf(call) === '/api/agentops/workflow-rerun')).toBe(false)
  })

  it('keeps rerun visible but disabled with a localized reason while the run is active', async () => {
    installApi((url) => {
      if (new URL(url, 'http://localhost').pathname === '/api/agentops/runs') {
        return jsonResponse(runPage('running'))
      }
      return jsonResponse(activity({
        status: 'running',
        lanes: [lane('default', '默认泳道', ['scan'])],
        nodes: [node('scan', { displayName: '扫描票据', status: 'completed' })],
      }))
    })

    renderPanel()
    expect(await screen.findByText('扫描票据')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: t('graph.nodeAria', { id: 'scan' }) }))

    const rerun = screen.getByRole('button', { name: '重跑节点' })
    expect(isDisabled(rerun)).toBe(true)
    expect(screen.getByText('运行进行中时不能重跑节点。')).toBeTruthy()
  })

  it.each([
    ['running', 'completed', '运行进行中时不能重跑节点。'],
    ['completed', 'running', '运行进行中时不能重跑节点。'],
    ['completed', 'pending', '只有已完成或失败的节点可以重跑。'],
    ['completed', 'ready', '只有已完成或失败的节点可以重跑。'],
    ['completed', 'skipped', '只有已完成或失败的节点可以重跑。'],
  ] as const)('disables rerun for run %s and node %s', async (runStatus, nodeStatus, reason) => {
    installApi((url) => {
      if (new URL(url, 'http://localhost').pathname === '/api/agentops/runs') {
        return jsonResponse(runPage(runStatus))
      }
      return jsonResponse(activity({
        status: runStatus,
        lanes: [lane('default', '默认泳道', ['scan'])],
        nodes: [node('scan', { displayName: '扫描票据', status: nodeStatus })],
      }))
    })

    renderPanel()
    expect(await screen.findByText('扫描票据')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: t('graph.nodeAria', { id: 'scan' }) }))

    expect(isDisabled(screen.getByRole('button', { name: '重跑节点' }))).toBe(true)
    expect(screen.getByText(reason)).toBeTruthy()
  })

  it.each([
    ['completed', 'completed'],
    ['completed', 'failed'],
    ['cancelled', 'completed'],
    ['cancelled', 'failed'],
  ] as const)('allows rerun for run %s and node %s', async (runStatus, nodeStatus) => {
    installApi((url) => {
      if (new URL(url, 'http://localhost').pathname === '/api/agentops/runs') {
        return jsonResponse(runPage(runStatus))
      }
      return jsonResponse(activity({
        status: runStatus,
        lanes: [lane('default', '默认泳道', ['scan'])],
        nodes: [node('scan', { displayName: '扫描票据', status: nodeStatus })],
      }))
    })

    renderPanel()
    expect(await screen.findByText('扫描票据')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: t('graph.nodeAria', { id: 'scan' }) }))
    expect(isDisabled(screen.getByRole('button', { name: '重跑节点' }))).toBe(false)
  })

  it.each([
    ['invalid_request', 400, '重跑请求无效，请检查后重试。'],
    ['unknown_run', 404, '找不到要重跑的运行，它可能已被删除。'],
    ['node_missing', 404, '运行中已找不到这个节点。'],
    ['workflow_mismatch', 409, '当前工作流与运行记录不匹配，无法重跑。'],
    ['run_running', 409, '运行进行中时不能重跑节点。'],
    ['workflow_invalid', 422, '当前工作流定义未通过校验。'],
    ['invalid_inputs', 422, '运行输入无效，无法重跑。'],
    ['session_unavailable', 503, '会话服务暂不可用，请稍后重试。'],
    ['internal_error', 500, '服务端无法创建重跑会话，请稍后重试。'],
  ] as const satisfies readonly (readonly [RerunErrorCode, number, string])[])(
    'maps the %s rerun failure to localized copy',
    async (code, status, expected) => {
      installApi((url) => {
        const path = new URL(url, 'http://localhost').pathname
        if (path === '/api/agentops/runs') return jsonResponse(runPage('completed'))
        if (path === '/api/agentops/workflow-rerun') {
          return jsonResponse({
            error: {
              code,
              message: 'untrusted server detail',
              issues: ['untrusted issue'],
            },
          }, status)
        }
        return jsonResponse(activity({
          status: 'completed',
          lanes: [lane('default', '默认泳道', ['scan'])],
          nodes: [node('scan', { displayName: '扫描票据', status: 'completed' })],
        }))
      })

      renderPanel()
      expect(await screen.findByText('扫描票据')).toBeTruthy()
      fireEvent.click(screen.getByRole('button', { name: t('graph.nodeAria', { id: 'scan' }) }))
      fireEvent.click(screen.getByRole('button', { name: '重跑节点' }))
      fireEvent.click(screen.getByRole('button', { name: '确认重跑' }))

      expect(await screen.findByText(expected)).toBeTruthy()
      expect(screen.queryByText('untrusted server detail')).toBeNull()
      expect(screen.queryByText('untrusted issue')).toBeNull()
    },
  )

  it('defaults to the current node and cancels without posting', async () => {
    const calls = installApi((url) => {
      if (new URL(url, 'http://localhost').pathname === '/api/agentops/runs') {
        return jsonResponse(runPage('completed'))
      }
      return jsonResponse(activity({
        status: 'completed',
        lanes: [lane('default', '默认泳道', ['scan', 'report'])],
        nodes: [
          node('scan', { displayName: '扫描票据', status: 'completed' }),
          node('report', { displayName: '生成报告', status: 'completed' }),
        ],
      }))
    })

    renderPanel()
    expect(await screen.findByText('扫描票据')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: t('graph.nodeAria', { id: 'scan' }) }))
    fireEvent.click(screen.getByRole('button', { name: '重跑节点' }))

    const onlyNode = screen.getByRole('radio', { name: '仅当前节点' })
    const downstream = screen.getByRole('radio', { name: '当前节点及全部下游' })
    expect(isChecked(onlyNode)).toBe(true)
    expect(isChecked(downstream)).toBe(false)
    fireEvent.click(downstream)
    expect(isChecked(downstream)).toBe(true)
    expect(isChecked(onlyNode)).toBe(false)

    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(screen.queryByRole('dialog', { name: '确认重跑' })).toBeNull()
    expect(calls.some(call => pathOf(call) === '/api/agentops/workflow-rerun')).toBe(false)
  })

  it('posts the exact rerun request, closes first, publishes queued notice, then refreshes', async () => {
    const order: string[] = []
    let activityRequest = 0
    let rerunBody: unknown
    const calls = installApi((url, init) => {
      const path = new URL(url, 'http://localhost').pathname
      if (path === '/api/agentops/runs') return jsonResponse(runPage('completed'))
      if (path === '/api/agentops/workflow-rerun') {
        order.push('rerun')
        rerunBody = JSON.parse(String(init?.body))
        return jsonResponse({
          ok: true,
          sessionId: 'session-rerun-1',
          runId: 'run-1',
          workflowId: 'log-patrol',
          nodeId: 'scan',
          onlyNode: true,
        })
      }
      activityRequest += 1
      order.push(`activity-${activityRequest}`)
      return jsonResponse(activity({
        status: 'completed',
        lanes: [lane('default', '默认泳道', ['scan'])],
        nodes: [node('scan', { displayName: '扫描票据', status: 'completed' })],
      }))
    })
    const publish = vi.fn<(text: string) => void>((text) => {
      expect(screen.queryByRole('dialog', { name: '确认重跑' })).toBeNull()
      order.push(`notice:${text}`)
    })

    renderPanel(3_000, publish)
    expect(await screen.findByText('扫描票据')).toBeTruthy()
    order.length = 0
    fireEvent.click(screen.getByRole('button', { name: t('graph.nodeAria', { id: 'scan' }) }))
    fireEvent.click(screen.getByRole('button', { name: '重跑节点' }))
    fireEvent.click(screen.getByRole('button', { name: '确认重跑' }))

    await waitFor(() => { expect(publish).toHaveBeenCalledTimes(1) })
    expect(publish).toHaveBeenCalledWith('重跑会话已创建，指令已入队；这不表示节点已经执行完成。')
    expect(rerunBody).toEqual({
      runId: 'run-1',
      workflowId: 'log-patrol',
      nodeId: 'scan',
      onlyNode: true,
      inputs: {
        topic: 'migration',
        retries: 0,
        nested: { tags: ['ops', null] },
      },
    })
    expect(calls.some(call => pathOf(call) === '/api/agentops/workflow-rerun')).toBe(true)
    await waitFor(() => { expect(activityCalls(calls)).toHaveLength(2) })
    expect(order).toEqual([
      'rerun',
      'notice:重跑会话已创建，指令已入队；这不表示节点已经执行完成。',
      'activity-2',
    ])
    expect(screen.getByRole('complementary', { name: t('inspector.title') })).toBeTruthy()
    expect(screen.getByRole('button', { name: t('graph.nodeAria', { id: 'scan' }) })).toBeTruthy()
  })

  it('posts only once when confirm is pressed repeatedly during a pending request', async () => {
    const pending = Promise.withResolvers<Response>()
    let rerunPosts = 0
    installApi((url) => {
      const path = new URL(url, 'http://localhost').pathname
      if (path === '/api/agentops/runs') return jsonResponse(runPage('completed'))
      if (path === '/api/agentops/workflow-rerun') {
        rerunPosts += 1
        return pending.promise
      }
      return jsonResponse(activity({
        status: 'completed',
        lanes: [lane('default', '默认泳道', ['scan'])],
        nodes: [node('scan', { displayName: '扫描票据', status: 'completed' })],
      }))
    })

    renderPanel()
    expect(await screen.findByText('扫描票据')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: t('graph.nodeAria', { id: 'scan' }) }))
    fireEvent.click(screen.getByRole('button', { name: '重跑节点' }))
    const confirm = screen.getByRole('button', { name: '确认重跑' })
    fireEvent.click(confirm)
    fireEvent.click(confirm)
    expect(rerunPosts).toBe(1)

    pending.resolve(jsonResponse({
      ok: true,
      sessionId: 'session-rerun-1',
      runId: 'run-1',
      workflowId: 'log-patrol',
      nodeId: 'scan',
      onlyNode: true,
    }))
    await waitFor(() => { expect(screen.queryByRole('dialog', { name: '确认重跑' })).toBeNull() })
  })

  it('locks every close action while the rerun request is pending', async () => {
    const pending = Promise.withResolvers<Response>()
    installApi((url) => {
      const path = new URL(url, 'http://localhost').pathname
      if (path === '/api/agentops/runs') return jsonResponse(runPage('completed'))
      if (path === '/api/agentops/workflow-rerun') return pending.promise
      return jsonResponse(activity({
        status: 'completed',
        lanes: [lane('default', '默认泳道', ['scan'])],
        nodes: [node('scan', { displayName: '扫描票据', status: 'completed' })],
      }))
    })

    renderPanel()
    expect(await screen.findByText('扫描票据')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: t('graph.nodeAria', { id: 'scan' }) }))
    fireEvent.click(screen.getByRole('button', { name: '重跑节点' }))
    fireEvent.click(screen.getByRole('button', { name: '确认重跑' }))

    fireEvent.click(screen.getByRole('button', { name: t('common.close') }))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.getByRole('dialog', { name: '确认重跑' })).toBeTruthy()

    pending.resolve(jsonResponse({
      ok: true,
      sessionId: 'session-rerun-1',
      runId: 'run-1',
      workflowId: 'log-patrol',
      nodeId: 'scan',
      onlyNode: true,
    }))
    await waitFor(() => { expect(screen.queryByRole('dialog', { name: '确认重跑' })).toBeNull() })
  })

  it('focuses cancel when the rerun confirmation opens', async () => {
    installApi((url) => {
      if (new URL(url, 'http://localhost').pathname === '/api/agentops/runs') {
        return jsonResponse(runPage('completed'))
      }
      return jsonResponse(activity({
        status: 'completed',
        lanes: [lane('default', '默认泳道', ['scan'])],
        nodes: [node('scan', { displayName: '扫描票据', status: 'completed' })],
      }))
    })

    renderPanel()
    expect(await screen.findByText('扫描票据')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: t('graph.nodeAria', { id: 'scan' }) }))
    fireEvent.click(screen.getByRole('button', { name: '重跑节点' }))

    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByRole('button', { name: '取消' }))
    })
  })

  it('keeps the inspector and dialog while showing only a localized rerun failure', async () => {
    installApi((url) => {
      const path = new URL(url, 'http://localhost').pathname
      if (path === '/api/agentops/runs') return jsonResponse(runPage('completed'))
      if (path === '/api/agentops/workflow-rerun') {
        return jsonResponse({
          error: {
            code: 'session_unavailable',
            message: 'C:\\Users\\secret\\session.ts failed',
            issues: ['queue unavailable'],
          },
        }, 503)
      }
      return jsonResponse(activity({
        status: 'completed',
        lanes: [lane('default', '默认泳道', ['scan'])],
        nodes: [node('scan', { displayName: '扫描票据', status: 'completed' })],
      }))
    })

    renderPanel()
    expect(await screen.findByText('扫描票据')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: t('graph.nodeAria', { id: 'scan' }) }))
    fireEvent.click(screen.getByRole('button', { name: '重跑节点' }))
    fireEvent.click(screen.getByRole('button', { name: '确认重跑' }))

    expect(await screen.findByText('无法创建重跑会话')).toBeTruthy()
    expect(screen.getByText('会话服务暂不可用，请稍后重试。')).toBeTruthy()
    expect(screen.getByRole('complementary', { name: t('inspector.title') })).toBeTruthy()
    expect(screen.getByRole('dialog', { name: '确认重跑' })).toBeTruthy()
    expect(screen.queryByText(/C:\\Users\\secret/)).toBeNull()
    expect(screen.queryByText('queue unavailable')).toBeNull()
  })

  it('opens the dependency graph first and keeps one inspector across both views', async () => {
    installApi((url) => {
      if (new URL(url, 'http://localhost').pathname === '/api/agentops/runs') {
        return jsonResponse(runPage('completed'))
      }
      return jsonResponse(activity({
        status: 'completed',
        lanes: [lane('default', '默认泳道', ['scan'])],
        nodes: [node('scan', { displayName: '扫描票据', status: 'completed' })],
      }))
    })

    renderPanel()
    expect(await screen.findByText('扫描票据')).toBeTruthy()
    expect(screen.getByRole('button', { name: t('view.graph') }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: t('view.lanes') }).getAttribute('aria-pressed')).toBe('false')

    fireEvent.click(screen.getByRole('button', { name: t('view.lanes') }))
    expect(screen.getByRole('button', { name: t('view.lanes') }).getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: t('view.graph') }))

    fireEvent.click(screen.getByRole('button', { name: t('graph.nodeAria', { id: 'scan' }) }))
    fireEvent.click(screen.getByRole('button', { name: '重跑节点' }))
    expect(screen.getByRole('dialog', { name: '确认重跑' })).toBeTruthy()
  })
})

function groupLevel(group: SVGGElement | undefined): string | undefined {
  return [...(group?.querySelectorAll('text') ?? [])].at(-1)?.textContent ?? undefined
}

describe('collaboration responsive styles', () => {
  it('keeps horizontal scrolling inside content and respects touch and hover rules', () => {
    const pageRule = collaborationCss.match(/\.collab-page\s*\{([^}]*)\}/)?.[1] ?? ''
    const graphRule = collaborationCss.match(/\.collab-graph-scroll\s*\{([^}]*)\}/)?.[1] ?? ''
    const actorsScrollRule = collaborationCss.match(/\.collab-actors-scroll\s*\{([^}]*)\}/)?.[1] ?? ''
    const compactStart = collaborationCss.indexOf('@media (max-width: 760px)')
    const compactEnd = collaborationCss.indexOf('@media (max-width: 640px)', compactStart)
    const compactRules = collaborationCss.slice(compactStart, compactEnd)
    const pickerRule = compactRules.match(/\.collab-run-picker-control\s*\{([^}]*)\}/)?.[1] ?? ''
    expect(pageRule).toMatch(/min-width:\s*0/)
    expect(pageRule).not.toMatch(/overflow-x:\s*(auto|scroll)/)
    expect(graphRule).toMatch(/overflow-x:\s*auto/)
    expect(actorsScrollRule).toMatch(/overflow-x:\s*auto/)
    expect(compactRules).toMatch(/\.collab-actors-view[\s\S]*grid-template-columns:\s*minmax\(0,\s*1fr\)/)
    expect(pickerRule).toMatch(/flex:\s*0 0 auto/)
    expect(collaborationCss).toMatch(/@media \(pointer: coarse\)[\s\S]*\.collab-actors-table th,[\s\S]*font-size:\s*16px/)
    expect(collaborationCss).toMatch(/@media \(hover: hover\)[\s\S]*\.collab-actors-table[\s\S]*:hover/)
    expect(collaborationCss).not.toMatch(/font-weight:\s*(600|700|800|900)/)
  })

  it('keeps rerun inputs and footer actions inside the dialog at 390px', () => {
    const contentRule = collaborationCss.match(/\.collab-rerun-content\s*\{([^}]*)\}/)?.[1] ?? ''
    const inputsRule = collaborationCss.match(/\.collab-rerun-inputs\s*\{([^}]*)\}/)?.[1] ?? ''
    const mobileRules = collaborationCss.match(/@media \(max-width: 390px\)\s*\{([\s\S]*?)\n\}/)?.[1] ?? ''
    expect(contentRule).toMatch(/min-width:\s*0/)
    expect(inputsRule).toMatch(/overflow-wrap:\s*anywhere/)
    expect(mobileRules).toMatch(/\.collab-rerun-dialog[\s\S]*max-width:\s*100%/)
    expect(mobileRules).toMatch(/\.collab-rerun-footer[\s\S]*flex-wrap:\s*wrap/)
  })

  it('keeps long run facts inside the toolbar at 390px', () => {
    const metaRule = collaborationCss.match(/\.collab-run-meta\s*\{\s*justify-content:([^}]*)\}/)?.[1] ?? ''
    const factsRule = collaborationCss.match(/\.collab-run-facts\s*\{([^}]*)\}/)?.[1] ?? ''
    const factValueRule = collaborationCss.match(/\.collab-run-fact code,[\s\S]*?\.collab-run-fact time\s*\{([^}]*)\}/)?.[1] ?? ''
    const mobileRules = collaborationCss.match(/@media \(max-width: 390px\)\s*\{([\s\S]*?)\n\}/)?.[1] ?? ''
    expect(metaRule).toMatch(/max-width:\s*100%/)
    expect(factsRule).toMatch(/flex-wrap:\s*wrap/)
    expect(factsRule).toMatch(/min-width:\s*0/)
    expect(factValueRule).toMatch(/min-width:\s*0/)
    expect(factValueRule).toMatch(/overflow-wrap:\s*anywhere/)
    expect(mobileRules).toMatch(/\.collab-run-facts,[\s\S]*\.collab-run-actions[\s\S]*max-width:\s*100%/)
    expect(mobileRules).toMatch(/\.collab-run-actions[\s\S]*width:\s*100%/)
  })

  it('keeps the run picker inside the viewport at 390px', () => {
    const layoutRule = collaborationCss.match(/\.collab-layout\s*\{([^}]*)\}/)?.[1] ?? ''
    const triggerRule = collaborationCss.match(/\.collab-run-trigger\s*\{([^}]*)\}/)?.[1] ?? ''
    const menuRule = collaborationCss.match(/\.collab-run-menu\s*\{([^}]*)\}/)?.[1] ?? ''
    const mobileRules = collaborationCss.match(/@media \(max-width: 390px\)\s*\{([\s\S]*?)\n\}/)?.[1] ?? ''
    expect(layoutRule).toMatch(/grid-template-columns:\s*minmax\(0,\s*1fr\)/)
    expect(triggerRule).toMatch(/width:\s*100%/)
    expect(triggerRule).toMatch(/min-width:\s*0/)
    expect(triggerRule).toMatch(/max-width:\s*100%/)
    expect(menuRule).toMatch(/width:\s*min\(640px,\s*calc\(100vw\s*-\s*24px\)\)/)
    expect(menuRule).toMatch(/max-width:\s*min\(640px,\s*calc\(100vw\s*-\s*24px\)\)/)
    expect(mobileRules).toMatch(/\.collab-run-picker-control,[\s\S]*\.collab-run-trigger[\s\S]*width:\s*100%/)
  })
})
