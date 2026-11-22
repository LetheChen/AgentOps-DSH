import { describe, expect, it } from 'vitest'

import {
  CollaborationRequestError,
  CollaborationResponseError,
  loadRunActivity,
  requestNodeRerun,
  RerunRequestError,
  RerunResponseError,
} from '../src/client/collaboration-api.js'

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

function errorFetch(code: string, status: number): typeof fetch {
  return async () => jsonResponse({ error: { code, message: 'rejected' } }, status)
}

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.href
  return input.url
}

function activity(): Record<string, unknown> {
  return {
    runId: 'run-1',
    workflowId: 'log-patrol',
    status: 'failed',
    startedAt: '2026-10-30T00:00:00.000Z',
    finishedAt: '2026-10-30T00:00:12.000Z',
    inputs: {
      topic: 'migration',
      retries: 0,
      dryRun: false,
      nested: { tags: ['ops', null] },
    },
    lanes: [
      { id: 'ops', label: 'Operations', nodeIds: ['scan', 'notify'] },
      { id: 'analyst', label: 'Analyst', nodeIds: ['analyze'] },
    ],
    nodes: [
      {
        id: 'scan',
        displayName: 'Scan logs',
        type: 'agent',
        laneId: 'ops',
        status: 'completed',
        attempts: 1,
        agentRef: 'log-puller',
        businessRole: 'ops',
        harness: 'deepseek',
        model: 'deepseek-chat',
        startedAt: '2026-10-30T00:00:01.000Z',
        finishedAt: '2026-10-30T00:00:04.000Z',
        durationMs: 3000,
        chosenPort: 'records',
        outputs: {
          records: [{ id: 'r1', severity: 'error' }],
          count: 1,
          ok: true,
          empty: null,
        },
      },
      {
        id: 'analyze',
        displayName: 'Analyze',
        type: 'command',
        laneId: 'analyst',
        status: 'failed',
        attempts: 2,
        startedAt: '2026-10-30T00:00:05.000Z',
        finishedAt: '2026-10-30T00:00:08.000Z',
        durationMs: 3000,
        error: 'model timeout',
      },
      {
        id: 'notify',
        displayName: 'Notify',
        type: 'gateway',
        laneId: 'ops',
        status: 'skipped',
        attempts: 0,
      },
    ],
    scheduleEdges: [
      { from: 'scan', to: 'analyze' },
      { from: 'analyze', to: 'notify' },
    ],
    dataEdges: [{ from: 'scan', to: 'analyze', port: 'records' }],
    timeline: [
      { id: 'run-started', type: 'run.started', occurredAt: '2026-10-30T00:00:00.000Z' },
      {
        id: 'scan-started',
        type: 'node.started',
        occurredAt: '2026-10-30T00:00:01.000Z',
        nodeId: 'scan',
      },
      {
        id: 'analyze-failed',
        type: 'node.failed',
        occurredAt: '2026-10-30T00:00:08.000Z',
        nodeId: 'analyze',
        error: 'model timeout',
      },
      { id: 'run-failed', type: 'run.failed', occurredAt: '2026-10-30T00:00:12.000Z' },
    ],
    handoffs: [{
      id: 'handoff-1',
      fromNodeId: 'scan',
      fromRole: 'ops',
      toNodeId: 'analyze',
      toRole: 'analyst',
      port: 'records',
      payloadSize: 42,
      summary: 'one error record',
      occurredAt: '2026-10-30T00:00:04.500Z',
    }],
  }
}

