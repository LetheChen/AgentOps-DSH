// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'

import { MonitorPanel } from '../src/client/monitor-panel.js'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function requestUrl(input: RequestInfo | URL): URL {
  return new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, 'http://localhost')
}

const monitorPayload = {
  generatedAt: '2026-11-14T10:00:00.000Z',
  range: { days: 30, since: '2026-10-16T00:00:00.000Z' },
  summary: {
    totalTokens: 1_200,
    promptTokens: 900,
    completionTokens: 300,
    calls: 3,
    daily: [
      { date: '2026-11-13', provider: 'deepseek-account', tokens: 600, calls: 2 },
      { date: '2026-11-14', provider: 'deepseek-account', tokens: 600, calls: 1 },
    ],
    byProvider: [{ provider: 'deepseek-account', tokens: 1_200, calls: 3 }],
    byModel: [{ model: 'deepseek-flash', tokens: 1_200, calls: 3 }],
    byPurpose: [{ purpose: 'log_puller', tokens: 1_200, calls: 3 }],
  },
  heatmap: {
    weeks: 26,
    days: 182,
    since: '2026-05-17T00:00:00.000Z',
    daily: [{ date: '2026-11-13', tokens: 1_200, calls: 3 }],
  },
  capabilities: { cost: false, agentRuntime: false, tips: true },
}

const agentsPayload = {
  dir: 'C:/agents',
  missing: false,
  entries: [
    {
      id: 'log_analyst',
      name: '日志分析师',
      domain: 'smart_ops',
      harness: 'local_llm',
      execution_backend: 'dsh_native',
      execution: 'skill',
      workflow: '',
      model: 'minimax/MiniMax-M3',
      source: 'yaml',
    },
    {
      id: 'manager',
      name: 'Manager Agent',
      domain: 'manager',
      harness: 'local_llm',
      execution_backend: 'auto',
      execution: 'skill',
      workflow: '',
      model: 'minimax/MiniMax-M3',
      source: 'yaml',
    },
  ],
}

describe('monitoring center', () => {
  it('uses the real execution backend and loads workflow activity from the task RPC', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input)
      if (url.pathname === '/api/agentops/monitor') return jsonResponse(monitorPayload)
      if (url.pathname === '/api/agentops/agents') return jsonResponse(agentsPayload)
      if (url.pathname === '/api/agentops/workflows') {
        return jsonResponse({
          dir: 'C:/workflows',
          missing: false,
          entries: [{
            id: 'log-patrol',
            file: 'log-patrol.yaml',
            name: '日志巡检',
            nodeCount: 1,
            levelCount: 1,
            ok: true,
            errors: [],
            status: 'verified',
            inputs: [],
            nodes: [{ id: 'scan', level: 0, type: 'agent', agentRef: 'log_analyst' }],
            edges: [],
          }],
        })
      }
      if (url.pathname === '/api/agentops/runs') {
        const status = url.searchParams.get('status')
        const totals = { running: 1, completed: 2, failed: 0, cancelled: 0 } as const
        if (status === null) {
          return jsonResponse({
            total: 3,
            runs: [{
              runId: 'run-log-patrol',
              workflowId: 'log-patrol',
              status: 'completed',
              startedAt: '2026-11-14T09:00:00.000Z',
            }],
          })
        }
        return jsonResponse({ total: totals[status as keyof typeof totals], runs: [] })
      }
      if (url.pathname === '/api/agentops/task-rpc') {
        const body = JSON.parse(String(init?.body ?? '{}')) as { endpoint?: string }
        if (body.endpoint === 'agentops/tasks/activities') {
          return jsonResponse({
            ok: true,
            value: {
              activities: [{
                seq: 1,
                taskId: 'task-1',
                kind: 'task_completed',
                actor: 'manager',
                at: '2026-11-14T09:30:00.000Z',
                taskTitle: '智能审核巡检',
              }],
            },
          })
        }
      }
      return jsonResponse({ error: 'not found' }, 404)
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<MonitorPanel />)

    expect(await screen.findByText('智能审核巡检')).toBeTruthy()
    expect(screen.getByText('DSH 原生')).toBeTruthy()
    expect(screen.getByText('DSH 自动')).toBeTruthy()
    expect(screen.queryByText('local_llm')).toBeNull()
    expect(screen.getAllByText('总运行').length).toBeGreaterThanOrEqual(2)
    expect(await screen.findByText('1 个运行中')).toBeTruthy()
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/api/agentops/agents'), expect.anything())
  })
})
