/**
 * Per-node retry and timeout for workflow nodes.
 *
 * The DSH runtime has no node-level timeout and no per-node retry: a stalled
 * node can only be cancelled together with the whole run. This wrapper adds
 * both without touching the runtime, by giving each attempt its own abort
 * signal and bounding it in time.
 *
 * @module @agentops/dsh-workflow-compiler/run
 */

/** Bounded retry and timeout for one node. */
export interface NodePolicy {
  /** Attempts after the first: `max: 2` means at most three calls. */
  readonly retry: { readonly max: number; readonly backoffMs: number }
  /** Wall-clock bound for one attempt. */
  readonly timeoutMs: number
}

/** Raised when one attempt exceeded `timeoutMs`. */
export class NodeTimeoutError extends Error {
  /** The per-attempt bound that elapsed. */
  readonly timeoutMs: number

  /**
   * @param timeoutMs - the bound that elapsed.
   */
  constructor(timeoutMs: number) {
    super(`节点执行超过 ${timeoutMs}ms`)
    this.name = 'NodeTimeoutError'
    this.timeoutMs = timeoutMs
  }
}

/** Raised when every attempt failed. */
export class NodeRetryExhausted extends Error {
  /** How many calls were made before the node was abandoned. */
  readonly attempts: number
  /** The failure of the last attempt. */
  readonly lastError: unknown

  /**
   * @param attempts - how many calls were made.
   * @param cause - the last failure.
   */
  constructor(attempts: number, cause: unknown) {
    super(`节点重试 ${attempts} 次后仍失败：${cause instanceof Error ? cause.message : String(cause)}`)
    this.name = 'NodeRetryExhausted'
    this.attempts = attempts
    this.lastError = cause
  }
}

/** Injection points that make the timing behaviour testable. */
export interface RunNodeDeps {
  /** Abortable delay between attempts. Defaults to a timer. */
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason === undefined ? new Error('已取消') : signal.reason
}

const defaultSleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(abortReason(signal))
      return
    }
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(abortReason(signal))
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })

function assertPolicy(policy: NodePolicy): void {
  if (!Number.isInteger(policy.retry.max) || policy.retry.max < 0) {
    throw new RangeError(`retry.max 必须是非负整数：${policy.retry.max}`)
  }
  if (!Number.isFinite(policy.retry.backoffMs) || policy.retry.backoffMs < 0) {
    throw new RangeError(`retry.backoffMs 必须是非负数：${policy.retry.backoffMs}`)
  }
  if (!Number.isFinite(policy.timeoutMs) || policy.timeoutMs <= 0) {
    throw new RangeError(`timeoutMs 必须是正数：${policy.timeoutMs}`)
  }
}

/**
 * Run one node attempt chain under a retry budget and a per-attempt timeout.
 *
 * Cancellation wins over retry: once the caller's signal aborts, the current
 * attempt is aborted, the backoff delay is cut short, and the abort reason is
 * rethrown instead of a retry. A timeout aborts only that attempt, so a slow
 * attempt still consumes a retry.
 *
 * @param policy - retry budget, backoff, and per-attempt timeout.
 * @param signal - caller cancellation for the whole node.
 * @param attempt - one node attempt; it receives the attempt's own signal.
 * @param deps - injectable delay, for deterministic tests.
 * @returns the first successful result.
 * @throws {RangeError} when the policy is not usable.
 * @throws {NodeRetryExhausted} when every attempt failed; `cause` holds the last failure.
 */
export async function runNode<T>(
  policy: NodePolicy,
  signal: AbortSignal,
  attempt: (signal: AbortSignal) => Promise<T>,
  deps: RunNodeDeps = {},
): Promise<T> {
  assertPolicy(policy)
  const sleep = deps.sleep ?? defaultSleep
  let last: unknown

  for (let index = 0; index <= policy.retry.max; index++) {
    if (index > 0) await sleep(policy.retry.backoffMs * 2 ** (index - 1), signal)
    signal.throwIfAborted()

    const controller = new AbortController()
    const onAbort = (): void =>{  controller.abort(abortReason(signal)) }
    signal.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() =>{  controller.abort(new NodeTimeoutError(policy.timeoutMs)) }, policy.timeoutMs)

    try {
      return await attempt(controller.signal)
    } catch (reason) {
      if (signal.aborted) throw abortReason(signal)
      last = reason
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
    }
  }

  throw new NodeRetryExhausted(policy.retry.max + 1, last)
}
