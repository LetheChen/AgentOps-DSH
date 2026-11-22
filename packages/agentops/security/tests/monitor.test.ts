/**
 * Monitor aggregation tests.
 *
 * @module @agentops/dsh-security/monitor-test
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  buildDailyUsage,
  buildMonitorSummary,
  monitorSince,
  parseMonitorDays,
  utcDayKey,
} from '../src/index.ts'
import type { UsageRecord } from '../src/index.ts'

function row(input: Partial<UsageRecord> & Pick<UsageRecord, 'id' | 'at' | 'totalTokens'>): UsageRecord {
  return {
    id: input.id,
    userId: input.userId ?? 'u1',
    agent: input.agent ?? 'chat',
    provider: input.provider ?? 'ds',
    model: input.model ?? 'v4',
    promptTokens: input.promptTokens ?? input.totalTokens,
    completionTokens: input.completionTokens ?? 0,
    totalTokens: input.totalTokens,
    at: input.at,
  }
}

void test('监控区间：非法 days 回退 30，合法值与 UTC 起点稳定', () => {
  assert.equal(parseMonitorDays('7'), 7)
  assert.equal(parseMonitorDays('90'), 90)
  assert.equal(parseMonitorDays('31'), 30)
  assert.equal(parseMonitorDays(null), 30)
  assert.equal(monitorSince(7, new Date('2026-10-27T23:30:00.000+08:00')), '2026-10-21T00:00:00.000Z')
})

void test('监控聚合：provider/model/用途与 UTC 日期独立分桶', () => {
  const rows = [
    row({ id: 'a', provider: 'ds', model: 'v4', agent: 'chat', totalTokens: 10, at: '2026-10-20T23:30:00.000Z' }),
    row({ id: 'b', provider: 'ds', model: 'v4', agent: 'chat', totalTokens: 20, at: '2026-10-20T23:59:59.000Z' }),
    row({ id: 'c', provider: 'minimax', model: 'm2', agent: 'summary', totalTokens: 30, promptTokens: 25, completionTokens: 5, at: '2026-10-21T00:00:00.000Z' }),
    row({ id: 'd', provider: '', model: '', agent: '', totalTokens: 40, at: 'not-a-date' }),
  ]

  const summary = buildMonitorSummary(rows)
  assert.equal(summary.calls, 4)
  assert.equal(summary.totalTokens, 100)
  assert.deepEqual(summary.byProvider, [
    { provider: 'unknown', tokens: 40, calls: 1 },
    { provider: 'ds', tokens: 30, calls: 2 },
    { provider: 'minimax', tokens: 30, calls: 1 },
  ])
  assert.deepEqual(summary.byModel[0], { model: 'unknown', tokens: 40, calls: 1 })
  assert.deepEqual(summary.byPurpose[0], { purpose: 'unknown', tokens: 40, calls: 1 })
  assert.deepEqual(summary.daily, [
    { date: '2026-10-20', provider: 'ds', tokens: 30, calls: 2 },
    { date: '2026-10-21', provider: 'minimax', tokens: 30, calls: 1 },
    { date: 'invalid', provider: 'unknown', tokens: 40, calls: 1 },
  ])
  assert.equal(utcDayKey('2026-10-21T00:00:00.000+08:00'), '2026-10-20')
})

void test('监控热力日聚合：同一天合并、按日期升序', () => {
  assert.deepEqual(buildDailyUsage([
    row({ id: 'a', totalTokens: 3, at: '2026-10-22T10:00:00.000Z' }),
    row({ id: 'b', totalTokens: 4, at: '2026-10-21T10:00:00.000Z' }),
    row({ id: 'c', totalTokens: 5, at: '2026-10-22T11:00:00.000Z' }),
  ]), [
    { date: '2026-10-21', tokens: 4, calls: 1 },
    { date: '2026-10-22', tokens: 8, calls: 2 },
  ])
})

void test('监控聚合：空输入不产生假数据', () => {
  assert.deepEqual(buildMonitorSummary([]), {
    totalTokens: 0,
    promptTokens: 0,
    completionTokens: 0,
    calls: 0,
    daily: [],
    byProvider: [],
    byModel: [],
    byPurpose: [],
  })
  assert.deepEqual(buildDailyUsage([]), [])
})
