/**
 * Visibility-aware polling for one persisted run's collaboration activity.
 *
 * The poller owns at most one timer and one request. It never overlaps requests
 * and uses a generation token so a late response cannot replace a newer run.
 *
 * @module @agentops/dsh-client/collaboration-polling
 */

import type { ActivityRunStatus, RunActivity } from './collaboration-api.js'

/** Timer functions used by the poller, injectable for deterministic tests. */
export interface CollaborationTimerScheduler {
  setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>
  clearTimeout(handle: ReturnType<typeof setTimeout>): void
}

/** Document visibility source used to pause background polling. */
export interface CollaborationVisibilitySource {
  isHidden(): boolean
  subscribe(listener: () => void): () => void
}

/** Dependencies and result sinks for {@link createCollaborationPoller}. */
export interface CollaborationPollerOptions {
  /** Delay between settled polls. */
  readonly intervalMs: number
  /** Load the current run; the signal aborts when the run or visibility changes. */
  fetchActivity(signal: AbortSignal): Promise<RunActivity>
  /** Receive each current-generation activity response. */
  onActivity(activity: RunActivity): void
  /** Receive non-abort request failures. */
  onError(error: unknown): void
  /** Timer implementation. */
  readonly scheduler: CollaborationTimerScheduler
  /** Visibility source. */
  readonly visibility: CollaborationVisibilitySource
}

/** Lifecycle handle for one collaboration poller. */
export interface CollaborationPoller {
  /** Begin polling one run. Replaces any previous run. */
  start(runId: string, initialStatus: ActivityRunStatus): void
  /** Stop the active run while retaining visibility subscription. */
  stop(): void
  /** Permanently stop polling and release the visibility subscription. */
  dispose(): void
}

const terminalStatuses: ReadonlySet<ActivityRunStatus> = new Set([
  'completed',
  'failed',
  'cancelled',
])

/** Timer scheduler backed by the browser's global timers. */
const browserScheduler: CollaborationTimerScheduler = {
  setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clearTimeout: (handle) => { globalThis.clearTimeout(handle) },
}

/** Visibility source backed by the document visibility API, absent outside a browser. */
const browserVisibility: CollaborationVisibilitySource = {
  isHidden: () => typeof document !== 'undefined' && document.visibilityState === 'hidden',
  subscribe: (listener) => {
    if (typeof document === 'undefined') return () => {}
    document.addEventListener('visibilitychange', listener)
    return () => { document.removeEventListener('visibilitychange', listener) }
  },
}

function isAbortError(reason: unknown): boolean {
  return reason instanceof Error && reason.name === 'AbortError'
}

/**
 * Create a poller with an injected clock and visibility source.
 *
 * Polling begins one interval after {@link CollaborationPoller.start}; terminal
 * runs never poll. A failed request is reported once and does not stop polling
 * while the run remains active and the page is visible.
 *
 * @param options - request function, sinks, timer, visibility source, and delay.
 * @returns a start/stop/dispose lifecycle handle.
 */
export function createCollaborationPoller(
  options: CollaborationPollerOptions,
): CollaborationPoller {
  let generation = 0
  let runId: string | undefined
  let status: ActivityRunStatus | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let request: AbortController | undefined
  let disposed = false
  let unsubscribeVisibility: (() => void) | undefined

  function clearTimer(): void {
    if (timer === undefined) return
    options.scheduler.clearTimeout(timer)
    timer = undefined
  }

  function abortRequest(): void {
    request?.abort()
    request = undefined
  }

  function canSchedule(): boolean {
    return !disposed
      && runId !== undefined
      && status !== undefined
      && !terminalStatuses.has(status)
      && !options.visibility.isHidden()
      && timer === undefined
      && request === undefined
  }

  function schedule(): void {
    if (!canSchedule()) return
    const scheduledGeneration = generation
    timer = options.scheduler.setTimeout(() => {
      timer = undefined
      if (!isCurrent(scheduledGeneration) || options.visibility.isHidden()) return

      const controller = new AbortController()
      request = controller
      void options.fetchActivity(controller.signal).then(
        (activity) => {
          request = undefined
          if (!isCurrent(scheduledGeneration) || options.visibility.isHidden()) return
          status = activity.status
          options.onActivity(activity)
          if (isCurrent(scheduledGeneration)) schedule()
        },
        (reason: unknown) => {
          request = undefined
          if (!isCurrent(scheduledGeneration) || isAbortError(reason)) return
          options.onError(reason)
          if (isCurrent(scheduledGeneration)) schedule()
        },
      )
    }, options.intervalMs)
  }

  function isCurrent(expectedGeneration: number): boolean {
    return !disposed && generation === expectedGeneration
  }

  function stop(): void {
    generation += 1
    clearTimer()
    abortRequest()
    runId = undefined
    status = undefined
  }

  function onVisibilityChange(): void {
    if (disposed || runId === undefined) return
    if (options.visibility.isHidden()) {
      clearTimer()
      abortRequest()
      return
    }
    schedule()
  }

  unsubscribeVisibility = options.visibility.subscribe(onVisibilityChange)

  return {
    start(nextRunId, initialStatus) {
      if (disposed) return
      generation += 1
      clearTimer()
      abortRequest()
      runId = nextRunId
      status = initialStatus
      schedule()
    },
    stop,
    dispose() {
      if (disposed) return
      disposed = true
      generation += 1
      clearTimer()
      abortRequest()
      runId = undefined
      status = undefined
      unsubscribeVisibility?.()
      unsubscribeVisibility = undefined
    },
  }
}

/** Default DOM scheduler and visibility source for production callers. */
export { browserScheduler, browserVisibility }
