import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

import { parseWorkflowYaml, WorkflowParseError } from '../src/load.ts'
import {
  buildWorkflowRunPrompt,
  createWorkflowRunHandler,
  createWorkflowRunHint,
  createWorkflowRunHintHandler,
  resolveWorkflowRunInputs,
  type WorkflowSessionController,
} from '../src/workflow-run.ts'

const INPUTS_YAML = `
workflow_id: log-patrol
inputs:
  - name: label
    type: string
    required: false
    default: ""
  - name: count
    type: integer
    required: false
    default: "60"
  - name: ratio
    type: number
    required: false
    default: "1.5"
  - name: enabled
    type: boolean
    required: true
    default: "false"
  - name: tags
    type: array
    required: false
    default: '["a", "b"]'
nodes:
  scan:
    type: agent
    agent: workflow_owner
`

function readPromptText(part: { readonly type: string; readonly text?: string } | undefined): string {
  if (part?.type !== 'text' || part.text === undefined) throw new Error('expected a text prompt')
  return part.text
}

function inputYaml(definition: string): string {
  return `workflow_id: invalid-input\ninputs:\n  - name: value\n${definition}\nnodes:\n  scan:\n    type: agent\n    agent: workflow_owner\n`
}

function jsonRequest(body: string): Request {
  return new Request('http://host/api/agentops/workflow-run', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  })
}

void test('YAML inputs：省略时为空，五种类型按声明顺序保留', () => {
  assert.deepEqual(parseWorkflowYaml('workflow_id: plain\nnodes:\n  a:\n    type: agent\n    agent: workflow_owner\n').inputs, [])
  assert.deepEqual(parseWorkflowYaml(INPUTS_YAML).inputs, [
    { name: 'label', type: 'string', required: false, default: '' },
    { name: 'count', type: 'integer', required: false, default: 60 },
    { name: 'ratio', type: 'number', required: false, default: 1.5 },
    { name: 'enabled', type: 'boolean', required: true, default: false },
    { name: 'tags', type: 'array', required: false, default: ['a', 'b'] },
  ])
  const optional = parseWorkflowYaml(inputYaml('    type: string'))
  assert.equal(optional.inputs[0]?.required, false)
})

void test('YAML inputs：名称唯一，未知字段与非法默认值在解析期失败', () => {
  const duplicate = [
    'workflow_id: duplicate',
    'inputs:',
    '  - name: value',
    '    type: string',
    '  - name: value',
    '    type: integer',
    'nodes:',
    '  a:',
    '    type: agent',
    '    agent: workflow_owner',
  ].join('\n')
  assert.throws(() => parseWorkflowYaml(duplicate), /重复/)
  assert.throws(() => parseWorkflowYaml(inputYaml('    type: string\n    extra: true')), /未知字段/)
  assert.throws(() => parseWorkflowYaml(inputYaml('    type: unknown')), /type/)
  assert.throws(() => parseWorkflowYaml(inputYaml('    type: string\n    required: yes')), /required/)

  const invalidDefaults = [
    '    type: integer\n    default: 1.5',
    '    type: integer\n    default: nope',
    '    type: number\n    default: .inf',
    '    type: boolean\n    default: "yes"',
    '    type: array\n    default: { a: 1 }',
    '    type: array\n    default: not-json',
  ]
  for (const definition of invalidDefaults) {
    assert.throws(() => parseWorkflowYaml(inputYaml(definition)), WorkflowParseError)
  }
})

void test('运行输入：合并默认值，按 YAML 顺序保留 false、0 与空字符串', () => {
  const workflow = parseWorkflowYaml(INPUTS_YAML)
  const result = resolveWorkflowRunInputs(workflow, {
    tags: [],
    enabled: false,
    count: 0,
    label: '',
  })
  assert.deepEqual(result, {
    ok: true,
    values: { label: '', count: 0, ratio: 1.5, enabled: false, tags: [] },
  })
  assert.equal(
    buildWorkflowRunPrompt(workflow.id, result.ok ? result.values : {}),
    [
      '请用 dag_run 工具运行 AgentOps 工作流 log-patrol。',
      '运行输入（JSON）：',
      '{"label":"","count":0,"ratio":1.5,"enabled":false,"tags":[]}',
      '执行完把每个节点的状态与产物摘要告诉我。',
    ].join('\n'),
  )
})

