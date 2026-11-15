import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  browserScheduler,
  createCollaborationPoller,
  type CollaborationVisibilitySource,
} from '../src/client/collaboration-polling.js'
import type { RunActivity } from '../src/client/collaboration-api.js'

class FakeVisibility implements CollaborationVisibilitySource {
  hidden = false
  private readonly listeners = new Set<() => void>()

  isHidden(): boolean {
    return this.hidden
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  setHidden(hidden: boolean): void {
    this.hidden = hidden
    for (const listener of this.listeners) listener()
  }

  get listenerCount(): number {
    return this.listeners.size
  }
}

interface Deferred<T> {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
  readonly reject: (reason: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

function activity(runId = 'run-1', status: RunActivity['status'] = 'running'): RunActivity {
  return {
    runId,
    workflowId: 'workflow-1',
    status,
    inputs: {},
    startedAt: '2026-10-30T00:00:00.000Z',
    lanes: [],
    nodes: [],
    scheduleEdges: [],
    dataEdges: [],
    timeline: [],
    handoffs: [],
  }
}

async function settle(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

describe('collaboration polling', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('does not poll a terminal run', () => {
    const request = vi.fn()
    const poller = createCollaborationPoller({
      intervalMs: 3_000,
      fetchActivity: request,
      onActivity: vi.fn(),
      onError: vi.fn(),
      scheduler: browserScheduler,
      visibility: new FakeVisibility(),
    })

    poller.start('run-1', 'completed')

    expect(vi.getTimerCount()).toBe(0)
    expect(request).not.toHaveBeenCalled()
  })

  it('keeps one timer and one request in flight, then schedules only after settlement', async () => {
    const visibility = new FakeVisibility()
    const response = deferred<RunActivity>()
    const request = vi.fn(() => response.promise)
    const onActivity = vi.fn()
    const poller = createCollaborationPoller({
      intervalMs: 3_000,
      fetchActivity: request,
      onActivity,
      onError: vi.fn(),
      scheduler: browserScheduler,
      visibility,
    })

    poller.start('run-1', 'running')
    expect(vi.getTimerCount()).toBe(1)

    await vi.advanceTimersByTimeAsync(3_000)
    expect(request).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)

    await settle()
    expect(vi.getTimerCount()).toBe(0)

    response.resolve(activity())
    await settle()
    expect(onActivity).toHaveBeenCalledWith(activity())
    expect(vi.getTimerCount()).toBe(1)
  })

  it('stops after a poll returns a terminal state', async () => {
    const poller = createCollaborationPoller({
      intervalMs: 3_000,
      fetchActivity: async () => activity('run-1', 'failed'),
      onActivity: vi.fn(),
      onError: vi.fn(),
      scheduler: browserScheduler,
      visibility: new FakeVisibility(),
    })

    poller.start('run-1', 'running')
    await vi.advanceTimersByTimeAsync(3_000)
    await settle()

    expect(vi.getTimerCount()).toBe(0)
  })

  it('aborts an in-flight request and pauses while hidden, then resumes when visible', async () => {
    const visibility = new FakeVisibility()
    const response = deferred<RunActivity>()
    let signal: AbortSignal | undefined
    const poller = createCollaborationPoller({
      intervalMs: 2_500,
      fetchActivity: (requestSignal) => {
        signal = requestSignal
        return response.promise
      },
      onActivity: vi.fn(),
      onError: vi.fn(),
      scheduler: browserScheduler,
      visibility,
    })

    poller.start('run-1', 'running')
    await vi.advanceTimersByTimeAsync(2_500)
    expect(signal?.aborted).toBe(false)

    visibility.setHidden(true)
    expect(signal?.aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)

    visibility.setHidden(false)
    expect(vi.getTimerCount()).toBe(1)
  })

  it('aborts the old request and ignores its late result when the run changes', async () => {
    const oldResponse = deferred<RunActivity>()
    const newResponse = deferred<RunActivity>()
    const signals: AbortSignal[] = []
    const onActivity = vi.fn()
    let requestCount = 0
    const poller = createCollaborationPoller({
      intervalMs: 3_000,
      fetchActivity: (signal) => {
        signals.push(signal)
        requestCount += 1
        return requestCount === 1 ? oldResponse.promise : newResponse.promise
      },
      onActivity,
      onError: vi.fn(),
      scheduler: browserScheduler,
      visibility: new FakeVisibility(),
    })

    poller.start('run-1', 'running')
    await vi.advanceTimersByTimeAsync(3_000)
    poller.start('run-2', 'running')
    expect(signals[0]?.aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(1)

    oldResponse.resolve(activity('run-1'))
    await settle()
    expect(onActivity).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(3_000)
    newResponse.resolve(activity('run-2'))
    await settle()
    expect(onActivity).toHaveBeenCalledTimes(1)
    expect(onActivity.mock.calls[0]?.[0]).toMatchObject({ runId: 'run-2' })
  })

  it('aborts and unsubscribes on idempotent cleanup', async () => {
    const visibility = new FakeVisibility()
    const response = deferred<RunActivity>()
    let signal: AbortSignal | undefined
    const poller = createCollaborationPoller({
      intervalMs: 3_000,
      fetchActivity: (requestSignal) => {
        signal = requestSignal
        return response.promise
      },
      onActivity: vi.fn(),
      onError: vi.fn(),
      scheduler: browserScheduler,
      visibility,
    })

    poller.start('run-1', 'running')
    await vi.advanceTimersByTimeAsync(3_000)
    poller.dispose()
    poller.dispose()

    expect(signal?.aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
    expect(visibility.listenerCount).toBe(0)
    response.resolve(activity())
    await settle()
  })

  it('does not report the expected AbortError from cleanup', async () => {
    const onError = vi.fn()
    const poller = createCollaborationPoller({
      intervalMs: 3_000,
      fetchActivity: async (signal) => {
        await new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'))
          }, { once: true })
        })
        return activity()
      },
      onActivity: vi.fn(),
      onError,
      scheduler: browserScheduler,
      visibility: new FakeVisibility(),
    })

    poller.start('run-1', 'running')
    await vi.advanceTimersByTimeAsync(3_000)
    poller.stop()
    await settle()

    expect(onError).not.toHaveBeenCalled()
  })

  it('reports a failed poll and keeps polling while the run remains active', async () => {
    const visibility = new FakeVisibility()
    const failure = new Error('network unavailable')
    const onError = vi.fn()
    const poller = createCollaborationPoller({
      intervalMs: 3_000,
      fetchActivity: async () => { throw failure },
      onActivity: vi.fn(),
      onError,
      scheduler: browserScheduler,
      visibility,
    })

    poller.start('run-1', 'running')
    await vi.advanceTimersByTimeAsync(3_000)
    await settle()

    expect(onError).toHaveBeenCalledWith(failure)
    expect(vi.getTimerCount()).toBe(1)
  })
})
