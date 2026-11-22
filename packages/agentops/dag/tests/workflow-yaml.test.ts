import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { DagEngine } from '../src/engine.ts'
import { parseWorkflowYaml, WorkflowParseError } from '../src/load.ts'
import { SqliteRunStore } from '../src/run-store.ts'
import { validateWorkflow } from '../src/validate.ts'

const YAML = `
workflow_id: travel-expense
nodes:
  step1_fetch:
    type: agent
    agent: workflow_owner
    after: []
    outputs:
      fetched:
        to: "step2.in:fetched"
  step2:
    type: agent
    agent: workflow_owner
    after: [step1_fetch]
    skip_if: "{{step1_fetch.fetched.count}} == 0"
    outputs:
      activated:
        to: step3
  step3:
    type: parallel_branch
    after: [step2]
    branches: [branch_a, branch_b]
  branch_a:
    type: agent
    agent: workflow_owner
    after: [step2]
  branch_b:
    type: agent
    agent: workflow_owner
    after: [step2]
  route:
    type: gateway
    after: [step3]
    condition: "{{branch_a.result}} == 'reject'"
    outputs:
      reject: [manual]
      pass: [auto]
  manual:
    type: agent
    agent: workflow_owner
    after: [route]
  auto:
    type: agent
    agent: workflow_owner
    after: [route]
`

void test('YAML 加载：映射节点、to 端口、并行分支、gateway 条件', () => {
  const wf = parseWorkflowYaml(YAML)
  assert.equal(wf.id, 'travel-expense')
  assert.equal(wf.nodes.length, 8)
  const step1 = wf.nodes.find(n => n.id === 'step1_fetch')!
  assert.deepEqual(step1.outputs, { fetched: ['step2'] })
  const step2 = wf.nodes.find(n => n.id === 'step2')!
  assert.equal(step2.skipIf, '{{step1_fetch.fetched.count}} == 0')
  const step3 = wf.nodes.find(n => n.id === 'step3')!
  assert.deepEqual(step3.branches, ['branch_a', 'branch_b'])

  const result = validateWorkflow(wf)
  assert.equal(result.ok, true, result.errors.join('；'))
})

void test('YAML 加载：未知 type 与缺失 workflow_id 明确报错', () => {
  assert.throws(() => parseWorkflowYaml('nodes:\n  a:\n    type: magic\n'), WorkflowParseError)
  assert.throws(() => parseWorkflowYaml('nodes: {}\n'), /workflow_id/)
})

void test('YAML 加载：保留协作视图使用的节点展示元数据', () => {
  const wf = parseWorkflowYaml(`
workflow_id: metadata
nodes:
  fetch:
    name: 数据采集
    type: agent
    agent: echo_agent
    business_role: 数据采集员
    harness: local_llm
    model: auto
`)

  assert.deepEqual(wf.nodes[0], {
    id: 'fetch',
    type: 'agent',
    displayName: '数据采集',
    agentRef: 'echo_agent',
    businessRole: '数据采集员',
    harness: 'local_llm',
    model: 'auto',
    after: [],
  })
})

void test('skip_if 命中：节点标记完成但带 skipped 原因，下游继续', async () => {
  const wf = parseWorkflowYaml(YAML)
  const calls: string[] = []
  const run = await new DagEngine().run(wf, async (node) => {
    calls.push(node.id)
    if (node.id === 'step1_fetch') return { fetched: { count: 0 } }
    if (node.id === 'branch_a') return { result: 'pass' }
    return {}
  })
  assert.equal(run.status, 'completed', JSON.stringify(run.nodes))
  assert.deepEqual(run.nodes.step2!.outputs, { skipped: true, reason: '{{step1_fetch.fetched.count}} == 0' })
  assert.ok(calls.includes('step3') || calls.includes('branch_a'), '下游仍应执行')
})

