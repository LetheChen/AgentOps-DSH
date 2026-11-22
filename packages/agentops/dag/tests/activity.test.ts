import { test } from 'node:test'
import assert from 'node:assert/strict'

import { projectAgentActivity } from '../src/activity.ts'
import type { RunRecord } from '../src/run-store.ts'
import type { RunState, WorkflowDefinition } from '../src/types.ts'

function record(state: RunState, workflowId = 'hybrid-test'): RunRecord {
  return { workflowId, state }
}

void test('活动投影：业务泳道按首次出现排序，并保留声明顺序与角色降级链', () => {
  const workflow: WorkflowDefinition = {
    id: 'hybrid-test',
    inputs: [],
    nodes: [
      { id: 'fetch', type: 'agent', displayName: '数据采集', agentRef: 'collector', businessRole: '数据采集员', after: [] },
      { id: 'analyze', type: 'agent', businessRole: '对话分析员', after: ['fetch'] },
      { id: 'report', type: 'agent', displayName: '输出报告', businessRole: '数据采集员', after: ['analyze'] },
      { id: 'runner', type: 'agent', agentRef: 'echo_agent', after: [] },
      { id: 'leaf', type: 'command', after: [] },
    ],
  }

  const activity = projectAgentActivity({
    record: record({ runId: 'run-1', status: 'running', startedAt: '2026-10-31T00:00:00Z', nodes: {} }),
    workflow,
  })

  assert.deepEqual(activity.lanes, [
    { id: '数据采集员', label: '数据采集员', nodeIds: ['fetch', 'report'] },
    { id: '对话分析员', label: '对话分析员', nodeIds: ['analyze'] },
    { id: 'echo_agent', label: 'echo_agent', nodeIds: ['runner'] },
    { id: 'leaf', label: 'leaf', nodeIds: ['leaf'] },
  ])
  assert.equal(activity.nodes[0]!.displayName, '数据采集')
  assert.equal(activity.nodes[1]!.displayName, 'analyze')
  assert.equal(activity.nodes[4]!.displayName, 'leaf')
  assert.deepEqual(activity.handoffs, [], '没有 handoff 持久化事件时不得伪造')
})

void test('活动投影：保留真实节点状态、耗时和缺失节点的 pending 降级', () => {
  const workflow: WorkflowDefinition = {
    id: 'states',
    inputs: [],
    nodes: [
      { id: 'done', type: 'agent', after: [] },
      { id: 'running', type: 'agent', after: ['done'] },
      { id: 'failed', type: 'agent', after: ['running'] },
      { id: 'skipped', type: 'agent', after: ['failed'] },
      { id: 'not-started', type: 'agent', after: ['skipped'] },
    ],
  }
  const activity = projectAgentActivity({
    record: record({
      runId: 'run-2',
      status: 'running',
      startedAt: '2026-10-31T00:00:00.000Z',
      nodes: {
        done: {
          status: 'completed', attempts: 1,
          startedAt: '2026-10-31T00:00:01.000Z', finishedAt: '2026-10-31T00:00:03.500Z',
          outputs: { value: 42 },
        },
        running: { status: 'running', attempts: 2, startedAt: '2026-10-31T00:00:04.000Z' },
        failed: {
          status: 'failed', attempts: 2,
          startedAt: '2026-10-31T00:00:04.000Z', finishedAt: '2026-10-31T00:00:05.000Z', error: '超时',
        },
        skipped: { status: 'skipped', attempts: 1, finishedAt: '2026-10-31T00:00:06.000Z' },
      },
    }),
    workflow,
  })

  assert.equal(activity.nodes[0]!.status, 'completed')
  assert.equal(activity.nodes[0]!.durationMs, 2500)
  assert.deepEqual(activity.nodes[0]!.outputs, { value: 42 })
  assert.equal(activity.nodes[1]!.status, 'running')
  assert.equal(activity.nodes[1]!.durationMs, undefined)
  assert.equal(activity.nodes[2]!.status, 'failed')
  assert.equal(activity.nodes[2]!.error, '超时')
  assert.equal(activity.nodes[3]!.status, 'skipped')
  assert.equal(activity.nodes[4]!.status, 'pending')
  assert.equal(activity.nodes[4]!.attempts, 0)
})

