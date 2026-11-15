import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

import { SqliteRunStore } from '../src/run-store.ts'
import type { RunState } from '../src/types.ts'
import {
  buildWorkflowRerunPrompt,
  createWorkflowRerunHandler,
  registerWorkflowRerunRoute,
} from '../src/workflow-rerun.ts'
import type { WorkflowSessionController } from '../src/workflow-run.ts'

const YAML = `
workflow_id: rerun-flow
inputs:
  - name: topic
    type: string
    required: true
nodes:
  a:
    type: agent
    agent: workflow_owner
  b:
    type: agent
    agent: workflow_owner
    after: [a]
`

interface ErrorBody {
  error: {
    code: string
    message: string
    issues?: readonly string[]
  }
  sessionId?: string
}

interface SuccessBody {
  ok: true
  sessionId: string
  runId: string
  workflowId: string
  nodeId: string
  onlyNode: boolean
}

function state(runId: string, status: RunState['status'], inputs: Record<string, unknown> = { topic: '初版' }): RunState {
  return {
    runId,
    status,
    inputs,
    nodes: {
      a: { status: 'completed', attempts: 1, outputs: { text: 'done:a' } },
      b: { status: 'completed', attempts: 1, outputs: { text: 'done:b' } },
    },
    startedAt: '2026-10-31T00:00:00.000Z',
    ...(status === 'running' ? {} : { finishedAt: '2026-10-31T00:00:02.000Z' }),
  }
}

