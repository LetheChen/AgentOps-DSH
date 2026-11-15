import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { createSubagentExecutor, deliveryText, inputsParameter, nodeOutputSchema, nodePrompt } from '../src/dsh.ts'
import type { ObjectValueSchemaSpec } from '@deepseek-ai/dsh-tools'
import { apply } from '../src/tools.ts'
import { SqliteRunStore } from '../src/run-store.ts'
import type { SubagentActivationSpec, SubagentRuntime } from '@deepseek-ai/dsh-subagent'

// Test isolation: `resolveRunDbPath` falls back to `$DSH_HOME/agentops/runs.db`,
// which is the developer's real run history. Point that fallback at a throwaway
// database so a test that forgets `runDbPath` cannot write into it.
process.env.AGENTOPS_RUN_DB = join(mkdtempSync(join(tmpdir(), 'agentops-dag-runs-')), 'runs.db')

const YAML = `
workflow_id: linear
nodes:
  a:
    type: agent
    agent: workflow_owner
    outputs:
      out:
        to: b
  b:
    type: agent
    agent: workflow_owner
    after: [a]
`

const RERUN_YAML = `
workflow_id: rerun-flow
inputs:
  - name: topic
    type: string
    required: true
nodes:
  a:
    type: agent
    agent: workflow_owner
    outputs:
      out:
        to: b
  b:
    type: agent
    agent: workflow_owner
    after: [a]
`

/** Behaviour a fake subagent runtime reports for one activation. */
type FakeBehaviour = (label: string, spec: SubagentActivationSpec) => {
  text?: string
  structured?: unknown
  stop?: string
  diagnostic?: string
}

function fakeRuntime(
  behaviour: FakeBehaviour = () => ({}),
): { runtime: SubagentRuntime; labels: string[]; prompts: string[]; specs: SubagentActivationSpec[] } {
  const labels: string[] = []
  const prompts: string[] = []
  const specs: SubagentActivationSpec[] = []
  const runtime = {
    startActivation: async (spec: SubagentActivationSpec) => {
      specs.push(spec)
      labels.push(spec.label)
      prompts.push(spec.request.prompt.map(part => part.type === 'text' ? part.text : '').join('\n'))
      const outcome = behaviour(spec.label, spec)
      const ports = spec.request.outputSchema?.required ?? []
      const generatedText = JSON.stringify(Object.fromEntries(ports.map(port => [port, `done:${spec.label}`])))
      const text = outcome.text ?? generatedText
      return {
        childId: `child-${spec.label}`,
        result: Promise.resolve({
          output: text.length === 0 ? [] : [{ type: 'text', text }],
          stopReason: outcome.stop === undefined ? 'completed' : outcome.stop,
          ...(outcome.structured === undefined ? {} : { structured: outcome.structured }),
          ...(outcome.diagnostic === undefined ? {} : { diagnostic: outcome.diagnostic }),
        }),
        dispose: async () => {},
      }
    },
  } as unknown as SubagentRuntime
  return { runtime, labels, prompts, specs }
}

const parent = { session: { header: { id: 'session-test' } }, options: {} } as never

test('nodePrompt 声明输出端口协议，并保留输入、上游 JSON 与共享长度预算', () => {
  const node = {
    id: 'a',
    type: 'agent' as const,
    outputs: { answer: '', metadata: '' },
    after: [],
  }
  const text = nodePrompt(
    node,
    { topic: '迁移', limit: 3 },
    { prev: { ok: true } },
    8000,
  )
  assert.match(text, /节点 a/)
  assert.match(text, /输出端口/)
  assert.match(text, /answer/)
  assert.match(text, /metadata/)
  assert.match(text, /最终回复必须是一个 JSON 对象/)
  assert.match(text, /运行输入/)
  assert.match(text, /迁移/)
  assert.match(text, /prev/)

  const truncated = nodePrompt(
    { id: 'b', type: 'agent', outputs: { out: '' }, after: [] },
    { input: 'i'.repeat(200) },
    { output: 'o'.repeat(200) },
    80,
  )
  assert.match(truncated, /运行输入（JSON，已截断）/)
  assert.match(truncated, /上游输出（JSON，已截断）/)
  const embedded = truncated
    .split('\n')
    .filter(line => line.startsWith('运行输入（JSON') || line.startsWith('上游输出（JSON'))
    .map(line => line.slice(line.indexOf('：') + 1))
    .join('')
  assert.ok(embedded.length <= 80, `embedded JSON must stay within the shared budget: ${embedded.length}`)
})