void test('运行输入：严格校验类型、必填、未知参数与有限数值', () => {
  const workflow = parseWorkflowYaml(INPUTS_YAML)
  const cases: readonly unknown[] = [
    null,
    [],
    { enabled: false, extra: true },
    { enabled: false, count: '1' },
    { enabled: false, count: 1.5 },
    { enabled: false, count: Number.POSITIVE_INFINITY },
    { enabled: false, tags: {} },
    { enabled: false, label: 1 },
  ]
  for (const submitted of cases) {
    const result = resolveWorkflowRunInputs(workflow, submitted)
    assert.equal(result.ok, false, JSON.stringify(submitted))
  }

  const required = parseWorkflowYaml([
    'workflow_id: required',
    'inputs:',
    '  - name: name',
    '    type: string',
    '    required: true',
    'nodes:',
    '  a:',
    '    type: agent',
    '    agent: workflow_owner',
  ].join('\n'))
  assert.equal(resolveWorkflowRunInputs(required, {}).ok, false)
  assert.equal(resolveWorkflowRunInputs(required, { name: '' }).ok, false)
  assert.equal(resolveWorkflowRunInputs(required, { name: '   ' }).ok, false)
  assert.equal(resolveWorkflowRunInputs(required, { name: 'x' }).ok, true)
})

void test('运行输入：数组默认值与提交值必须是严格递归 JSON', () => {
  const workflow = {
    inputs: [{
      name: 'tags',
      type: 'array' as const,
      required: false,
      default: [new Date()],
    }],
  }
  assert.equal(resolveWorkflowRunInputs(workflow, {}).ok, false)
  assert.equal(resolveWorkflowRunInputs(workflow, { tags: [Number.POSITIVE_INFINITY] }).ok, false)
  assert.equal(resolveWorkflowRunInputs(workflow, { tags: [{ nested: undefined }] }).ok, false)
  assert.equal(resolveWorkflowRunInputs(workflow, { tags: [null, 'ok', 1, true, { nested: [] }] }).ok, true)
})

void test('运行 prompt：无输入保持旧文案', () => {
  assert.equal(
    buildWorkflowRunPrompt('plain', {}),
    '请用 dag_run 工具运行 AgentOps 工作流 plain，执行完把每个节点的状态与产物摘要告诉我。',
  )
})

void test('hint：返回输入声明与包含默认值的稳定 prompt', () => {
  const workflow = parseWorkflowYaml(INPUTS_YAML)
  const hint = createWorkflowRunHint(workflow)
  assert.equal(hint.workflowId, 'log-patrol')
  assert.deepEqual(hint.inputs, workflow.inputs)
  assert.match(hint.prompt, /"count":60/)
  assert.match(hint.prompt, /"enabled":false/)
})