void test('运行存储：保存后可读回，列表按时间倒序', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentops-run-'))
  const path = join(dir, 'runs.db')
  try {
    const store = new SqliteRunStore(path)
    store.save({
      runId: 'r1', status: 'completed', startedAt: '2026-10-25T00:00:00Z', finishedAt: '2026-10-25T00:01:00Z',
      nodes: {
        a: { status: 'completed', attempts: 1, outputs: { ok: true } },
        b: { status: 'failed', attempts: 2, error: '超时' },
      },
    }, 'travel-expense')
    store.close()

    const reopened = new SqliteRunStore(path)
    const loaded = reopened.load('r1')!
    assert.equal(loaded.status, 'completed')
    assert.deepEqual(loaded.nodes.a!.outputs, { ok: true })
    assert.equal(loaded.nodes.b!.attempts, 2)
    assert.equal(loaded.nodes.b!.error, '超时')
    assert.equal(reopened.list()[0]!.workflowId, 'travel-expense')
    reopened.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

void test('运行存储：节点级起止时间跨重开仍可读，且可从两者算出耗时', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentops-run-time-'))
  const path = join(dir, 'runs.db')
  try {
    const store = new SqliteRunStore(path)
    store.save({
      runId: 'r2', status: 'running', startedAt: '2026-10-25T00:00:00.000Z',
      nodes: {
        scan: { status: 'completed', attempts: 1, startedAt: '2026-10-25T00:00:01.000Z', finishedAt: '2026-10-25T00:00:03.500Z' },
        analyze: { status: 'running', attempts: 2, startedAt: '2026-10-25T00:00:04.000Z' },
      },
    })
    store.close()

    const reopened = new SqliteRunStore(path)
    const loaded = reopened.load('r2')!
    assert.equal(loaded.nodes.scan!.startedAt, '2026-10-25T00:00:01.000Z')
    assert.equal(loaded.nodes.scan!.finishedAt, '2026-10-25T00:00:03.500Z')
    const scanMs = Date.parse(loaded.nodes.scan!.finishedAt) - Date.parse(loaded.nodes.scan!.startedAt)
    assert.equal(scanMs, 2500, '起止时间必须能算出节点耗时')
    assert.equal(loaded.nodes.analyze!.startedAt, '2026-10-25T00:00:04.000Z')
    assert.equal(loaded.nodes.analyze!.finishedAt, undefined, '未完成的节点不得有结束时间')

    // 收尾写入不得丢掉先前的开始时间
    reopened.save({
      runId: 'r2', status: 'completed', startedAt: '2026-10-25T00:00:00.000Z', finishedAt: '2026-10-25T00:00:09.000Z',
      nodes: {
        scan: { status: 'completed', attempts: 1, startedAt: '2026-10-25T00:00:01.000Z', finishedAt: '2026-10-25T00:00:03.500Z' },
        analyze: { status: 'completed', attempts: 2, startedAt: '2026-10-25T00:00:04.000Z', finishedAt: '2026-10-25T00:00:08.000Z' },
      },
    })
    const settled = reopened.load('r2')!
    assert.equal(settled.status, 'completed')
    assert.equal(settled.nodes.analyze!.finishedAt, '2026-10-25T00:00:08.000Z')
    reopened.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

void test('断点续跑：已完成节点不再执行，失败节点重跑', async () => {
  const wf = parseWorkflowYaml(YAML)
  const firstCalls: string[] = []
  const first = await new DagEngine().run(wf, async (node) => {
    firstCalls.push(node.id)
    if (node.id === 'branch_a') throw new Error('模型超时')
    return {}
  })
  assert.equal(first.status, 'failed')

  const secondCalls: string[] = []
  const second = await new DagEngine().run(wf, async (node) => {
    secondCalls.push(node.id)
    return {}
  }, { resume: first })

  assert.equal(second.status, 'completed')
  assert.ok(!secondCalls.includes('step1_fetch'), '已完成节点不应重跑')
  assert.ok(secondCalls.includes('branch_a'), '失败节点应重跑')
})

void test('取消后的运行可保存为 cancelled 状态', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentops-run2-'))
  const path = join(dir, 'runs.db')
  try {
    const store = new SqliteRunStore(path)
    const controller = new AbortController()
    const run = await new DagEngine().run(
      parseWorkflowYaml('workflow_id: w\nnodes:\n  a:\n    type: agent\n    agent: workflow_owner\n  b:\n    type: agent\n    agent: workflow_owner\n    after: [a]\n'),
      async () => { controller.abort(); return {} },
      { signal: controller.signal },
    )
    store.save(run, 'w')
    assert.equal(run.status, 'cancelled')
    assert.equal(store.load(run.runId)!.status, 'cancelled')
    store.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

void test('运行存储：运行输入跨重开保留在详情记录中', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentops-run-inputs-'))
  const path = join(dir, 'runs.db')
  try {
    const store = new SqliteRunStore(path)
    store.save({
      runId: 'wf@inputs', status: 'completed', startedAt: '2026-10-31T00:00:00.000Z',
      inputs: { topic: '迁移', count: 0, nested: { enabled: false } },
      nodes: { a: { status: 'completed', attempts: 1, outputs: { ok: true } } },
    }, 'wf')
    store.close()

    const reopened = new SqliteRunStore(path)
    const record = reopened.loadRecord('wf@inputs')!
    assert.deepEqual(record.state.inputs, { topic: '迁移', count: 0, nested: { enabled: false } })
    reopened.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

void test('运行存储：旧库自动增加 inputs 列，旧记录按空对象读取', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentops-run-legacy-inputs-'))
  const path = join(dir, 'runs.db')
  try {
    const legacy = new DatabaseSync(path)
    legacy.exec(`
      CREATE TABLE runs (
        run_id TEXT PRIMARY KEY,
        workflow_id TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        error TEXT
      );
      CREATE TABLE run_nodes (
        run_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        error TEXT,
        chosen_port TEXT,
        outputs TEXT,
        PRIMARY KEY (run_id, node_id)
      );
      INSERT INTO runs(run_id, workflow_id, status, started_at, finished_at)
      VALUES ('legacy@run', 'legacy', 'completed', '2026-10-30T00:00:00.000Z', '2026-10-30T00:01:00.000Z');
      INSERT INTO run_nodes(run_id, node_id, status, attempts, outputs)
      VALUES ('legacy@run', 'a', 'completed', 1, '{"ok":true}');
    `)
    legacy.close()

    const store = new SqliteRunStore(path)
    const record = store.loadRecord('legacy@run')!
    assert.equal(record.workflowId, 'legacy')
    assert.deepEqual(record.state.inputs, {})
    assert.deepEqual(record.state.nodes.a!.outputs, { ok: true })

    store.save({ ...record.state, inputs: { revision: 2 } }, record.workflowId)
    assert.deepEqual(store.load('legacy@run')!.inputs, { revision: 2 })
    store.close()

    const reopened = new SqliteRunStore(path)
    assert.deepEqual(reopened.loadRecord('legacy@run')!.state.inputs, { revision: 2 })
    reopened.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
