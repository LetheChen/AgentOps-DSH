import { test } from 'node:test'
import assert from 'node:assert/strict'

import { DagEngine, invalidateRunForNode, RunMutationError, WorkflowValidationError } from '../src/engine.ts'
import { evaluateExpression, ExpressionError } from '../src/expr.ts'
import { validateWorkflow } from '../src/validate.ts'
import type { NodeExecutor, RunState, WorkflowDefinition } from '../src/types.ts'

function wf(nodes: WorkflowDefinition['nodes'], id = 'wf'): WorkflowDefinition {
  return { id, inputs: [], nodes }
}

const record = (calls: string[]): NodeExecutor => async (node) => {
  calls.push(node.id)
  return { ok: true, from: node.id }
}

test('表达式：比较、布尔、括号、占位符，拒绝 eval', () => {
  const ctx = { result: { severity: 'reject', score: 0.8 }, count: 3 }
  assert.equal(evaluateExpression("{{result.severity}} == 'reject'", ctx), true)
  assert.equal(evaluateExpression('{{count}} >= 3 and {{result.score}} < 1', ctx), true)
  assert.equal(evaluateExpression('not ({{count}} > 5)', ctx), true)
  assert.equal(evaluateExpression('{{missing.path}}', ctx), false)
  assert.equal(evaluateExpression("{{result.severity}} != 'pass'", ctx), true)
  // 裸路径合法（旧 YAML gateway 三元表达式依赖它），但函数调用与未知语法在解析期失败。
  assert.throws(() => evaluateExpression('process.exit(1)', {}), ExpressionError)
  assert.equal(evaluateExpression("a == 'x'", { a: 'x' }), true)
  assert.throws(() => evaluateExpression("a == 'x' && b()", { a: 'x' }), ExpressionError)
})

test('校验：缺依赖、循环、gateway 无 condition、while 无限次', () => {
  const missing = validateWorkflow(wf([{ id: 'a', type: 'agent', after: ['nope'] }]))
  assert.equal(missing.ok, false)
  assert.match(missing.errors.join(), /依赖不存在的节点/)

  const cycle = validateWorkflow(wf([
    { id: 'a', type: 'agent', after: ['b'] },
    { id: 'b', type: 'agent', after: ['a'] },
  ]))
  assert.equal(cycle.ok, false)
  assert.match(cycle.errors.join(), /循环依赖/)

  const gateway = validateWorkflow(wf([{ id: 'g', type: 'gateway', after: [] }]))
  assert.equal(gateway.ok, false)
  assert.match(gateway.errors.join(), /缺少 condition/)

  const loop = validateWorkflow(wf([{ id: 'w', type: 'while', after: [], body: ['a'], continueIf: 'true' }]))
  assert.equal(loop.ok, false)
  assert.match(loop.errors.join(), /maxIterations/)
})

test('并行聚合：聚合节点必须等分支完成（旧引擎竞态回归）', () => {
  const workflow = wf([
    { id: 'start', type: 'agent', after: [] },
    { id: 'b1', type: 'agent', after: ['start'] },
    { id: 'b2', type: 'agent', after: ['start'] },
    { id: 'join', type: 'parallel_branch', after: ['start'], branches: ['b1', 'b2'] },
  ])
  const { levels } = validateWorkflow(workflow)
  const joinLevel = levels.findIndex(level => level.includes('join'))
  const branchLevel = levels.findIndex(level => level.includes('b1'))
  assert.ok(joinLevel > branchLevel, `join 应在分支之后：${JSON.stringify(levels)}`)
})

test('执行：线性 + 并行聚合拿到真实分支输出', async () => {
  const calls: string[] = []
  const workflow = wf([
    { id: 'start', type: 'agent', after: [] },
    { id: 'b1', type: 'agent', after: ['start'] },
    { id: 'b2', type: 'agent', after: ['start'] },
    { id: 'join', type: 'parallel_branch', after: ['start'], branches: ['b1', 'b2'] },
    { id: 'end', type: 'agent', after: ['join'] },
  ])
  const run = await new DagEngine().run(workflow, record(calls), { concurrency: 2 })
  assert.equal(run.status, 'completed')
  assert.equal(run.nodes.join!.status, 'completed')
  assert.deepEqual(Object.keys(run.nodes.join!.outputs!.branches as object).sort(), ['b1', 'b2'])
  assert.deepEqual(calls, ['start', 'b1', 'b2', 'end'])
})