describe('collaboration activity API', () => {
  it('loads the selected run with credentials, signal, and an encoded id', async () => {
    let requestUrl = ''
    let credentials: RequestCredentials | undefined
    let signal: AbortSignal | null | undefined
    const controller = new AbortController()
    const fetchImpl: typeof fetch = async (input, init) => {
      requestUrl = urlOf(input)
      credentials = init?.credentials
      signal = init?.signal
      return jsonResponse(activity())
    }

    const result = await loadRunActivity('run/with spaces', {
      fetchImpl,
      signal: controller.signal,
    })

    expect(result.runId).toBe('run-1')
    expect(requestUrl).toBe('/api/agentops/run-activity?id=run%2Fwith%20spaces')
    expect(credentials).toBe('include')
    expect(signal).toBe(controller.signal)
  })

  it('parses every activity field and preserves recursive output JSON', async () => {
    const fetchImpl: typeof fetch = async () => jsonResponse(activity())

    const result = await loadRunActivity('run-1', { fetchImpl })

    expect(result.status).toBe('failed')
    expect(result.inputs).toEqual({
      topic: 'migration',
      retries: 0,
      dryRun: false,
      nested: { tags: ['ops', null] },
    })
    expect(result.nodes.map(node => node.status)).toEqual(['completed', 'failed', 'skipped'])
    expect(result.nodes.map(node => node.type)).toEqual(['agent', 'command', 'gateway'])
    expect(result.nodes[0]?.outputs).toEqual({
      records: [{ id: 'r1', severity: 'error' }],
      count: 1,
      ok: true,
      empty: null,
    })
    expect(result.scheduleEdges).toEqual([
      { from: 'scan', to: 'analyze' },
      { from: 'analyze', to: 'notify' },
    ])
    expect(result.dataEdges).toEqual([{ from: 'scan', to: 'analyze', port: 'records' }])
    expect(result.timeline.map(entry => entry.type)).toEqual([
      'run.started',
      'node.started',
      'node.failed',
      'run.failed',
    ])
    expect(result.handoffs[0]).toMatchObject({
      fromNodeId: 'scan',
      toNodeId: 'analyze',
      payloadSize: 42,
    })
  })

  it('omits absent optional fields instead of materializing undefined', async () => {
    const value = activity()
    const nodes = value.nodes as Record<string, unknown>[]
    delete nodes[2]?.agentRef
    const fetchImpl: typeof fetch = async () => jsonResponse(value)

    const result = await loadRunActivity('run-1', { fetchImpl })

    expect('finishedAt' in (result.nodes[2] ?? {})).toBe(false)
    expect('error' in (result.nodes[2] ?? {})).toBe(false)
  })

  it.each([
    ['run status', (value: Record<string, unknown>) => { value.status = 'unknown' }],
    ['node status', (value: Record<string, unknown>) => { (value.nodes as Record<string, unknown>[])[0]!.status = 'unknown' }],
    ['node type', (value: Record<string, unknown>) => { (value.nodes as Record<string, unknown>[])[0]!.type = 'unknown' }],
    ['timeline type', (value: Record<string, unknown>) => { (value.timeline as Record<string, unknown>[])[0]!.type = 'unknown' }],
    ['invalid timestamp', (value: Record<string, unknown>) => { value.startedAt = 'yesterday' }],
    ['negative duration', (value: Record<string, unknown>) => { (value.nodes as Record<string, unknown>[])[0]!.durationMs = -1 }],
    ['fractional attempts', (value: Record<string, unknown>) => { (value.nodes as Record<string, unknown>[])[0]!.attempts = 1.5 }],
    ['unsafe attempts', (value: Record<string, unknown>) => { (value.nodes as Record<string, unknown>[])[0]!.attempts = Number.MAX_SAFE_INTEGER + 1 }],
    ['missing inputs', (value: Record<string, unknown>) => { delete value.inputs }],
    ['array inputs', (value: Record<string, unknown>) => { value.inputs = [] }],
  ])('rejects malformed %s', async (_name, mutate) => {
    const value = activity()
    mutate(value)
    const fetchImpl: typeof fetch = async () => jsonResponse(value)

    await expect(loadRunActivity('run-1', { fetchImpl })).rejects.toThrow(
      /invalid run activity response/i,
    )
  })

  it('rejects a non-finite numeric output token', async () => {
    const body = JSON.stringify(activity()).replace('"count":1', '"count":1e999')
    await expect(loadRunActivity('run-1', {
      fetchImpl: async () => rawResponse(body),
    })).rejects.toThrow(/invalid run activity response/i)
  })

  it('rejects a non-finite numeric input token', async () => {
    const body = JSON.stringify(activity()).replace('"retries":0', '"retries":1e999')
    await expect(loadRunActivity('run-1', {
      fetchImpl: async () => rawResponse(body),
    })).rejects.toThrow(/invalid run activity response/i)
  })
  it('rejects duplicate ids and dangling references', async () => {
    const duplicates = activity()
    ;(duplicates.lanes as Record<string, unknown>[])[1]!.id = 'ops'
    await expect(loadRunActivity('run-1', {
      fetchImpl: async () => jsonResponse(duplicates),
    })).rejects.toThrow(/invalid run activity response/i)

    const danglingLane = activity()
    ;(danglingLane.nodes as Record<string, unknown>[])[0]!.laneId = 'missing'
    await expect(loadRunActivity('run-1', {
      fetchImpl: async () => jsonResponse(danglingLane),
    })).rejects.toThrow(/invalid run activity response/i)

    const danglingEdge = activity()
    ;(danglingEdge.scheduleEdges as Record<string, unknown>[])[0]!.to = 'missing'
    await expect(loadRunActivity('run-1', {
      fetchImpl: async () => jsonResponse(danglingEdge),
    })).rejects.toThrow(/invalid run activity response/i)

    const danglingTimeline = activity()
    ;(danglingTimeline.timeline as Record<string, unknown>[])[1]!.nodeId = 'missing'
    await expect(loadRunActivity('run-1', {
      fetchImpl: async () => jsonResponse(danglingTimeline),
    })).rejects.toThrow(/invalid run activity response/i)

    const danglingHandoff = activity()
    ;(danglingHandoff.handoffs as Record<string, unknown>[])[0]!.toNodeId = 'missing'
    await expect(loadRunActivity('run-1', {
      fetchImpl: async () => jsonResponse(danglingHandoff),
    })).rejects.toThrow(/invalid run activity response/i)
  })

  it('rejects non-JSON and malformed JSON bodies', async () => {
    await expect(loadRunActivity('run-1', {
      fetchImpl: async () => new Response('not json', { status: 200 }),
    })).rejects.toBeInstanceOf(CollaborationResponseError)

    await expect(loadRunActivity('run-1', {
      fetchImpl: async () => rawResponse('{'),
    })).rejects.toBeInstanceOf(CollaborationResponseError)
  })

  it('parses a documented structured HTTP error without exposing its server details', async () => {
    const fetchImpl: typeof fetch = async () => jsonResponse({
      error: {
        code: 'workflow_mismatch',
        message: 'workflow id does not match run: expected C:\\Users\\secret\\workflow.yml',
        issues: ['keep only non-path details'],
      },
    }, 409)

    const failure = loadRunActivity('run-1', { fetchImpl })
    await expect(failure).rejects.toBeInstanceOf(CollaborationRequestError)
    const error = await failure.catch((reason: unknown) => reason)
    expect(error).toBeInstanceOf(CollaborationRequestError)
    if (!(error instanceof CollaborationRequestError)) throw new Error('expected request error')
    expect(error.code).toBe('workflow_mismatch')
    expect(error.status).toBe(409)
    expect(error.message).not.toContain('C:\\Users')
  })

  it('rejects an unknown or mismatched HTTP error body', async () => {
    const unknownCode = errorFetch('made_up', 500)
    await expect(loadRunActivity('run-1', { fetchImpl: unknownCode })).rejects.toBeInstanceOf(
      CollaborationResponseError,
    )

    const wrongStatus = errorFetch('unknown_run', 500)
    await expect(loadRunActivity('run-1', { fetchImpl: wrongStatus })).rejects.toBeInstanceOf(
      CollaborationResponseError,
    )
  })

  it('keeps workflow validation issues for localized issue rendering', async () => {
    const fetchImpl: typeof fetch = async () => jsonResponse({
      error: {
        code: 'workflow_invalid',
        message: 'workflow definition is invalid',
        issues: ['nodes.analyze: prompt is required'],
      },
    }, 422)

    const failure = loadRunActivity('run-1', { fetchImpl })
    const error = await failure.catch((reason: unknown) => reason)
    expect(error).toBeInstanceOf(CollaborationRequestError)
    if (!(error instanceof CollaborationRequestError)) throw new Error('expected request error')
    expect(error.issues).toEqual(['nodes.analyze: prompt is required'])
  })

  it('posts a node rerun with credentials, signal, and the exact request body', async () => {
    let requestUrl = ''
    let requestInit: RequestInit | undefined
    const controller = new AbortController()
    const fetchImpl: typeof fetch = async (input, init) => {
      requestUrl = urlOf(input)
      requestInit = init
      return jsonResponse({
        ok: true,
        sessionId: 'session-1',
        runId: 'run-1',
        workflowId: 'log-patrol',
        nodeId: 'analyze',
        onlyNode: false,
      })
    }

    const result = await requestNodeRerun({
      runId: 'run-1',
      workflowId: 'log-patrol',
      nodeId: 'analyze',
      onlyNode: false,
      inputs: { topic: 'migration', retries: 0 },
    }, {
      fetchImpl,
      signal: controller.signal,
    })

    expect(result).toEqual({
      ok: true,
      sessionId: 'session-1',
      runId: 'run-1',
      workflowId: 'log-patrol',
      nodeId: 'analyze',
      onlyNode: false,
    })
    expect(requestUrl).toBe('/api/agentops/workflow-rerun')
    expect(requestInit?.method).toBe('POST')
    expect(requestInit?.credentials).toBe('include')
    expect(requestInit?.signal).toBe(controller.signal)
    expect(new Headers(requestInit?.headers).get('content-type')).toBe('application/json')
    expect(JSON.parse(requestInit?.body as string)).toEqual({
      runId: 'run-1',
      workflowId: 'log-patrol',
      nodeId: 'analyze',
      onlyNode: false,
      inputs: { topic: 'migration', retries: 0 },
    })
  })

  it('retains a documented rerun failure and its optional queued session id', async () => {
    const fetchImpl: typeof fetch = async () => jsonResponse({
      error: {
        code: 'session_unavailable',
        message: 'failed at C:\\Users\\secret\\session.ts',
        issues: ['prompt queue unavailable'],
      },
      sessionId: 'session-created',
    }, 503)

    const failure = requestNodeRerun({
      runId: 'run-1',
      workflowId: 'log-patrol',
      nodeId: 'analyze',
      onlyNode: true,
      inputs: {},
    }, { fetchImpl })
    const error = await failure.catch((reason: unknown) => reason)

    expect(error).toBeInstanceOf(RerunRequestError)
    if (!(error instanceof RerunRequestError)) throw new Error('expected rerun request error')
    expect(error.code).toBe('session_unavailable')
    expect(error.status).toBe(503)
    expect(error.issues).toEqual(['prompt queue unavailable'])
    expect(error.sessionId).toBe('session-created')
    expect(error.message).not.toContain('C:\\Users')
  })

  it('rejects unknown, mismatched, or malformed rerun responses', async () => {
    const request = {
      runId: 'run-1',
      workflowId: 'log-patrol',
      nodeId: 'analyze',
      onlyNode: true,
      inputs: {},
    } as const

    const unknownCode = errorFetch('made_up', 500)
    await expect(requestNodeRerun(request, { fetchImpl: unknownCode })).rejects.toBeInstanceOf(
      RerunResponseError,
    )

    const wrongStatus = errorFetch('run_running', 500)
    await expect(requestNodeRerun(request, { fetchImpl: wrongStatus })).rejects.toBeInstanceOf(
      RerunResponseError,
    )

    const mismatchedEcho: typeof fetch = async () => jsonResponse({
      ok: true,
      sessionId: 'session-1',
      runId: 'run-1',
      workflowId: 'log-patrol',
      nodeId: 'different-node',
      onlyNode: true,
    })
    await expect(requestNodeRerun(request, { fetchImpl: mismatchedEcho })).rejects.toBeInstanceOf(
      RerunResponseError,
    )

    const malformedSuccess: typeof fetch = async () => jsonResponse({
      ok: false,
      sessionId: 'session-1',
      runId: 'run-1',
      workflowId: 'log-patrol',
      nodeId: 'analyze',
      onlyNode: true,
    })
    await expect(requestNodeRerun(request, { fetchImpl: malformedSuccess })).rejects.toBeInstanceOf(
      RerunResponseError,
    )

    await expect(requestNodeRerun(request, {
      fetchImpl: async () => rawResponse('{'),
    })).rejects.toBeInstanceOf(RerunResponseError)
  })
})