test('nodeOutputSchema：端口均为必填且禁止额外键，无端口时不请求 schema', () => {
  assert.deepEqual(nodeOutputSchema({
    id: 'a', type: 'agent', agentRef: 'owner', outputs: { answer: '', score: '' }, after: [],
  }), {
    type: 'object',
    properties: { answer: {}, score: {} },
    required: ['answer', 'score'],
    additionalProperties: false,
  })
  assert.equal(nodeOutputSchema({ id: 'empty', type: 'agent', agentRef: 'owner', after: [] }), undefined)
})

test('subagent 执行器：文本 JSON 形成端口对象，失败抛出诊断', async () => {
  const ok = fakeRuntime()
  const executor = createSubagentExecutor(ok.runtime, { provider: 'spawn', concurrency: 2 }, () => parent)
  const outputs = await executor({
    id: 'a', type: 'agent', agentRef: 'owner', outputs: { answer: '' }, after: [],
  }, { runId: 'r', inputs: {}, iteration: 1, upstream: {} })
  assert.deepEqual(outputs, { answer: 'done:a' })
  assert.deepEqual(ok.labels, ['a'])
  assert.deepEqual(ok.specs[0]?.request.outputSchema, {
    type: 'object',
    properties: { answer: {} },
    required: ['answer'],
    additionalProperties: false,
  })

  const noPorts = await createSubagentExecutor(ok.runtime, {}, () => parent)(
    { id: 'empty', type: 'agent', agentRef: 'owner', after: [] },
    { runId: 'r', inputs: {}, iteration: 1, upstream: {} },
  )
  assert.deepEqual(noPorts, {})
  assert.equal(ok.specs[1]?.request.outputSchema, undefined)

  const bad = fakeRuntime(() => ({ stop: 'error', diagnostic: '模型超时' }))
  const failing = createSubagentExecutor(bad.runtime, {}, () => parent)
  await assert.rejects(
    () => failing({ id: 'b', type: 'agent', agentRef: 'owner', after: [] }, { runId: 'r', inputs: {}, iteration: 1, upstream: {} }),
    /模型超时/,
  )
})

test('subagent 执行器：优先使用 structured，并拒绝缺端口、额外端口和非法 JSON', async () => {
  const structured = fakeRuntime(() => ({ structured: { answer: 42 } }))
  const structuredExecutor = createSubagentExecutor(structured.runtime, {}, () => parent)
  assert.deepEqual(await structuredExecutor({
    id: 'structured', type: 'agent', agentRef: 'owner', outputs: { answer: '' }, after: [],
  }, { runId: 'r', inputs: {}, iteration: 1, upstream: {} }), { answer: 42 })

  const missing = fakeRuntime(() => ({ text: '{}' }))
  await assert.rejects(
    () => createSubagentExecutor(missing.runtime, {}, () => parent)({
      id: 'missing-node', type: 'agent', agentRef: 'owner', outputs: { answer: '' }, after: [],
    }, { runId: 'r', inputs: {}, iteration: 1, upstream: {} }),
    /节点 missing-node.*answer/,
  )

  const extra = fakeRuntime(() => ({ text: '{"answer":"ok","extra":true}' }))
  await assert.rejects(
    () => createSubagentExecutor(extra.runtime, {}, () => parent)({
      id: 'extra-node', type: 'agent', agentRef: 'owner', outputs: { answer: '' }, after: [],
    }, { runId: 'r', inputs: {}, iteration: 1, upstream: {} }),
    /节点 extra-node.*extra/,
  )

  const invalid = fakeRuntime(() => ({ text: '```json\n{"answer":"ok"}\n```' }))
  await assert.rejects(
    () => createSubagentExecutor(invalid.runtime, {}, () => parent)({
      id: 'invalid-node', type: 'agent', agentRef: 'owner', outputs: { answer: '' }, after: [],
    }, { runId: 'r', inputs: {}, iteration: 1, upstream: {} }),
    /节点 invalid-node.*JSON/,
  )
})