test('gateway：只执行选中端口的下游分支，未选分支及后继保持 skipped', async () => {
  const workflow = wf([
    { id: 'check', type: 'agent', after: [] },
    {
      id: 'route', type: 'gateway', after: ['check'],
      condition: "{{check.result}} == 'reject'",
      outputs: { reject: 'handle', pass: 'done' },
    },
    { id: 'handle', type: 'agent', after: ['route'] },
    { id: 'handle_next', type: 'agent', after: ['handle'] },
    { id: 'done', type: 'agent', after: ['route'] },
  ])
  const calls: string[] = []
  const executor: NodeExecutor = async (node) => {
    calls.push(node.id)
    if (node.id === 'check') return { result: 'pass' }
    return {}
  }
  const run = await new DagEngine().run(workflow, executor)
  assert.equal(run.nodes.route!.chosenPort, 'pass')
  assert.deepEqual(calls, ['check', 'done'])
  assert.equal(run.nodes.handle!.status, 'skipped')
  assert.equal(run.nodes.handle_next!.status, 'skipped')
  assert.equal(run.nodes.done!.status, 'completed')
})

test('失败传播：下游跳过，上游保留结果', async () => {
  const workflow = wf([
    { id: 'a', type: 'agent', after: [] },
    { id: 'b', type: 'agent', after: ['a'] },
    { id: 'c', type: 'agent', after: ['b'] },
  ])
  const run = await new DagEngine().run(workflow, async (node) => {
    if (node.id === 'b') throw new Error('模型超时')
    return { ok: true }
  })
  assert.equal(run.status, 'failed')
  assert.equal(run.nodes.a!.status, 'completed')
  assert.equal(run.nodes.b!.status, 'failed')
  assert.match(run.nodes.b!.error!, /模型超时/)
  assert.equal(run.nodes.c!.status, 'skipped')
})

test('while：按 continueIf 迭代，受 maxIterations 限制', async () => {
  const seen: number[] = []
  const workflow = wf([
    { id: 'seed', type: 'agent', after: [] },
    { id: 'work', type: 'agent', after: [] },
    {
      id: 'retry', type: 'while', after: ['seed'],
      body: ['work'], continueIf: '{{iteration}} < 3', maxIterations: 3,
    },
  ])
  const run = await new DagEngine().run(workflow, async (node, ctx) => {
    if (node.id === 'work') seen.push(ctx.iteration)
    return {}
  })
  assert.equal(run.status, 'completed')
  assert.equal(run.nodes.retry!.outputs!.iterations, 3)
  assert.deepEqual(seen, [1, 2, 3])
})

test('取消：信号中止后不再启动新节点', async () => {
  const controller = new AbortController()
  const workflow = wf([
    { id: 'a', type: 'agent', after: [] },
    { id: 'b', type: 'agent', after: ['a'] },
  ])
  const run = await new DagEngine().run(workflow, async (node) => {
    if (node.id === 'a') controller.abort()
    return {}
  }, { signal: controller.signal })
  assert.equal(run.status, 'cancelled')
  assert.equal(run.nodes.b!.status, 'skipped')
})

test('校验失败直接抛错，不执行任何节点', async () => {
  let called = false
  await assert.rejects(
    new DagEngine().run(wf([{ id: 'a', type: 'agent', after: ['ghost'] }]), async () => { called = true }),
    WorkflowValidationError,
  )
  assert.equal(called, false)
})



function settledRun(
  workflowId: string,
  nodes: RunState['nodes'],
  status: RunState['status'] = 'completed',
): RunState {
  return {
    runId: `${workflowId}@2026-10-31T00:00:00.000Z`,
    status,
    nodes,
    startedAt: '2026-10-31T00:00:00.000Z',
    finishedAt: '2026-10-31T00:05:00.000Z',
  }
}