void test('run 路由：非对象 JSON 与缺失 workflowId 返回 400', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentops-run-route-'))
  try {
    writeFileSync(join(dir, 'log-patrol.yaml'), INPUTS_YAML)
    const handler = createWorkflowRunHandler(dir, undefined)
    assert.equal((await handler(jsonRequest('null'))).status, 400)
    assert.equal((await handler(jsonRequest('[]'))).status, 400)
    assert.equal((await handler(jsonRequest('{'))).status, 400)
    assert.equal((await handler(jsonRequest('{}'))).status, 400)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

void test('run 路由：未知工作流 404、非法输入 422、缺控制器 503', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentops-run-route-'))
  try {
    writeFileSync(join(dir, 'log-patrol.yaml'), INPUTS_YAML)
    const handler = createWorkflowRunHandler(dir, undefined)
    assert.equal((await handler(jsonRequest('{"workflowId":"missing"}'))).status, 404)
    const invalid = await handler(jsonRequest('{"workflowId":"log-patrol","inputs":{"enabled":"false"}}'))
    assert.equal(invalid.status, 422)
    const valid = await handler(jsonRequest('{"workflowId":"log-patrol","inputs":{"enabled":false}}'))
    assert.equal(valid.status, 503)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

void test('run 路由：按声明顺序生成 prompt，启动一次会话并返回 workflowId', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentops-run-route-'))
  try {
    writeFileSync(join(dir, 'log-patrol.yaml'), INPUTS_YAML)
    const prompts: string[] = []
    const controller: WorkflowSessionController = {
      async create(request) {
        assert.deepEqual(request, { agentPreset: 'agentops' })
        return { sessionId: brandString<SessionId>('session-1') }
      },
      async prompt(request) {
        prompts.push(readPromptText(request.content[0]))
        return { accepted: true }
      },
    }
    const response = await createWorkflowRunHandler(dir, controller)(jsonRequest(JSON.stringify({
      workflowId: 'log-patrol',
      inputs: { tags: [], enabled: false, count: 0, label: '' },
    })))
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { ok: true, sessionId: 'session-1', workflowId: 'log-patrol' })
    assert.deepEqual(prompts, [[
      '请用 dag_run 工具运行 AgentOps 工作流 log-patrol。',
      '运行输入（JSON）：',
      '{"label":"","count":0,"ratio":1.5,"enabled":false,"tags":[]}',
      '执行完把每个节点的状态与产物摘要告诉我。',
    ].join('\n')])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

void test('run 路由：无 inputs 保留旧运行文案；hint 路由返回 JSON 或 404', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentops-run-route-'))
  try {
    writeFileSync(join(dir, 'plain.yaml'), 'workflow_id: plain\nnodes:\n  a:\n    type: agent\n    agent: workflow_owner\n')
    let promptText = ''
    const controller: WorkflowSessionController = {
      async create() { return { sessionId: brandString<SessionId>('session-plain') } },
      async prompt(request) {
        promptText = readPromptText(request.content[0])
        return { accepted: true }
      },
    }
    const response = await createWorkflowRunHandler(dir, controller)(jsonRequest('{"workflowId":"plain"}'))
    assert.equal(response.status, 200)
    assert.equal(promptText, '请用 dag_run 工具运行 AgentOps 工作流 plain，执行完把每个节点的状态与产物摘要告诉我。')

    const hintHandler = createWorkflowRunHintHandler(dir)
    const hint = await hintHandler(new Request('http://host/api/agentops/workflow-run-hint?id=plain'))
    assert.equal(hint.status, 200)
    assert.deepEqual(await hint.json(), {
      workflowId: 'plain',
      prompt: promptText,
      reason: 'DSH 的 subagents 要求活跃父 Agent，工作流只能在会话里由 Agent 调用 dag_run 执行；页面只提供运行指令。',
      inputs: [],
    })
    const missing = await hintHandler(new Request('http://host/api/agentops/workflow-run-hint?id=missing'))
    assert.equal(missing.status, 404)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

void test('run 路由：创建会话失败时不入队且不返回 sessionId', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentops-run-route-'))
  try {
    writeFileSync(join(dir, 'plain.yaml'), 'workflow_id: plain\nnodes:\n  a:\n    type: agent\n    agent: workflow_owner\n')
    let promptCalls = 0
    const controller: WorkflowSessionController = {
      async create() { throw new Error('create unavailable') },
      async prompt() {
        promptCalls += 1
        return { accepted: true }
      },
    }
    const response = await createWorkflowRunHandler(dir, controller)(jsonRequest('{"workflowId":"plain"}'))
    assert.equal(response.status, 503)
    assert.deepEqual(await response.json(), { ok: false, reason: 'create unavailable' })
    assert.equal(promptCalls, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

void test('run 路由：指令入队失败时返回已创建会话的 sessionId', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentops-run-route-'))
  try {
    writeFileSync(join(dir, 'plain.yaml'), 'workflow_id: plain\nnodes:\n  a:\n    type: agent\n    agent: workflow_owner\n')
    const controller: WorkflowSessionController = {
      async create() { return { sessionId: brandString<SessionId>('session-1') } },
      async prompt() { throw new Error('queue unavailable') },
    }
    const response = await createWorkflowRunHandler(dir, controller)(jsonRequest('{"workflowId":"plain"}'))
    assert.equal(response.status, 503)
    assert.deepEqual(await response.json(), {
      ok: false,
      reason: '会话 session-1 已创建，但运行指令入队失败：queue unavailable',
      sessionId: 'session-1',
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