test('subagent 执行器：节点使用自己的 Agent、模型、角色提示词与超时', async () => {
  const fake = fakeRuntime()
  const caller = new AbortController()
  const executor = createSubagentExecutor(fake.runtime, { provider: 'spawn' }, () => parent)

  await executor({
    id: 'route_intent',
    type: 'agent',
    agentRef: 'smart_query',
    rolePrompt: '只判断用户问题是否属于审批数据查询。',
    model: 'minimax/MiniMax-M3',
    timeoutMs: 25,
    after: [],
  }, {
    runId: 'r', inputs: { question: '本月通过率' }, iteration: 1, upstream: {},
    signal: caller.signal,
  })

  const spec = fake.specs[0]
  assert.ok(spec)
  assert.equal(spec.request.agentPreset, 'smart_query')
  assert.deepEqual(spec.request.agentOptions, { provider: 'minimax', model: 'MiniMax-M3' })
  assert.match(fake.prompts[0] ?? '', /只判断用户问题是否属于审批数据查询/)
  assert.notEqual(spec.signal, caller.signal)
})

const OWNED_YAML = `
workflow_id: owned
nodes:
  a:
    type: agent
    agent: owner_agent
    business_role: 意图分类员
`

test('dag_run 钉定工作流与所属 Agent，list_runs 能按 Agent 查回归属与 actor', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentops-dag-attrib-'))
  try {
    writeFileSync(join(dir, 'owned.yaml'), OWNED_YAML)
    const registered = new Map<string, { execute: (args: never, exec: never) => Promise<unknown> }>()
    const fake = fakeRuntime()
    const ctx = {
      tools: { register: (def: { name: string }) => { registered.set(def.name, def as never); return () => {} } },
      get: (key: string) => (key === 'subagents' ? fake.runtime : undefined),
    }
    apply(ctx as never, {
      workflowDir: dir,
      runDbPath: join(dir, 'runs.db'),
      provider: 'spawn',
      concurrency: 1,
      ownedWorkflowId: 'owned',
      ownerAgentPreset: 'owner_agent',
    })

    const exec = { agent: parent, signal: new AbortController().signal } as never
    // A pinned preset ignores whatever workflow the model names.
    const run = await registered.get('dag_run')!.execute({
      workflowId: 'someone-elses-flow',
      inputs: {},
    } as never, exec) as { runId: string; status: string; nodes: { id: string; actor?: string }[] }

    assert.equal(run.status, 'completed')
    assert.equal(fake.specs[0]?.request.agentPreset, 'owner_agent')
    assert.equal(fake.specs[0]?.label, '意图分类员 (a)')
    assert.equal(run.nodes[0]?.actor, '意图分类员')

    const listed = await registered.get('list_runs')!.execute({ limit: 5 } as never, {} as never) as {
      runs: { runId: string; agentId?: string; workflowId: string; nodes: { id: string; status: string }[] }[]
    }
    assert.equal(listed.runs.length, 1)
    assert.equal(listed.runs[0]?.workflowId, 'owned')
    assert.equal(listed.runs[0]?.agentId, 'owner_agent')
    assert.deepEqual(listed.runs[0]?.nodes.map(node => [node.id, node.status]), [['a', 'completed']])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})