test('节点失效：onlyNode 只重置目标并保留 attempts 与无关节点', () => {
  const workflow = wf([
    { id: 'a', type: 'agent', after: [] },
    { id: 'b', type: 'agent', after: ['a'] },
    { id: 'c', type: 'agent', after: ['b'] },
    { id: 'd', type: 'agent', after: [] },
  ])
  const run = settledRun('wf', {
    a: { status: 'completed', attempts: 1, outputs: { ok: 'a' } },
    b: {
      status: 'failed',
      attempts: 3,
      startedAt: '2026-10-31T00:01:00.000Z',
      finishedAt: '2026-10-31T00:02:00.000Z',
      error: '失败',
      chosenPort: 'retry',
      outputs: { stale: true },
    },
    c: { status: 'skipped', attempts: 1, finishedAt: '2026-10-31T00:03:00.000Z' },
    d: { status: 'completed', attempts: 2, outputs: { ok: 'd' } },
  }, 'failed')
  const original = structuredClone(run)

  const next = invalidateRunForNode(run, workflow, 'b', true)

  assert.notEqual(next, run)
  assert.deepEqual(run, original, '不得修改调用方传入的运行状态')
  assert.equal(next.status, 'running')
  assert.equal(next.finishedAt, undefined)
  assert.equal(next.error, undefined)
  assert.deepEqual(next.nodes.b, { status: 'pending', attempts: 3 })
  assert.deepEqual(next.nodes.a, run.nodes.a)
  assert.deepEqual(next.nodes.c, run.nodes.c)
  assert.deepEqual(next.nodes.d, run.nodes.d)
})

test('节点失效：重跑下游会传递失效，并保留非下游完成产物', () => {
  const workflow = wf([
    { id: 'a', type: 'agent', after: [] },
    { id: 'b', type: 'agent', after: ['a'] },
    { id: 'c', type: 'agent', after: ['b'] },
    { id: 'd', type: 'agent', after: ['c'] },
    { id: 'side', type: 'agent', after: ['a'] },
  ])
  const run = settledRun('wf', {
    a: { status: 'completed', attempts: 1, outputs: { ok: 'a' } },
    b: { status: 'failed', attempts: 2, error: '失败' },
    c: { status: 'skipped', attempts: 1 },
    d: { status: 'pending', attempts: 0 },
    side: { status: 'completed', attempts: 1, outputs: { ok: 'side' } },
  }, 'failed')

  const next = invalidateRunForNode(run, workflow, 'b', false)

  assert.deepEqual(next.nodes.b, { status: 'pending', attempts: 2 })
  assert.deepEqual(next.nodes.c, { status: 'pending', attempts: 1 })
  assert.deepEqual(next.nodes.d, { status: 'pending', attempts: 0 })
  assert.deepEqual(next.nodes.a, run.nodes.a)
  assert.deepEqual(next.nodes.side, run.nodes.side)
})

test('节点失效：parallel_branch 的分支依赖参与下游传播', () => {
  const workflow = wf([
    { id: 'start', type: 'agent', after: [] },
    { id: 'left', type: 'agent', after: ['start'] },
    { id: 'right', type: 'agent', after: ['start'] },
    { id: 'join', type: 'parallel_branch', after: ['start'], branches: ['left', 'right'] },
    { id: 'end', type: 'agent', after: ['join'] },
  ])
  const run = settledRun('wf', {
    start: { status: 'completed', attempts: 1, outputs: { ok: true } },
    left: { status: 'completed', attempts: 1, outputs: { side: 'left' } },
    right: { status: 'completed', attempts: 1, outputs: { side: 'right' } },
    join: { status: 'completed', attempts: 1, outputs: { joined: true } },
    end: { status: 'completed', attempts: 1, outputs: { done: true } },
  })

  const next = invalidateRunForNode(run, workflow, 'left', false)

  assert.equal(next.nodes.left!.status, 'pending')
  assert.equal(next.nodes.join!.status, 'pending')
  assert.equal(next.nodes.end!.status, 'pending')
  assert.deepEqual(next.nodes.right, run.nodes.right)
})

