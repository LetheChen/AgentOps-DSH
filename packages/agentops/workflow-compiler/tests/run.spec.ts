import { describe, expect, it, vi } from 'vitest'

import { NodeRetryExhausted, NodeTimeoutError, runNode } from '../src/index.js'
import type { NodePolicy } from '../src/index.js'

const POLICY: NodePolicy = { retry: { max: 2, backoffMs: 100 }, timeoutMs: 50 }

/** Deterministic delay: records the requested backoff instead of waiting. */
function fakeSleep(): { sleep: (ms: number, signal: AbortSignal) => Promise<void>; delays: number[] } {
  const delays: number[] = []
  return {
    delays,
    sleep: async (ms, signal) => {
      delays.push(ms)
      signal.throwIfAborted()
    },
  }
}

describe('runNode 重试', () => {
  it('第一次成功只调用一次', async () => {
    const attempt = vi.fn(async () => 'ok')
    const { sleep, delays } = fakeSleep()
    await expect(runNode(POLICY, new AbortController().signal, attempt, { sleep })).resolves.toBe('ok')
    expect(attempt).toHaveBeenCalledTimes(1)
    expect(delays).toEqual([])
  })

  it('失败后按指数退避重试，第三次成功', async () => {
    let calls = 0
    const attempt = async (): Promise<string> => {
      calls++
      if (calls < 3) throw new Error(`第 ${calls} 次失败`)
      return 'ok'
    }
    const { sleep, delays } = fakeSleep()
    await expect(runNode(POLICY, new AbortController().signal, attempt, { sleep })).resolves.toBe('ok')
    expect(calls).toBe(3)
    expect(delays).toEqual([100, 200])
  })

  it('全部失败抛 NodeRetryExhausted 并保留最后一次错误', async () => {
    const attempt = vi.fn(async () => {
      throw new Error('总是失败')
    })
    const { sleep } = fakeSleep()
    const failure = await runNode(POLICY, new AbortController().signal, attempt, { sleep }).catch((reason: unknown) => reason)
    expect(failure).toBeInstanceOf(NodeRetryExhausted)
    const exhausted = failure as NodeRetryExhausted
    expect(exhausted.attempts).toBe(3)
    expect(exhausted.lastError).toBeInstanceOf(Error)
    expect((exhausted.lastError as Error).message).toBe('总是失败')
    expect(attempt).toHaveBeenCalledTimes(3)
  })
})

describe('runNode 超时', () => {
  it('单次超时会中止该次尝试并消耗一次重试', async () => {
    const signals: AbortSignal[] = []
    const attempt = (signal: AbortSignal): Promise<never> => {
      signals.push(signal)
      return new Promise<never>((_resolve, reject) => {
        signal.addEventListener('abort', () =>{  reject(signal.reason) }, { once: true })
      })
    }
    const { sleep } = fakeSleep()
    const failure = await runNode(POLICY, new AbortController().signal, attempt, { sleep }).catch((reason: unknown) => reason)

    expect(failure).toBeInstanceOf(NodeRetryExhausted)
    expect((failure as NodeRetryExhausted).lastError).toBeInstanceOf(NodeTimeoutError)
    expect((failure as NodeRetryExhausted).attempts).toBe(3)
    expect(signals).toHaveLength(3)
    expect(signals.every(signal => signal.aborted)).toBe(true)
  })

  it('超时错误带出配置的上限', () => {
    expect(new NodeTimeoutError(50).timeoutMs).toBe(50)
    expect(new NodeTimeoutError(50).message).toContain('50ms')
  })
})

describe('runNode 取消', () => {
  it('取消优先于重试：立即抛出取消原因，不再重试', async () => {
    const outer = new AbortController()
    const attempt = vi.fn(async (signal: AbortSignal) => {
      outer.abort(new Error('调用方取消'))
      signal.throwIfAborted()
      return 'never'
    })
    const { sleep, delays } = fakeSleep()

    await expect(runNode(POLICY, outer.signal, attempt, { sleep })).rejects.toThrow('调用方取消')
    expect(attempt).toHaveBeenCalledTimes(1)
    expect(delays).toEqual([])
  })

  it('退避等待期间取消也会立刻结束', async () => {
    const outer = new AbortController()
    const { sleep } = fakeSleep()
    let calls = 0
    const attempt = async (): Promise<string> => {
      calls++
      outer.abort(new Error('等待中取消'))
      throw new Error('第一次失败')
    }

    await expect(runNode(POLICY, outer.signal, attempt, { sleep })).rejects.toThrow('等待中取消')
    expect(calls).toBe(1)
  })

  it('进入前已取消则不调用节点', async () => {
    const outer = new AbortController()
    outer.abort(new Error('已经取消'))
    const attempt = vi.fn(async () => 'never')
    const { sleep } = fakeSleep()
    await expect(runNode(POLICY, outer.signal, attempt, { sleep })).rejects.toThrow('已经取消')
    expect(attempt).not.toHaveBeenCalled()
  })
})

describe('runNode 策略校验', () => {
  it('非法策略直接抛 RangeError', async () => {
    const noop = async (): Promise<string> => 'ok'
    const signal = new AbortController().signal
    await expect(runNode({ retry: { max: -1, backoffMs: 0 }, timeoutMs: 10 }, signal, noop)).rejects.toThrow(RangeError)
    await expect(runNode({ retry: { max: 0, backoffMs: 0 }, timeoutMs: 0 }, signal, noop)).rejects.toThrow(RangeError)
    await expect(runNode({ retry: { max: 1.5, backoffMs: 0 }, timeoutMs: 10 }, signal, noop)).rejects.toThrow(RangeError)
  })
})