test('dag_run 未钉定 Agent 时使用节点声明的 agent，而不是 workflow id', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentops-dag-unpinned-'))
  try {
    writeFileSync(join(dir, 'unpinned.yaml'), [
      'workflow_id: unpinned-flow',
      'nodes:',
      '  a:',
      '    type: agent',
      '    agent: node_owner',
    ].join('\n'))
    const registered = new Map<string, { execute: (args: never, exec: never) => Promise<unknown> }>()
    const fake = fakeRuntime()
    const ctx = {
      tools: { register: (def: { name: string }) => { registered.set(def.name, def as never); return () => {} } },
      get: (key: string) => (key === 'subagents' ? fake.runtime : undefined),
    }
    apply(ctx as never, { workflowDir: dir, runDbPath: join(dir, 'runs.db') })

    const result = await registered.get('dag_run')!.execute(
      { workflowId: 'unpinned-flow', inputs: {} } as never,
      { agent: parent, signal: new AbortController().signal } as never,
    ) as { status: string }

    assert.equal(result.status, 'completed')
    assert.equal(fake.specs[0]?.request.agentPreset, 'node_owner')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('dag_run 允许被派发的 Agent 启动工作流，但拒绝工作流节点再进入', async () => {
  const registered = new Map<string, { execute: (args: never, exec: never) => Promise<unknown> }>()
  const ctx = {
    tools: { register: (def: { name: string }) => { registered.set(def.name, def as never); return () => {} } },
    get: (key: string) => (key === 'subagents' ? fakeRuntime().runtime : undefined),
  }
  apply(ctx as never, { provider: 'spawn' })

  // Dispatcher → business Agent (depth 1) is the normal path: this child is the
  // Agent that owns the workflow and must be able to start it.
  const dispatched = {
    session: { header: { id: 'agent-session', delegationDepth: 1 } },
    options: {},
  } as never
  const started = await registered.get('dag_run')!.execute({ yaml: YAML } as never, {
    agent: dispatched,
    signal: new AbortController().signal,
  } as never) as { status: string }
  assert.equal(started.status, 'completed')

  // A workflow node is a child of that Agent (depth 2) and inherits the same
  // preset that carries dag_run, so re-entry has to be refused.
  const node = {
    session: { header: { id: 'node-session', delegationDepth: 2 } },
    options: {},
  } as never
  await assert.rejects(
    () => registered.get('dag_run')!.execute({ yaml: YAML } as never, {
      agent: node,
      signal: new AbortController().signal,
    } as never),
    /dag_run 不能在工作流节点内调用/,
  )
})


test('subagent 执行器：command 节点明确失败且不启动子代理', async () => {
  const fake = fakeRuntime()
  const executor = createSubagentExecutor(fake.runtime, {}, () => parent)

  await assert.rejects(
    () => executor({
      id: 'execute_query',
      type: 'command',
      commandConfig: { cli_template: 'python missing.py' },
      after: [],
    }, { runId: 'r', inputs: {}, iteration: 1, upstream: {} }),
    /command.*尚未在 DSH 中执行/,
  )
  assert.deepEqual(fake.specs, [])
})

test('dag_run 返回终结节点输出，调用方不需要自己猜答案', async () => {
  const registered = new Map<string, { execute: (args: never, exec: never) => Promise<unknown> }>()
  const ctx = {
    tools: { register: (def: { name: string }) => { registered.set(def.name, def as never); return () => {} } },
    get: (key: string) => (key === 'subagents' ? fakeRuntime().runtime : undefined),
  }
  apply(ctx as never, { provider: 'spawn', maxUpstreamChars: 1000 })

  const result = await registered.get('dag_run')!.execute({
    yaml: [
      'workflow_id: answer-only',
      'nodes:',
      '  answer:',
      '    type: agent',
      '    agent: owner',
      '    outputs:',
      '      answer: ""',
    ].join('\n'),
  } as never, { agent: parent, signal: new AbortController().signal } as never) as {
    outputs: Record<string, { answer?: string }>
  }

  assert.deepEqual(result.outputs, { answer: { answer: 'done:answer' } })
})

test('dag_validate / dag_run 挂载与执行', async () => {
  const registered = new Map<string, { execute: (args: never, exec: never) => Promise<unknown> }>()
  const { runtime, labels } = fakeRuntime()
  const ctx = {
    tools: { register: (def: { name: string }) => { registered.set(def.name, def as never); return () => {} } },
    get: (key: string) => (key === 'subagents' ? runtime : undefined),
  }
  apply(ctx as never, { provider: 'spawn', concurrency: 2, maxUpstreamChars: 1000 })

  const validate = registered.get('dag_validate')!
  const valid = await validate.execute({ yaml: YAML } as never, {} as never) as { ok: boolean; levels: string[][] }
  assert.equal(valid.ok, true)
  assert.deepEqual(valid.levels, [['a'], ['b']])

  const run = registered.get('dag_run')!
  const result = await run.execute({ yaml: YAML } as never, {
    agent: parent, signal: new AbortController().signal,
  } as never) as { status: string; nodes: { id: string; status: string }[] }
  assert.equal(result.status, 'completed')
  assert.deepEqual(result.nodes.map(n => n.status), ['completed', 'completed'])
  assert.deepEqual(labels, ['a', 'b'])
})

test('dag_catalog：列出工作流描述、输入、节点数与校验状态', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentops-dag-catalog-'))
  try {
    writeFileSync(join(dir, 'smart-query.yaml'), [
      'workflow_id: smart-query',
      'name: 智能问数',
      'description: 从白名单数据源回答业务问题',
      'inputs:',
      '  - name: question',
      '    type: string',
      '    required: true',
      'nodes:',
      '  answer:',
      '    type: agent',
      '    agent: smart_query',
    ].join('\n'))

    const registered = new Map<string, { execute: (args: never, exec: never) => Promise<unknown> }>()
    const ctx = {
      tools: { register: (def: { name: string }) => { registered.set(def.name, def as never); return () => {} } },
      get: () => undefined,
    }
    apply(ctx as never, { workflowDir: dir })

    const catalog = await registered.get('dag_catalog')!.execute({} as never, {} as never) as {
      workflowDir: string
      workflows: {
        id: string
        name: string
        description?: string
        nodeCount: number
        ok: boolean
        inputs: { name: string }[]
      }[]
    }
    assert.equal(catalog.workflowDir, dir)
    assert.equal(catalog.workflows.length, 1)
    assert.equal(catalog.workflows[0]?.id, 'smart-query')
    assert.equal(catalog.workflows[0]?.name, '智能问数')
    assert.equal(catalog.workflows[0]?.description, '从白名单数据源回答业务问题')
    assert.equal(catalog.workflows[0]?.nodeCount, 1)
    assert.equal(catalog.workflows[0]?.ok, true)
    assert.deepEqual(catalog.workflows[0]?.inputs.map(input => input.name), ['question'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('dag_catalog：缺 workflowDir 或目录不存在时明确失败', async () => {
  const registered = new Map<string, { execute: (args: never, exec: never) => Promise<unknown> }>()
  const ctx = {
    tools: { register: (def: { name: string }) => { registered.set(def.name, def as never); return () => {} } },
    get: () => undefined,
  }
  apply(ctx as never, {})
  await assert.rejects(
    () => registered.get('dag_catalog')!.execute({} as never, {} as never),
    /必须配置 workflowDir/,
  )

  const missing = join(tmpdir(), `agentops-catalog-missing-${Date.now()}`)
  const missingRegistered = new Map<string, { execute: (args: never, exec: never) => Promise<unknown> }>()
  apply({
    tools: { register: (def: { name: string }) => { missingRegistered.set(def.name, def as never); return () => {} } },
    get: () => undefined,
  } as never, { workflowDir: missing })
  await assert.rejects(
    () => missingRegistered.get('dag_catalog')!.execute({} as never, {} as never),
    /工作流目录不存在/,
  )
})

test('dag_run 缺父 Agent 时明确拒绝', async () => {
  const registered = new Map<string, { execute: (args: never, exec: never) => Promise<unknown> }>()
  const { runtime } = fakeRuntime()
  const ctx = {
    tools: { register: (def: { name: string }) => { registered.set(def.name, def as never); return () => {} } },
    get: () => runtime,
  }
  apply(ctx as never, {})
  await assert.rejects(
    () => registered.get('dag_run')!.execute({ yaml: YAML } as never, { signal: new AbortController().signal } as never),
    /父 Agent/,
  )
})

test('dag_run 按 workflowId 加载定义、预先生成 runId 并持久化运行输入', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentops-dag-run-'))
  try {
    writeFileSync(join(dir, 'input-flow.yaml'), [
      'workflow_id: input-flow',
      'inputs:',
      '  - name: topic',
      '    type: string',
      '    required: true',
      'nodes:',
      '  a:',
      '    type: agent',
      '    agent: workflow_owner',
    ].join('\n'))
    const db = join(dir, 'runs.db')
    const registered = new Map<string, { execute: (args: never, exec: never) => Promise<unknown> }>()
    const fake = fakeRuntime()
    const ctx = {
      tools: { register: (def: { name: string }) => { registered.set(def.name, def as never); return () => {} } },
      get: (key: string) => (key === 'subagents' ? fake.runtime : undefined),
    }
    apply(ctx as never, {
      workflowDir: dir,
      runDbPath: db,
      provider: 'spawn',
      concurrency: 1,
      maxUpstreamChars: 1000,
    })

    const result = await registered.get('dag_run')!.execute({
      workflowId: 'input-flow',
      inputs: { topic: '迁移' },
    } as never, {
      agent: parent,
      signal: new AbortController().signal,
    } as never) as { runId: string; status: string; historyError?: string }

    assert.match(result.runId, /^input-flow@/)
    assert.equal(result.status, 'completed')
    assert.equal(result.historyError, undefined)
    assert.match(fake.prompts[0] ?? '', /迁移/)
    const store = new SqliteRunStore(db)
    try {
      const record = store.loadRecord(result.runId)!
      assert.equal(record.workflowId, 'input-flow')
      assert.deepEqual(record.state.inputs, { topic: '迁移' })
    } finally {
      store.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('dag_run 要求 workflowId 与 yaml 二选一', async () => {
  const registered = new Map<string, { execute: (args: never, exec: never) => Promise<unknown> }>()
  const fake = fakeRuntime()
  const ctx = {
    tools: { register: (def: { name: string }) => { registered.set(def.name, def as never); return () => {} } },
    get: (key: string) => (key === 'subagents' ? fake.runtime : undefined),
  }
  apply(ctx as never, {})
  const run = registered.get('dag_run')!
  const exec = { agent: parent, signal: new AbortController().signal } as never

  await assert.rejects(
    () => run.execute({ workflowId: 'linear', yaml: YAML } as never, exec),
    /只能提供一个/,
  )
  await assert.rejects(() => run.execute({} as never, exec), /必须提供 workflowId 或 yaml/)
  assert.deepEqual(fake.labels, [])
})

test('dag_run 拒绝未知工作流与未声明输入，且不启动子代理', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentops-dag-run-'))
  try {
    writeFileSync(join(dir, 'input-flow.yaml'), [
      'workflow_id: input-flow',
      'inputs:',
      '  - name: topic',
      '    type: string',
      '    required: true',
      'nodes:',
      '  a:',
      '    type: agent',
      '    agent: workflow_owner',
    ].join('\n'))
    const registered = new Map<string, { execute: (args: never, exec: never) => Promise<unknown> }>()
    const fake = fakeRuntime()
    const ctx = {
      tools: { register: (def: { name: string }) => { registered.set(def.name, def as never); return () => {} } },
      get: (key: string) => (key === 'subagents' ? fake.runtime : undefined),
    }
    apply(ctx as never, { workflowDir: dir })
    const run = registered.get('dag_run')!
    const exec = { agent: parent, signal: new AbortController().signal } as never

    await assert.rejects(
      () => run.execute({ workflowId: 'missing', inputs: {} } as never, exec),
      /未知工作流/,
    )
    await assert.rejects(
      () => run.execute({ workflowId: 'input-flow', inputs: { topic: '迁移', extra: true } } as never, exec),
      /未知输入参数/,
    )
    assert.deepEqual(fake.labels, [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('dag_run 历史保存失败时仍返回执行结果并明确报告历史错误', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentops-dag-run-'))
  try {
    const blocker = join(dir, 'not-a-directory')
    writeFileSync(blocker, 'x')
    const registered = new Map<string, { execute: (args: never, exec: never) => Promise<unknown> }>()
    const fake = fakeRuntime()
    const ctx = {
      tools: { register: (def: { name: string }) => { registered.set(def.name, def as never); return () => {} } },
      get: (key: string) => (key === 'subagents' ? fake.runtime : undefined),
    }
    apply(ctx as never, { runDbPath: join(blocker, 'runs.db') })

    const result = await registered.get('dag_run')!.execute({ yaml: YAML } as never, {
      agent: parent,
      signal: new AbortController().signal,
    } as never) as { status: string; historyError?: string }

    assert.equal(result.status, 'completed')
    assert.match(result.historyError ?? '', /运行历史(打开|保存)失败/)
    assert.deepEqual(fake.labels, ['a', 'b'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('dag_rerun 复用 runId 与 inputs，重跑节点并保留上游输出', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentops-dag-rerun-'))
  try {
    writeFileSync(join(dir, 'rerun-flow.yaml'), RERUN_YAML)
    const db = join(dir, 'runs.db')
    const registered = new Map<string, { execute: (args: never, exec: never) => Promise<unknown> }>()
    const fake = fakeRuntime()
    const ctx = {
      tools: { register: (def: { name: string }) => { registered.set(def.name, def as never); return () => {} } },
      get: (key: string) => (key === 'subagents' ? fake.runtime : undefined),
    }
    apply(ctx as never, {
      workflowDir: dir,
      runDbPath: db,
      provider: 'spawn',
      concurrency: 1,
      maxUpstreamChars: 1000,
    })
    const exec = { agent: parent, signal: new AbortController().signal } as never
    const first = await registered.get('dag_run')!.execute({
      workflowId: 'rerun-flow',
      inputs: { topic: '初版' },
    } as never, exec) as { runId: string }

    const rerun = await registered.get('dag_rerun')!.execute({
      runId: first.runId,
      workflowId: 'rerun-flow',
      nodeId: 'b',
      onlyNode: false,
      inputs: { topic: '迁移' },
    } as never, exec) as { runId: string; status: string; nodeId: string; historyError?: string }

    assert.equal(rerun.runId, first.runId)
    assert.equal(rerun.status, 'completed')
    assert.equal(rerun.nodeId, 'b')
    assert.equal(rerun.historyError, undefined)
    assert.deepEqual(fake.labels, ['a', 'b', 'b'])
    assert.match(fake.prompts.at(-1) ?? '', /迁移/)
    assert.match(fake.prompts.at(-1) ?? '', /done:a/)

    const store = new SqliteRunStore(db)
    try {
      const record = store.loadRecord(first.runId)!
      assert.equal(record.workflowId, 'rerun-flow')
      assert.deepEqual(record.state.inputs, { topic: '迁移' })
      assert.equal(record.state.nodes.a?.attempts, 1)
      assert.equal(record.state.nodes.b?.attempts, 2)
    } finally {
      store.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('dag_rerun 缺父 Agent 时拒绝且不改变历史', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentops-dag-rerun-'))
  try {
    writeFileSync(join(dir, 'rerun-flow.yaml'), RERUN_YAML)
    const db = join(dir, 'runs.db')
    const registered = new Map<string, { execute: (args: never, exec: never) => Promise<unknown> }>()
    const fake = fakeRuntime()
    const ctx = {
      tools: { register: (def: { name: string }) => { registered.set(def.name, def as never); return () => {} } },
      get: (key: string) => (key === 'subagents' ? fake.runtime : undefined),
    }
    apply(ctx as never, { workflowDir: dir, runDbPath: db })
    const first = await registered.get('dag_run')!.execute({
      workflowId: 'rerun-flow',
      inputs: { topic: '初版' },
    } as never, { agent: parent, signal: new AbortController().signal } as never) as { runId: string }

    await assert.rejects(
      () => registered.get('dag_rerun')!.execute({
        runId: first.runId,
        workflowId: 'rerun-flow',
        nodeId: 'b',
        onlyNode: false,
        inputs: { topic: '迁移' },
      } as never, { signal: new AbortController().signal } as never),
      /父 Agent/,
    )

    const store = new SqliteRunStore(db)
    try {
      const record = store.loadRecord(first.runId)!
      assert.equal(record.state.status, 'completed')
      assert.deepEqual(record.state.inputs, { topic: '初版' })
      assert.equal(record.state.nodes.b?.attempts, 1)
    } finally {
      store.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('dag_rerun 拒绝 workflowId 不匹配、未知节点、运行中记录与非法输入', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentops-dag-rerun-'))
  try {
    writeFileSync(join(dir, 'rerun-flow.yaml'), RERUN_YAML)
    const db = join(dir, 'runs.db')
    const registered = new Map<string, { execute: (args: never, exec: never) => Promise<unknown> }>()
    const fake = fakeRuntime()
    const ctx = {
      tools: { register: (def: { name: string }) => { registered.set(def.name, def as never); return () => {} } },
      get: (key: string) => (key === 'subagents' ? fake.runtime : undefined),
    }
    apply(ctx as never, { workflowDir: dir, runDbPath: db })
    const run = registered.get('dag_run')!
    const rerun = registered.get('dag_rerun')!
    const exec = { agent: parent, signal: new AbortController().signal } as never
    const first = await run.execute({ workflowId: 'rerun-flow', inputs: { topic: '初版' } } as never, exec) as { runId: string }

    await assert.rejects(
      () => rerun.execute({
        runId: first.runId,
        workflowId: 'rerun-flow',
        nodeId: 'missing',
        onlyNode: false,
        inputs: { topic: '迁移' },
      } as never, exec),
      /不包含节点/,
    )
    await assert.rejects(
      () => rerun.execute({
        runId: first.runId,
        workflowId: 'rerun-flow',
        nodeId: 'b',
        onlyNode: false,
        inputs: { topic: '迁移', extra: true },
      } as never, exec),
      /未知输入参数/,
    )

    const store = new SqliteRunStore(db)
    try {
      const record = store.loadRecord(first.runId)!
      const running = {
        ...record.state,
        status: 'running' as const,
      }
      delete running.finishedAt
      store.save(running, 'rerun-flow')
      await assert.rejects(
        () => rerun.execute({
          runId: first.runId,
          workflowId: 'rerun-flow',
          nodeId: 'b',
          onlyNode: false,
          inputs: { topic: '迁移' },
        } as never, exec),
        /仍在执行/,
      )
      store.save({
        ...record.state,
        runId: 'rerun-flow@mismatch',
        status: 'completed',
      }, 'other-workflow')
    } finally {
      store.close()
    }
    await assert.rejects(
      () => rerun.execute({
        runId: 'rerun-flow@mismatch',
        workflowId: 'rerun-flow',
        nodeId: 'b',
        onlyNode: false,
        inputs: { topic: '迁移' },
      } as never, exec),
      /workflowId.*不匹配|工作流.*不匹配/,
    )
    assert.equal(fake.labels.filter(label => label === 'b').length, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('dag_rerun 最终历史保存失败时仍返回重跑结果并报告错误', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentops-dag-rerun-'))
  try {
    writeFileSync(join(dir, 'rerun-flow.yaml'), RERUN_YAML)
    const db = join(dir, 'runs.db')
    const registered = new Map<string, { execute: (args: never, exec: never) => Promise<unknown> }>()
    let sabotage = false
    const fake = fakeRuntime((label) => {
      if (sabotage && label === 'b') {
        const external = new DatabaseSync(db)
        try {
          external.exec('DROP TABLE run_nodes')
        } finally {
          external.close()
        }
      }
      return { text: JSON.stringify({ out: `done:${label}` }) }
    })
    const ctx = {
      tools: { register: (def: { name: string }) => { registered.set(def.name, def as never); return () => {} } },
      get: (key: string) => (key === 'subagents' ? fake.runtime : undefined),
    }
    apply(ctx as never, { workflowDir: dir, runDbPath: db, concurrency: 1 })
    const exec = { agent: parent, signal: new AbortController().signal } as never
    const first = await registered.get('dag_run')!.execute({
      workflowId: 'rerun-flow',
      inputs: { topic: '初版' },
    } as never, exec) as { runId: string }

    sabotage = true
    const rerun = await registered.get('dag_rerun')!.execute({
      runId: first.runId,
      workflowId: 'rerun-flow',
      nodeId: 'b',
      onlyNode: false,
      inputs: { topic: '迁移' },
    } as never, exec) as { status: string; historyError?: string }

    assert.equal(rerun.status, 'completed')
    assert.match(rerun.historyError ?? '', /运行历史保存失败/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('dag_run 绑定工作流时，inputs 参数按声明生成而不是空对象', () => {
  const pinnedSchema = inputsParameter([
    { name: 'question', type: 'string', required: true, description: '用户问题' },
    { name: 'database', type: 'string', required: false },
  ]) as ObjectValueSchemaSpec
  assert.equal(pinnedSchema.additionalProperties, false)
  assert.deepEqual(pinnedSchema.properties?.question, { type: 'string', required: true, description: '用户问题' })
  assert.deepEqual(pinnedSchema.properties?.database, { type: 'string' })
  assert.match(pinnedSchema.description ?? '', /question（必填）/)
  assert.match(pinnedSchema.description ?? '', /database（可选）/)

  const open = inputsParameter(undefined)
  const openSchema = open as ObjectValueSchemaSpec
  assert.equal(openSchema.additionalProperties, true)
  assert.equal(openSchema.properties, undefined)
})

test('dag_run 的交付渲染把 answer 原文交给模型', () => {
  const text = deliveryText({
    present_result: { answer: '## 本周 304 笔' },
    audit: { ok: true, rows: 3 },
  })
  assert.match(text, /\[present_result\.answer\]\n## 本周 304 笔/)
  assert.match(text, /\[audit\.ok\]\ntrue/)
  assert.match(text, /\[audit\.rows\]\n3/)
  assert.equal(deliveryText({}), '本次运行没有产生终结节点交付。')
})