test('节点失效：未知节点、workflow mismatch、运行中的 run 被明确拒绝', () => {
  const workflow = wf([{ id: 'a', type: 'agent', after: [] }], 'actual')
  const completed = settledRun('actual', { a: { status: 'completed', attempts: 1 } })

  assert.throws(
    () => invalidateRunForNode(completed, workflow, 'missing', true),
    (error: unknown) => error instanceof RunMutationError && error.code === 'unknown_node',
  )
  assert.throws(
    () => invalidateRunForNode(completed, wf([{ id: 'a', type: 'agent', after: [] }], 'other'), 'a', true),
    (error: unknown) => error instanceof RunMutationError && error.code === 'workflow_mismatch',
  )
  const running: RunState = { ...completed, status: 'running' }
  delete running.finishedAt
  assert.throws(
    () => invalidateRunForNode(running, workflow, 'a', true),
    (error: unknown) => error instanceof RunMutationError && error.code === 'run_running',
  )
})

test('执行上下文：新运行使用调用方 runId，并向普通节点传递 inputs', async () => {
  const workflow = wf([{ id: 'a', type: 'agent', after: [] }], 'workflow-a')
  const seen: Array<{ runId: string; inputs: Readonly<Record<string, unknown>> }> = []
  const run = await new DagEngine().run(workflow, async (_node, context) => {
    seen.push({ runId: context.runId, inputs: context.inputs })
    return { ok: true }
  }, {
    runId: 'workflow-a@2026-10-31T01:00:00.000Z',
    inputs: { topic: '迁移', count: 2 },
  })

  assert.equal(run.runId, 'workflow-a@2026-10-31T01:00:00.000Z')
  assert.deepEqual(run.inputs, { topic: '迁移', count: 2 })
  assert.deepEqual(seen, [{
    runId: 'workflow-a@2026-10-31T01:00:00.000Z',
    inputs: { topic: '迁移', count: 2 },
  }])
})

test('执行上下文：while body 使用真实 runId 并保留 inputs 与迭代号', async () => {
  const workflow = wf([
    { id: 'seed', type: 'agent', after: [] },
    { id: 'work', type: 'agent', after: [] },
    {
      id: 'loop', type: 'while', after: ['seed'], body: ['work'],
      continueIf: '{{iteration}} < 2', maxIterations: 2,
    },
  ])
  const seen: Array<{ runId: string; iteration: number; inputs: Readonly<Record<string, unknown>> }> = []
  const run = await new DagEngine().run(workflow, async (node, context) => {
    if (node.id === 'work') {
      seen.push({ runId: context.runId, iteration: context.iteration, inputs: context.inputs })
    }
    return {}
  }, { runId: 'run-real', inputs: { mode: 'batch' } })

  assert.equal(run.runId, 'run-real')
  assert.deepEqual(seen, [
    { runId: 'run-real', iteration: 1, inputs: { mode: 'batch' } },
    { runId: 'run-real', iteration: 2, inputs: { mode: 'batch' } },
  ])
})

test('执行上下文：resume 复用原 runId，并采用本次 inputs', async () => {
  const workflow = wf([
    { id: 'a', type: 'agent', after: [] },
    { id: 'b', type: 'agent', after: ['a'] },
  ])
  const first = await new DagEngine().run(workflow, async (node) => {
    if (node.id === 'b') throw new Error('首次失败')
    return { ok: true }
  }, { runId: 'wf@run-resume', inputs: { revision: 1 } })
  const seen: Array<{ nodeId: string; runId: string; inputs: Readonly<Record<string, unknown>> }> = []
  const resumed = await new DagEngine().run(workflow, async (node, context) => {
    seen.push({ nodeId: node.id, runId: context.runId, inputs: context.inputs })
    return { ok: true }
  }, {
    resume: invalidateRunForNode(first, workflow, 'b', true),
    inputs: { revision: 2 },
  })

  assert.equal(resumed.runId, 'wf@run-resume')
  assert.deepEqual(resumed.inputs, { revision: 2 })
  assert.deepEqual(seen, [{
    nodeId: 'b',
    runId: 'wf@run-resume',
    inputs: { revision: 2 },
  }])
})
