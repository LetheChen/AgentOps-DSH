import { test } from 'node:test'
import assert from 'node:assert/strict'

import { summariseEvent, toSummary } from '../src/sessions.ts'

void test('toSummary：保留标题、live/persisted 与更新时间', () => {
  const summary = toSummary({
    header: { id: 's1', title: '差旅报销排查', updatedAt: '2026-10-25T06:00:00Z' },
    live: true,
    persisted: true,
  })
  assert.deepEqual(summary, {
    id: 's1', title: '差旅报销排查', live: true, persisted: true,
    updatedAt: '2026-10-25T06:00:00Z', eventCount: null,
  })
})

void test('toSummary：缺标题时给出占位而不是空字符串', () => {
  const summary = toSummary({ header: { id: 's2' }, live: false, persisted: true })
  assert.equal(summary.title, '(untitled)')
  assert.equal(summary.updatedAt, null)
})

void test('summariseEvent：提取类型、时间与截断预览，不解释内容', () => {
  const event = summariseEvent({
    type: 'message',
    at: '2026-10-25T06:01:00Z',
    message: { role: 'user', text: 'x'.repeat(400) },
  })
  assert.equal(event.type, 'message')
  assert.equal(event.at, '2026-10-25T06:01:00Z')
  assert.ok(event.preview.length <= 1200)

  const bare = summariseEvent({ kind: 'session/created' })
  assert.equal(bare.type, 'session/created')
  assert.equal(bare.at, null)

  assert.equal(summariseEvent(null).type, 'unknown')
})