function request(body: unknown): Request {
  return new Request('http://host/api/agentops/workflow-rerun', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function controller(
  onPrompt?: (text: string) => void,
): WorkflowSessionController {
  return {
    async create() {
      return { sessionId: brandString<SessionId>('session-rerun') }
    },
    async prompt(prompt) {
      const part = prompt.content[0]
      if (part?.type !== 'text' || part.text === undefined) throw new Error('missing prompt text')
      onPrompt?.(part.text)
      return { accepted: true }
    },
  }
}

void test('rerun prompt 固定传递节点、onlyNode 与按声明顺序解析的 inputs', () => {
  assert.equal(
    buildWorkflowRerunPrompt('rerun-flow', 'rerun-flow@1', 'b', false, { topic: '迁移' }),
    [
      '请用 dag_rerun 工具重跑 AgentOps 工作流 rerun-flow 的运行 rerun-flow@1 中的节点 b。',
      'onlyNode=false',
      '运行输入（JSON）：',
      '{"topic":"迁移"}',
      '执行完把每个节点的状态与产物摘要告诉我。',
    ].join('\n'),
  )
})

void test('rerun 路由严格校验必填字段、类型与未知字段', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentops-rerun-route-'))
  const store = new SqliteRunStore(join(dir, 'runs.db'))
  try {
    writeFileSync(join(dir, 'rerun-flow.yaml'), YAML)
    store.save(state('rerun-flow@1', 'completed'), 'rerun-flow')
    let prompts = 0
    const handler = createWorkflowRerunHandler(dir, store, () => controller(() => { prompts += 1 }))
    const valid = {
      runId: 'rerun-flow@1',
      workflowId: 'rerun-flow',
      nodeId: 'b',
      onlyNode: false,
      inputs: { topic: '迁移' },
    }
    const cases: readonly unknown[] = [
      [],
      { ...valid, runId: undefined },
      { ...valid, runId: '' },
      { ...valid, workflowId: 1 },
      { ...valid, nodeId: null },
      { ...valid, onlyNode: 'false' },
      { ...valid, inputs: [] },
      { ...valid, unexpected: true },
    ]
    for (const body of cases) {
      const response = await handler(request(body))
      assert.equal(response.status, 400, JSON.stringify(body))
      assert.equal((await response.json() as ErrorBody).error.code, 'invalid_request')
    }
    assert.equal(prompts, 0)
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

void test('rerun 路由区分 unknown_run、workflow_mismatch、node_missing、run_running 与 invalid_inputs', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentops-rerun-route-'))
  const store = new SqliteRunStore(join(dir, 'runs.db'))
  try {
    writeFileSync(join(dir, 'rerun-flow.yaml'), YAML)
    store.save(state('rerun-flow@complete', 'completed'), 'rerun-flow')
    store.save(state('rerun-flow@other', 'completed'), 'other-workflow')
    store.save(state('rerun-flow@running', 'running'), 'rerun-flow')
    const handler = createWorkflowRerunHandler(dir, store, () => controller())
    const base = {
      workflowId: 'rerun-flow',
      nodeId: 'b',
      onlyNode: false,
      inputs: { topic: '迁移' },
    }

    const unknown = await handler(request({ ...base, runId: 'missing' }))
    assert.equal(unknown.status, 404)
    assert.equal((await unknown.json() as ErrorBody).error.code, 'unknown_run')

    const mismatch = await handler(request({ ...base, runId: 'rerun-flow@other' }))
    assert.equal(mismatch.status, 409)
    assert.equal((await mismatch.json() as ErrorBody).error.code, 'workflow_mismatch')

    const node = await handler(request({ ...base, runId: 'rerun-flow@complete', nodeId: 'missing' }))
    assert.equal(node.status, 404)
    assert.equal((await node.json() as ErrorBody).error.code, 'node_missing')

    const running = await handler(request({ ...base, runId: 'rerun-flow@running' }))
    assert.equal(running.status, 409)
    assert.equal((await running.json() as ErrorBody).error.code, 'run_running')

    const inputs = await handler(request({
      ...base,
      runId: 'rerun-flow@complete',
      inputs: { topic: '迁移', extra: true },
    }))
    assert.equal(inputs.status, 422)
    assert.equal((await inputs.json() as ErrorBody).error.code, 'invalid_inputs')
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

void test('rerun 路由创建会话并只返回已入队状态', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentops-rerun-route-'))
  const store = new SqliteRunStore(join(dir, 'runs.db'))
  try {
    writeFileSync(join(dir, 'rerun-flow.yaml'), YAML)
    store.save(state('rerun-flow@1', 'failed', { topic: '初版' }), 'rerun-flow')
    let promptText = ''
    const response = await createWorkflowRerunHandler(dir, store, () => controller((text) => {
      promptText = text
    }))(request({
      runId: 'rerun-flow@1',
      workflowId: 'rerun-flow',
      nodeId: 'b',
      onlyNode: true,
      inputs: { topic: '迁移' },
    }))

    assert.equal(response.status, 200)
    assert.deepEqual(await response.json() as SuccessBody, {
      ok: true,
      sessionId: 'session-rerun',
      runId: 'rerun-flow@1',
      workflowId: 'rerun-flow',
      nodeId: 'b',
      onlyNode: true,
    })
    assert.equal(promptText, buildWorkflowRerunPrompt(
      'rerun-flow',
      'rerun-flow@1',
      'b',
      true,
      { topic: '迁移' },
    ))
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

void test('rerun 路由无 controller 返回 503，创建与入队失败保留安全结果', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentops-rerun-route-'))
  const store = new SqliteRunStore(join(dir, 'runs.db'))
  try {
    writeFileSync(join(dir, 'rerun-flow.yaml'), YAML)
    store.save(state('rerun-flow@1', 'completed'), 'rerun-flow')
    const body = {
      runId: 'rerun-flow@1',
      workflowId: 'rerun-flow',
      nodeId: 'b',
      onlyNode: false,
      inputs: { topic: '迁移' },
    }

    const unavailable = await createWorkflowRerunHandler(dir, store, () => undefined)(request(body))
    assert.equal(unavailable.status, 503)
    assert.equal((await unavailable.json() as ErrorBody).error.code, 'session_unavailable')

    const createFailure: WorkflowSessionController = {
      async create() { throw new Error('create unavailable') },
      async prompt() { throw new Error('must not be called') },
    }
    const createResponse = await createWorkflowRerunHandler(dir, store, () => createFailure)(request(body))
    assert.equal(createResponse.status, 503)
    assert.equal((await createResponse.json() as ErrorBody).error.code, 'session_unavailable')

    const promptFailure: WorkflowSessionController = {
      async create() { return { sessionId: brandString<SessionId>('session-rerun') } },
      async prompt() { throw new Error('queue unavailable') },
    }
    const promptResponse = await createWorkflowRerunHandler(dir, store, () => promptFailure)(request(body))
    assert.equal(promptResponse.status, 503)
    const failure = await promptResponse.json() as ErrorBody
    assert.equal(failure.error.code, 'session_unavailable')
    assert.equal(failure.sessionId, 'session-rerun')
    assert.match(failure.error.message, /已创建.*入队失败/)
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

void test('workflow-rerun 路由即使 controller 当前不可用也完成注册', () => {
  const paths: string[] = []
  const ctx = {
    effect(create: () => () => void) {
      create()
      return () => {}
    },
    connection: {
      fetch: {
        register(options: { path: string }) {
          paths.push(options.path)
          return () => {}
        },
      },
    },
  }
  const store = new SqliteRunStore(':memory:')
  try {
    registerWorkflowRerunRoute(ctx as never, 'workflow-dir', store, () => undefined)
    assert.deepEqual(paths, ['/api/agentops/workflow-rerun'])
  } finally {
    store.close()
  }
})
