import { describe, expect, it } from 'vitest'

import {
  RunHistoryRequestError,
  loadRunDetail,
  loadRunHistory,
} from '../src/client/run-history-api.js'

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

describe('run history API', () => {
  it('parses a list with optional summary fields omitted', async () => {
    let requestUrl = ''
    let credentials: RequestCredentials | undefined
    const fetchImpl: typeof fetch = async (input, init) => {
      requestUrl = urlOf(input)
      credentials = init?.credentials
      return jsonResponse({
        runs: [{
          runId: 'run-1',
          workflowId: 'log-patrol',
          status: 'running',
          startedAt: '2026-10-25T00:00:00.000Z',
        }],
        total: 1,
      })
    }

    await expect(loadRunHistory({ limit: 50, offset: 0, status: 'failed' }, fetchImpl)).resolves.toEqual({
      runs: [{
        runId: 'run-1',
        workflowId: 'log-patrol',
        status: 'running',
        startedAt: '2026-10-25T00:00:00.000Z',
      }],
      total: 1,
    })
    expect(requestUrl).toBe('/api/agentops/runs?limit=50&offset=0&status=failed')
    expect(credentials).toBe('include')
  })

  it('parses complete run and node details including nested outputs', async () => {
    const detail = {
      runId: 'run-detail',
      workflowId: 'log-patrol',
      status: 'failed',
      startedAt: '2026-10-25T00:00:00.000Z',
      finishedAt: '2026-10-25T00:00:08.000Z',
      error: 'workflow failed',
      nodes: [{
        id: 'scan',
        status: 'failed',
        attempts: 2,
        startedAt: '2026-10-25T00:00:01.000Z',
        finishedAt: '2026-10-25T00:00:07.500Z',
        error: 'model timeout',
        chosenPort: 'retry',
        outputs: {
          records: ['one', 'two'],
          nested: { ok: true, count: 2 },
          empty: null,
        },
      }],
    }
    const fetchImpl: typeof fetch = async () => jsonResponse(detail)

    await expect(loadRunDetail('run-detail', fetchImpl)).resolves.toEqual(detail)
  })

  it('preserves optional detail fields as absent', async () => {
    const fetchImpl: typeof fetch = async () => jsonResponse({
      runId: 'run-running',
      workflowId: 'demo',
      status: 'running',
      startedAt: '2026-10-25T00:00:00.000Z',
      nodes: [{ id: 'scan', status: 'ready', attempts: 0 }],
    })

    await expect(loadRunDetail('run-running', fetchImpl)).resolves.toEqual({
      runId: 'run-running',
      workflowId: 'demo',
      status: 'running',
      startedAt: '2026-10-25T00:00:00.000Z',
      nodes: [{ id: 'scan', status: 'ready', attempts: 0 }],
    })
  })

  it('rejects missing required list and detail fields', async () => {
    const malformedList: typeof fetch = async () => jsonResponse({
      runs: [{ runId: 'run-1', workflowId: 'demo', status: 'completed' }],
      total: 1,
    })
    await expect(loadRunHistory({}, malformedList)).rejects.toThrow(/invalid run history response/i)

    const malformedDetail: typeof fetch = async () => jsonResponse({
      runId: 'run-1',
      workflowId: 'demo',
      status: 'completed',
      startedAt: '2026-10-25T00:00:00.000Z',
      nodes: [{ id: 'scan', status: 'completed' }],
    })
    await expect(loadRunDetail('run-1', malformedDetail)).rejects.toThrow(/invalid run detail response/i)
  })

  it('rejects unknown run and node statuses', async () => {
    const runStatus: typeof fetch = async () => jsonResponse({
      runs: [{
        runId: 'run-1',
        workflowId: 'demo',
        status: 'unknown',
        startedAt: '2026-10-25T00:00:00.000Z',
      }],
      total: 1,
    })
    await expect(loadRunHistory({}, runStatus)).rejects.toThrow(/invalid run history response/i)

    const nodeStatus: typeof fetch = async () => jsonResponse({
      runId: 'run-1',
      workflowId: 'demo',
      status: 'completed',
      startedAt: '2026-10-25T00:00:00.000Z',
      nodes: [{ id: 'scan', status: 'unknown', attempts: 0 }],
    })
    await expect(loadRunDetail('run-1', nodeStatus)).rejects.toThrow(/invalid run detail response/i)
  })

  it('rejects malformed totals, attempts, and output values', async () => {
    const malformedPages: readonly unknown[] = [
      { runs: [], total: -1 },
      { runs: [], total: 1.5 },
      { runs: [], total: Number.MAX_SAFE_INTEGER + 1 },
      { runs: {}, total: 0 },
    ]
    for (const body of malformedPages) {
      const fetchImpl: typeof fetch = async () => jsonResponse(body)
      await expect(loadRunHistory({}, fetchImpl)).rejects.toThrow(/invalid run history response/i)
    }

    const malformedAttempts: typeof fetch = async () => jsonResponse({
      runId: 'run-1',
      workflowId: 'demo',
      status: 'completed',
      startedAt: '2026-10-25T00:00:00.000Z',
      nodes: [{ id: 'scan', status: 'completed', attempts: -1 }],
    })
    await expect(loadRunDetail('run-1', malformedAttempts)).rejects.toThrow(/invalid run detail response/i)

    const outputCases = [
      '{"runId":"run-1","workflowId":"demo","status":"completed","startedAt":"2026-10-25T00:00:00.000Z","nodes":[{"id":"scan","status":"completed","attempts":0,"outputs":[]}]}',
      '{"runId":"run-1","workflowId":"demo","status":"completed","startedAt":"2026-10-25T00:00:00.000Z","nodes":[{"id":"scan","status":"completed","attempts":0,"outputs":{"value":1e999}}]}',
    ]
    for (const text of outputCases) {
      const fetchImpl: typeof fetch = async () => rawResponse(text)
      await expect(loadRunDetail('run-1', fetchImpl)).rejects.toThrow(/invalid run detail response/i)
    }
  })

  it('retains HTTP status on request errors', async () => {
    const fetchImpl: typeof fetch = async () => rawResponse('not found', 404)

    try {
      await loadRunDetail('missing', fetchImpl)
      throw new Error('expected request to fail')
    } catch (reason) {
      expect(reason).toBeInstanceOf(RunHistoryRequestError)
      if (reason instanceof RunHistoryRequestError) expect(reason.status).toBe(404)
    }
  })

  it('retains the JSON parser error as the cause', async () => {
    const fetchImpl: typeof fetch = async () => rawResponse('not json', 200)

    try {
      await loadRunHistory({}, fetchImpl)
      throw new Error('expected parsing to fail')
    } catch (reason) {
      expect(reason).toBeInstanceOf(Error)
      if (reason instanceof Error) expect(reason.cause).toBeInstanceOf(SyntaxError)
    }
  })

  it('encodes run identities and workflow filters', async () => {
    const urls: string[] = []
    const fetchImpl: typeof fetch = async (input) => {
      urls.push(urlOf(input))
      return jsonResponse(urlOf(input).includes('/runs?')
        ? { runs: [], total: 0 }
        : {
          runId: 'run/with space?',
          workflowId: 'logs & billing',
          status: 'completed',
          startedAt: '2026-10-25T00:00:00.000Z',
          nodes: [],
        })
    }

    await loadRunHistory({ limit: 50, workflowId: 'logs & billing' }, fetchImpl)
    await loadRunDetail('run/with space?', fetchImpl)

    expect(urls).toEqual([
      '/api/agentops/runs?limit=50&workflowId=logs+%26+billing',
      '/api/agentops/run?id=run%2Fwith%20space%3F',
    ])
  })
})
