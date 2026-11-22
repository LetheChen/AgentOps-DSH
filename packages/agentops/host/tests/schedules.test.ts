import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { matchesCron, readSchedules, ScheduleRuntime, validateCron, writeSchedules } from '../src/schedules.ts'

void test('readSchedules：文件缺失返回空并标记 missing', () => {
  const result = readSchedules(join(tmpdir(), 'no-such-schedules.yaml'))
  assert.equal(result.missing, true)
  assert.deepEqual(result.entries, [])
})

void test('readSchedules：解析 cron / enabled / inputs，跳过残缺条目', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentops-schedules-'))
  try {
    const file = join(dir, 'schedules.yaml')
    writeFileSync(file, [
      'schedules:',
      '  - id: OA',
      '    workflow_id: log-patrol',
      '    name: 致远OA日志巡检',
      "    cron: '*/30 * * * *'",
      '    timezone: Asia/Shanghai',
      '    inputs:',
      '      level: ERROR',
      '    enabled: false',
      '  - id: MaxKB_3',
      '    workflow_id: log-puller',
      '    name: MaxKB 抽取',
      '    cron: 0 9,12,18 * * 1-7',
      '    enabled: true',
      '  - name: 缺 id 与 cron',
      '  - id: no-cron',
      '    name: 只有 id',
    ].join('\n'))

    const result = readSchedules(file)
    assert.equal(result.missing, false)
    assert.equal(result.entries.length, 2)
    assert.deepEqual(result.entries[0], {
      id: 'OA', name: '致远OA日志巡检', workflowId: 'log-patrol',
      cron: '*/30 * * * *', timezone: 'Asia/Shanghai', inputs: { level: 'ERROR' }, enabled: false,
      createdAt: null, updatedAt: null, lastRunAt: null, lastStatus: null, lastError: null, lastSessionId: null,
    })
    assert.equal(result.entries[1]!.enabled, true)
    assert.equal(result.entries[1]!.timezone, 'Asia/Shanghai')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

void test('writeSchedules：原子回写后保留运行证据', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentops-schedules-write-'))
  try {
    const file = join(dir, 'schedules.yaml')
    writeSchedules(file, [{
      id: 'daily', name: '每日巡检', workflowId: 'log-patrol', cron: '0 9 * * *', timezone: 'Asia/Shanghai',
      inputs: { level: 'ERROR' }, enabled: true, createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z', lastRunAt: '2026-01-02T01:00:00.000Z',
      lastStatus: 'started', lastError: null, lastSessionId: 'session-1',
    }])
    assert.deepEqual(readSchedules(file).entries[0]?.lastSessionId, 'session-1')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

void test('cron：校验五段表达式并按 IANA 时区匹配', () => {
  assert.deepEqual(validateCron('0 9 * * 1-5'), [])
  assert.ok(validateCron('0 9 * *').some(error => error.includes('5 段')))
  assert.equal(matchesCron('0 9 * * 1-5', new Date('2026-11-16T01:00:00.000Z'), 'Asia/Shanghai'), true)
  assert.equal(matchesCron('0 9 * * 1-5', new Date('2026-11-15T01:00:00.000Z'), 'Asia/Shanghai'), false)
})

void test('ScheduleRuntime：到点只触发一次，并创建 AgentOps 会话', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentops-schedules-runtime-'))
  try {
    const workflows = join(dir, 'workflows')
    const file = join(dir, 'schedules.yaml')
    writeFileSync(join(dir, 'placeholder'), '')
    mkdirSync(workflows, { recursive: true })
    writeFileSync(join(workflows, 'log-patrol.yaml'), 'workflow_id: log-patrol\nnodes:\n  a:\n    type: agent\n    agent: log_analyst\n')
    writeSchedules(file, [{
      id: 'every-minute', name: '每分钟', workflowId: 'log-patrol', cron: '* * * * *', timezone: 'UTC',
      inputs: { level: 'ERROR' }, enabled: true, createdAt: null, updatedAt: null,
      lastRunAt: null, lastStatus: null, lastError: null, lastSessionId: null,
    }])
    const calls: string[] = []
    const controller = {
      create: async () => { calls.push('create'); return { sessionId: 'session-test' } },
      prompt: async (request: { readonly content: readonly { readonly text?: string }[] }) => {
        calls.push(request.content[0]?.text ?? '')
      },
    }
    const runtime = new ScheduleRuntime(file, workflows, () => controller as never)
    const now = new Date('2026-11-14T01:02:03.000Z')
    await runtime.tick(now)
    await runtime.tick(now)
    assert.deepEqual(calls.slice(0, 1), ['create'])
    assert.equal(calls.length, 2)
    assert.equal(readSchedules(file).entries[0]?.lastStatus, 'started')
    assert.equal(readSchedules(file).entries[0]?.lastSessionId, 'session-test')
    runtime.dispose()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
