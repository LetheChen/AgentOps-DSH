import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createUsageTap, totalTokensOf } from '../src/collector.ts'
import { SecurityStore } from '../src/store.ts'

const NOW = '2026-10-25T10:00:00+08:00'

function withStore(run: (store: SecurityStore) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'agentops-tap-'))
  const store = new SecurityStore(join(dir, 'security.db'))
  return run(store).finally(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })
}

type Chunk = { type: string; usage?: Record<string, number> }

async function* chunks(list: Chunk[]): AsyncIterable<Chunk> {
  for (const chunk of list) yield chunk
}

void test('totalTokensOf：缓存读写计入 prompt，不重复计 output', () => {
  assert.deepEqual(totalTokensOf({ inputTokens: 10, outputTokens: 5, cacheReadTokens: 2, cacheWriteTokens: 3 }), {
    prompt: 15, completion: 5,
  })
  assert.deepEqual(totalTokensOf({}), { prompt: 0, completion: 0 })
})

void test('采集：usage chunk 落一行，模型与会话来自请求', async () => {
  await withStore(async (store) => {
    const tap = createUsageTap(store, { now: () => new Date(NOW), id: () => 'use_test' })
    const stream = tap(
      { provider: 'deepseek', model: 'deepseek-v4-pro', sessionId: 's_1', purpose: 'chat' },
      () => chunks([
        { type: 'text-delta' },
        { type: 'usage', usage: { inputTokens: 100, outputTokens: 40, cacheReadTokens: 10 } },
        { type: 'finish' },
      ]),
    )

    const seen: string[] = []
    for await (const chunk of stream) seen.push(chunk.type)
    assert.deepEqual(seen, ['text-delta', 'usage', 'finish'], '流必须原样透传')

    const summary = store.usage()
    assert.equal(summary.calls, 1)
    assert.equal(summary.totalTokens, 150)
    const row = store.recentUsage()[0]!
    assert.equal(row.provider, 'deepseek')
    assert.equal(row.model, 'deepseek-v4-pro')
    assert.equal(row.sessionId, 's_1')
    assert.equal(row.agent, 'chat')
    assert.equal(row.userId, 'unattributed')
  })
})

void test('采集：provider 与 model 独立记录，不互相兜底', async () => {
  await withStore(async (store) => {
    const tap = createUsageTap(store, { id: () => 'use_split' })
    for await (const _chunk of tap(
      { provider: 'only-provider' },
      () => chunks([{ type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }]),
    )) {
      // drain
    }
    const row = store.recentUsage()[0]!
    assert.equal(row.provider, 'only-provider')
    assert.equal(row.model, 'unknown')
  })
})

void test('采集：没有 usage chunk 时不记假数据', async () => {
  await withStore(async (store) => {
    const tap = createUsageTap(store)
    for await (const _chunk of tap({ model: 'm' }, () => chunks([{ type: 'text-delta' }]))) {
      // drain
    }
    assert.equal(store.usage().calls, 0)
  })
})

void test('采集：零 token 的 usage 不记录', async () => {
  await withStore(async (store) => {
    const tap = createUsageTap(store)
    for await (const _chunk of tap({ model: 'm' }, () => chunks([{ type: 'usage', usage: {} }]))) {
      // drain
    }
    assert.equal(store.usage().calls, 0)
  })
})