void test('活动投影：调度边只来自 after，数据边只来自 outputs 且忽略空目标', () => {
  const workflow: WorkflowDefinition = {
    id: 'edges',
    inputs: [],
    nodes: [
      { id: 'scan', type: 'agent', after: [], outputs: { raw: 'analyze' } },
      { id: 'analyze', type: 'agent', after: [], outputs: { empty: '' } },
      { id: 'publish', type: 'agent', after: ['analyze'] },
    ],
  }

  const activity = projectAgentActivity({
    record: record({ runId: 'run-3', status: 'running', startedAt: '2026-10-31T00:00:00Z', nodes: {} }),
    workflow,
  })

  assert.deepEqual(activity.scheduleEdges, [{ from: 'analyze', to: 'publish' }])
  assert.deepEqual(activity.dataEdges, [{ from: 'scan', to: 'analyze', port: 'raw' }])
})

void test('活动投影：时间线只使用持久化的真实时间戳并稳定排序', () => {
  const workflow: WorkflowDefinition = {
    id: 'timeline',
    inputs: [],
    nodes: [
      { id: 'running', type: 'agent', after: [] },
      { id: 'done', type: 'agent', after: [] },
      { id: 'failed', type: 'agent', after: [] },
      { id: 'skipped', type: 'agent', after: [] },
      { id: 'pending', type: 'agent', after: [] },
      { id: 'completed-no-time', type: 'agent', after: [] },
    ],
  }
  const activity = projectAgentActivity({
    record: record({
      runId: 'run-4',
      status: 'failed',
      startedAt: '2026-10-31T00:00:00.000Z',
      finishedAt: '2026-10-31T00:00:03.000Z',
      error: 'run exploded',
      nodes: {
        running: { status: 'running', attempts: 1, startedAt: '2026-10-31T00:00:01.000Z' },
        done: {
          status: 'completed', attempts: 1,
          startedAt: '2026-10-31T00:00:01.000Z', finishedAt: '2026-10-31T00:00:02.000Z',
        },
        failed: {
          status: 'failed', attempts: 2,
          startedAt: '2026-10-31T00:00:01.000Z', finishedAt: '2026-10-31T00:00:02.000Z', error: 'node exploded',
        },
        skipped: { status: 'skipped', attempts: 1, finishedAt: '2026-10-31T00:00:02.000Z' },
        pending: { status: 'pending', attempts: 0 },
        'completed-no-time': { status: 'completed', attempts: 1 },
      },
    }),
    workflow,
  })

  assert.deepEqual(activity.timeline.map(entry => entry.type), [
    'run.started',
    'node.started',
    'node.started',
    'node.started',
    'node.completed',
    'node.failed',
    'node.skipped',
    'run.failed',
  ])
  assert.deepEqual(activity.timeline.map(entry => entry.nodeId), [
    undefined,
    'running',
    'done',
    'failed',
    'done',
    'failed',
    'skipped',
    undefined,
  ])
  assert.equal(activity.timeline[5]!.error, 'node exploded')
  assert.equal(activity.timeline[7]!.error, 'run exploded')
})

void test('活动投影：相同输入完全相等，结束事件必须来自真实 run 结束时间', () => {
  const workflow: WorkflowDefinition = {
    id: 'deterministic',
    inputs: [],
    nodes: [{ id: 'waiting', type: 'agent', after: [] }],
  }
  const input = {
    record: record({
      runId: 'run-5',
      status: 'cancelled' as const,
      startedAt: '2026-10-31T00:00:00.000Z',
      finishedAt: '2026-10-31T00:00:01.000Z',
      nodes: { waiting: { status: 'pending' as const, attempts: 0 } },
    }),
    workflow,
  }
  const first = projectAgentActivity(input)
  const second = projectAgentActivity(input)

  assert.deepEqual(first, second)
  assert.deepEqual(first.timeline.map(entry => entry.type), ['run.started', 'run.cancelled'])

  const running = projectAgentActivity({
    record: record({
      runId: 'run-6',
      status: 'running',
      startedAt: '2026-10-31T00:00:00.000Z',
      nodes: {},
    }),
    workflow,
  })
  assert.deepEqual(running.timeline.map(entry => entry.type), ['run.started'])
})

void test('活动投影：透传持久化的运行输入供节点重跑使用', () => {
  const workflow: WorkflowDefinition = {
    id: 'inputs',
    inputs: [
      { name: 'topic', type: 'string', required: true },
      { name: 'count', type: 'integer', required: false, default: 1 },
    ],
    nodes: [{ id: 'a', type: 'agent', after: [] }],
  }
  const activity = projectAgentActivity({
    record: record({
      runId: 'inputs@run',
      status: 'failed',
      startedAt: '2026-10-31T00:00:00.000Z',
      inputs: { topic: '迁移', count: 0 },
      nodes: { a: { status: 'failed', attempts: 1, error: '失败' } },
    }, 'inputs'),
    workflow,
  })

  assert.deepEqual(activity.inputs, { topic: '迁移', count: 0 })
})
