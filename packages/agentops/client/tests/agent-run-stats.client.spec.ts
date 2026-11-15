import { afterEach, describe, expect, it, vi } from 'vitest'

import { loadAgentRunStats } from '../src/client/agent-run-stats.js'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function run(
  runId: string,
  workflowId: string,
  status: 'running' | 'completed' | 'failed' | 'cancelled',
  startedAt: string,
) {
  return { runId, workflowId, status, startedAt }
}

describe('Agent run statistics', () => {
  it('deduplicates workflows and sums exact totals while selecting the latest run', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, 'http://localhost')
      const workflowId = url.searchParams.get('workflowId')
      const status = url.searchParams.get('status')
      if (workflowId === 'flow-a') {
        if (status === null) {
          return jsonResponse({
            total: 5,
            runs: [run('run-a', 'flow-a', 'completed', '2026-11-01T10:00:00.000Z')],
          })
        }
        const totals = { running: 2, completed: 2, failed: 1, cancelled: 0 } as const
        return jsonResponse({ total: totals[status as keyof typeof totals], runs: [] })
      }
      if (workflowId === 'flow-b') {
        if (status === null) {
          return jsonResponse({
            total: 3,
            runs: [run('run-b', 'flow-b', 'failed', '2026-11-02T10:00:00.000Z')],
          })
        }
        const totals = { running: 0, completed: 2, failed: 0, cancelled: 1 } as const
        return jsonResponse({ total: totals[status as keyof typeof totals], runs: [] })
      }
      throw new Error(`unexpected request ${input instanceof Request ? input.url : String(input)}`)
    })

    const stats = await loadAgentRunStats(['flow-a', 'flow-b', 'flow-a'], fetchMock)

    expect(stats).toEqual({
      workflowCount: 2,
      total: 8,
      running: 2,
      completed: 4,
      failed: 1,
      cancelled: 1,
      latest: run('run-b', 'flow-b', 'failed', '2026-11-02T10:00:00.000Z'),
    })
    expect(fetchMock).toHaveBeenCalledTimes(10)
    expect(new Set(fetchMock.mock.calls.map(([input]) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, 'http://localhost')
      return `${url.searchParams.get('workflowId')}:${url.searchParams.get('status') ?? 'all'}`
    }))).toEqual(new Set([
      'flow-a:all',
      'flow-a:running',
      'flow-a:completed',
      'flow-a:failed',
      'flow-a:cancelled',
      'flow-b:all',
      'flow-b:running',
      'flow-b:completed',
      'flow-b:failed',
      'flow-b:cancelled',
    ]))
  })

  it('does not request run history when no workflow is bound', async () => {
    const fetchMock = vi.fn<typeof fetch>()

    await expect(loadAgentRunStats([], fetchMock)).resolves.toEqual({
      workflowCount: 0,
      total: 0,
      running: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects the aggregate when a run-history request fails', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ message: 'unavailable' }, 503))

    await expect(loadAgentRunStats(['flow-a'], fetchMock)).rejects.toMatchObject({ status: 503 })
  })

  it('rejects malformed run-history responses', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ runs: [], total: '5' }))

    await expect(loadAgentRunStats(['flow-a'], fetchMock)).rejects.toThrow(
      'invalid run history response',
    )
  })
})
