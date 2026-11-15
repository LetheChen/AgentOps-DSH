import { describe, expect, it } from 'vitest'

import {
  WorkflowEditorRequestError,
  createWorkflowSource,
  deleteWorkflowSource,
  editWorkflowSource,
  loadWorkflowCatalog,
  loadWorkflowRunHint,
  loadWorkflowSource,
  saveWorkflowSource,
  startWorkflow,
  validateWorkflowSource,
} from '../src/client/workflow-editor-api.js'

const GRAPH_NODES = [
  {
    id: 'scan',
    level: 0,
    agentRef: 'log_analyst',
    rolePrompt: 'scan logs',
    after: [],
    inputs: [],
    outputs: { records: ['analyze'] },
    timeoutMs: 30_000,
  },
  {
    id: 'analyze',
    level: 1,
    agentRef: 'log_analyst',
    rolePrompt: 'analyze records',
    after: ['scan'],
    inputs: ['records'],
    outputs: {},
  },
] as const

const COMPILED = {
  source: '// compiled workflow\n(async () => {})()',
  layers: [['scan'], ['analyze']],
  digest: 'compiled-digest',
} as const

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function requestBody(init: RequestInit | undefined): string {
  if (typeof init?.body !== 'string') throw new Error('expected a string request body')
  return init.body
}

describe('workflow editor API', () => {
  it('读取源码保留原始文本与 digest', async () => {
    const fetchImpl: typeof fetch = async () => jsonResponse({ text: 'a:\r\n  b: 1\r\n', digest: 'abc' })
    await expect(loadWorkflowSource('log-patrol', fetchImpl)).resolves.toEqual({
      text: 'a:\r\n  b: 1\r\n',
      digest: 'abc',
    })
  })

  it('校验响应解析完整图、调度边、数据边与 422 issues', async () => {
    const fetchImpl: typeof fetch = async (_input, init) => {
      const body = JSON.parse(requestBody(init)) as { text: string }
      if (body.text === 'broken') {
        return jsonResponse({
          ok: false,
          issues: [{ path: 'nodes', message: 'bad', line: 2, column: 4, kind: 'yaml' }],
        }, 422)
      }
      return jsonResponse({
        ok: true,
        issues: [],
        nodes: GRAPH_NODES,
        edges: [{ from: 'scan', to: 'analyze' }],
        dataEdges: [{ from: 'scan', to: 'analyze', port: 'records' }],
        compiled: COMPILED,
      })
    }

    await expect(validateWorkflowSource('ok', fetchImpl)).resolves.toEqual({
      ok: true,
      issues: [],
      nodes: GRAPH_NODES,
      edges: [{ from: 'scan', to: 'analyze' }],
      dataEdges: [{ from: 'scan', to: 'analyze', port: 'records' }],
      compiled: COMPILED,
    })
    await expect(validateWorkflowSource('broken', fetchImpl)).resolves.toEqual({
      ok: false,
      issues: [{ path: 'nodes', message: 'bad', line: 2, column: 4, kind: 'yaml' }],
    })
  })

  it('拒绝缺 dataEdges 或节点字段不完整的成功响应', async () => {
    const missingEdges: typeof fetch = async () => jsonResponse({
      ok: true,
      issues: [],
      nodes: GRAPH_NODES,
      edges: [],
    })
    await expect(validateWorkflowSource('ok', missingEdges)).rejects.toThrow(/invalid workflow graph response/i)

    const missingOutputs: typeof fetch = async () => jsonResponse({
      ok: true,
      issues: [],
      nodes: [{ id: 'scan', level: 0, rolePrompt: 'scan', after: [], inputs: [] }],
      edges: [],
      dataEdges: [],
    })
    await expect(validateWorkflowSource('ok', missingOutputs)).rejects.toThrow(/invalid workflow graph response/i)
  })

  it('允许图有效但尚未编译，并拒绝格式错误的 compiled', async () => {
    const graph = {
      ok: true,
      issues: [],
      nodes: GRAPH_NODES,
      edges: [],
      dataEdges: [],
    }
    const uncompiled: typeof fetch = async () => jsonResponse(graph)
    await expect(validateWorkflowSource('ok', uncompiled)).resolves.toEqual(graph)

    const malformed = [
      { ...graph, compiled: { ...COMPILED, source: 42 } },
      { ...graph, compiled: { ...COMPILED, digest: null } },
      { ...graph, compiled: { ...COMPILED, layers: 'scan' } },
      { ...graph, compiled: { ...COMPILED, layers: [['scan'], 'analyze'] } },
      { ...graph, compiled: { ...COMPILED, layers: [['scan'], [42]] } },
    ]

    for (const body of malformed) {
      const fetchImpl: typeof fetch = async () => jsonResponse(body)
      await expect(validateWorkflowSource('ok', fetchImpl))
        .rejects.toThrow(/invalid workflow compiled response/i)
    }
  })

  it('解析 await_command 完整配置，并为缺省字段补旧版默认值', async () => {
    const baseNode = {
      id: 'wait',
      level: 1,
      type: 'await_command',
      rolePrompt: '',
      after: ['scan'],
      inputs: [],
      outputs: {},
    } as const
    const fullConfig = {
      targetActors: ['scan', 'analyze'],
      commandPort: 'approval',
      expirySeconds: 3600,
      maxCommands: 3,
    }
    const fetchImpl: typeof fetch = async () => jsonResponse({
      ok: true,
      issues: [],
      nodes: [
        { ...baseNode, awaitCommandConfig: fullConfig },
        { ...baseNode, id: 'wait-defaults', awaitCommandConfig: {} },
      ],
      edges: [],
      dataEdges: [],
    })

    await expect(validateWorkflowSource('ok', fetchImpl)).resolves.toEqual({
      ok: true,
      issues: [],
      nodes: [
        { ...baseNode, awaitCommandConfig: fullConfig },
        {
          ...baseNode,
          id: 'wait-defaults',
          awaitCommandConfig: {
            targetActors: [],
            commandPort: 'command',
            expirySeconds: 86400,
            maxCommands: 10,
          },
        },
      ],
      edges: [],
      dataEdges: [],
    })
  })

  it('拒绝格式错误的 await_command 配置', async () => {
    const baseNode = {
      id: 'wait',
      level: 1,
      type: 'await_command',
      rolePrompt: '',
      after: [],
      inputs: [],
      outputs: {},
    } as const
    const malformed = [
      [],
      { targetActors: 'scan' },
      { targetActors: [''] },
      { targetActors: ['scan\0logs'] },
      { commandPort: '' },
      { commandPort: 'command\0port' },
      { expirySeconds: 1.5 },
      { expirySeconds: 0 },
      { maxCommands: true },
      { maxCommands: null },
    ]

    for (const awaitCommandConfig of malformed) {
      const fetchImpl: typeof fetch = async () => jsonResponse({
        ok: true,
        issues: [],
        nodes: [{ ...baseNode, awaitCommandConfig }],
        edges: [],
        dataEdges: [],
      })
      await expect(validateWorkflowSource('ok', fetchImpl))
        .rejects.toThrow(/invalid workflow graph response/i)
    }
  })

  it('await_command 编辑请求发送完整配置', async () => {
    let capturedBody = ''
    const operation = {
      kind: 'add-node',
      id: 'wait',
      type: 'await_command',
      targetActors: ['scan', 'analyze'],
      commandPort: 'approval',
      expirySeconds: 3600,
      maxCommands: 3,
    } as const
    const fetchImpl: typeof fetch = async (_input, init) => {
      capturedBody = requestBody(init)
      return jsonResponse({ ok: true, text: 'edited', issues: [] })
    }

    await expect(editWorkflowSource('before', operation, fetchImpl)).resolves.toEqual({
      ok: true,
      text: 'edited',
      issues: [],
    })
    expect(capturedBody).toBe(JSON.stringify({ text: 'before', operation }))
  })
  it('编辑请求只发送 text 与 operation，并解析回写文本和完整图', async () => {
    let capturedUrl = ''
    let capturedBody = ''
    let capturedMethod = ''
    const operation = { kind: 'add-schedule-edge', from: 'scan', to: 'analyze' } as const
    const fetchImpl: typeof fetch = async (input, init) => {
      capturedUrl = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      capturedBody = requestBody(init)
      capturedMethod = init?.method ?? ''
      return jsonResponse({
        ok: true,
        text: 'edited\r\n',
        issues: [],
        nodes: GRAPH_NODES,
        edges: [{ from: 'scan', to: 'analyze' }],
        dataEdges: [{ from: 'scan', to: 'analyze', port: 'records' }],
        compiled: COMPILED,
      })
    }

    await expect(editWorkflowSource('before\r\n', operation, fetchImpl)).resolves.toEqual({
      ok: true,
      text: 'edited\r\n',
      issues: [],
      nodes: GRAPH_NODES,
      edges: [{ from: 'scan', to: 'analyze' }],
      dataEdges: [{ from: 'scan', to: 'analyze', port: 'records' }],
      compiled: COMPILED,
    })
    expect(capturedUrl).toBe('/api/agentops/workflow-edit')
    expect(capturedMethod).toBe('POST')
    expect(capturedBody).toBe(JSON.stringify({ text: 'before\r\n', operation }))
  })

  it('编辑的 400 与 422 都返回结构化 issues，其它状态抛请求错误', async () => {
    const issue = { path: 'nodes.scan', message: '节点不存在', kind: 'operation' }
    const badRequest: typeof fetch = async () => jsonResponse({ ok: false, issues: [issue] }, 400)
    await expect(editWorkflowSource('text', { kind: 'remove-node', id: 'scan' }, badRequest)).resolves.toEqual({
      ok: false,
      issues: [issue],
    })

    const invalid: typeof fetch = async () => jsonResponse({ ok: false, issues: [issue] }, 422)
    await expect(editWorkflowSource('text', { kind: 'remove-node', id: 'scan' }, invalid)).resolves.toEqual({
      ok: false,
      issues: [issue],
    })

    const failed: typeof fetch = async () => jsonResponse({ error: 'internal' }, 500)
    await expect(editWorkflowSource('text', { kind: 'remove-node', id: 'scan' }, failed))
      .rejects.toBeInstanceOf(WorkflowEditorRequestError)
  })

  it('保存发送原始草稿与 expectedDigest，并返回新 digest', async () => {
    let capturedBody = ''
    let capturedMethod = ''
    const fetchImpl: typeof fetch = async (_input, init) => {
      capturedBody = requestBody(init)
      capturedMethod = init?.method ?? ''
      return jsonResponse({ digest: 'next' })
    }

    await expect(saveWorkflowSource('log-patrol', 'a:\r\n  b: 1\r\n', 'base', fetchImpl)).resolves.toEqual({
      kind: 'saved',
      digest: 'next',
    })
    expect(capturedMethod).toBe('POST')
    expect(capturedBody).toBe(JSON.stringify({
      workflowId: 'log-patrol',
      text: 'a:\r\n  b: 1\r\n',
      expectedDigest: 'base',
    }))
  })

  it('409 返回磁盘上的 actual digest，422 返回 issues', async () => {
    const conflictFetch: typeof fetch = async () => jsonResponse({ actualDigest: 'disk' }, 409)
    await expect(saveWorkflowSource('log-patrol', 'draft', 'base', conflictFetch)).resolves.toEqual({
      kind: 'conflict',
      actualDigest: 'disk',
    })

    const invalidFetch: typeof fetch = async () => jsonResponse({
      ok: false,
      issues: [{ path: 'nodes[0].after', message: 'cycle', kind: 'cycle', nodeIds: ['a', 'b'] }],
    }, 422)
    await expect(saveWorkflowSource('log-patrol', 'draft', 'base', invalidFetch)).resolves.toEqual({
      kind: 'invalid',
      issues: [{ path: 'nodes[0].after', message: 'cycle', kind: 'cycle', nodeIds: ['a', 'b'] }],
    })
  })

  it('创建发送 workflowId 与完整原文，并解析成功、冲突和校验失败', async () => {
    let capturedBody = ''
    let capturedMethod = ''
    const createdFetch: typeof fetch = async (_input, init) => {
      capturedBody = requestBody(init)
      capturedMethod = init?.method ?? ''
      return jsonResponse({ digest: 'created-digest' }, 201)
    }
    await expect(createWorkflowSource('demo', 'workflow_id: demo\nnodes: []\n', createdFetch))
      .resolves.toEqual({ kind: 'created', digest: 'created-digest' })
    expect(capturedMethod).toBe('POST')
    expect(capturedBody).toBe(JSON.stringify({
      workflowId: 'demo',
      text: 'workflow_id: demo\nnodes: []\n',
    }))

    const conflictFetch: typeof fetch = async () => jsonResponse({ error: 'workflow already exists' }, 409)
    await expect(createWorkflowSource('demo', 'draft', conflictFetch)).resolves.toEqual({ kind: 'conflict' })

    const invalidFetch: typeof fetch = async () => jsonResponse({
      ok: false,
      issues: [{ path: 'nodes', message: 'empty' }],
    }, 422)
    await expect(createWorkflowSource('demo', 'draft', invalidFetch)).resolves.toEqual({
      kind: 'invalid',
      issues: [{ path: 'nodes', message: 'empty' }],
    })
  })

  it('创建拒绝畸形成功响应，并把 400 作为请求失败', async () => {
    const malformed: typeof fetch = async () => jsonResponse({ ok: true }, 201)
    await expect(createWorkflowSource('demo', 'draft', malformed))
      .rejects.toThrow(/invalid workflow create response/i)

    const badRequest: typeof fetch = async () => jsonResponse({ error: 'invalid workflow id' }, 400)
    await expect(createWorkflowSource('../bad', 'draft', badRequest))
      .rejects.toBeInstanceOf(WorkflowEditorRequestError)
  })

  it('拒绝缺字段的 wire 响应', async () => {
    const fetchImpl: typeof fetch = async () => jsonResponse({ text: 'missing digest' })
    await expect(loadWorkflowSource('log-patrol', fetchImpl)).rejects.toThrow(/invalid workflow source response/i)
  })

  it('解析工作流目录摘要节点，并拒绝格式错误的条目', async () => {
    const catalog = {
      dir: '/srv/workflows',
      missing: false,
      entries: [{
        id: 'demo',
        file: 'demo.yaml',
        name: 'Demo',
        nodeCount: 1,
        levelCount: 1,
        ok: true,
        errors: [],
        status: 'verified',
        inputs: [{ name: 'level', type: 'string', required: true }],
        nodes: [{ id: 'scan', level: 0, type: 'agent' }],
        edges: [],
        updatedAt: '2026-10-30T12:34:56.000Z',
      }],
    }
    const fetchImpl: typeof fetch = async () => jsonResponse(catalog)
    await expect(loadWorkflowCatalog(fetchImpl)).resolves.toEqual(catalog)

    const malformed: typeof fetch = async () => jsonResponse({
      ...catalog,
      entries: [{ ...catalog.entries[0], status: 'unknown' }],
    })
    await expect(loadWorkflowCatalog(malformed)).rejects.toThrow(/invalid workflow catalog response/i)

    const badUpdatedAt: typeof fetch = async () => jsonResponse({
      ...catalog,
      entries: [{ ...catalog.entries[0], updatedAt: 42 }],
    })
    await expect(loadWorkflowCatalog(badUpdatedAt)).rejects.toThrow(/invalid workflow catalog response/i)

    const badNodeType: typeof fetch = async () => jsonResponse({
      ...catalog,
      entries: [{
        ...catalog.entries[0],
        nodes: [{ id: 'scan', level: 0, type: 'database' }],
      }],
    })
    await expect(loadWorkflowCatalog(badNodeType)).rejects.toThrow(/invalid workflow graph response/i)
  })

  it('删除工作流时只发送 workflowId，并严格校验成功响应', async () => {
    let capturedBody = ''
    const fetchImpl: typeof fetch = async (_input, init) => {
      capturedBody = requestBody(init)
      return jsonResponse({ ok: true })
    }
    await expect(deleteWorkflowSource('demo', fetchImpl)).resolves.toBeUndefined()
    expect(capturedBody).toBe(JSON.stringify({ workflowId: 'demo' }))

    const missing: typeof fetch = async () => jsonResponse({ error: 'workflow not found' }, 404)
    await expect(deleteWorkflowSource('missing', missing)).rejects.toMatchObject({ status: 404 })
    const malformed: typeof fetch = async () => jsonResponse({ ok: 'yes' })
    await expect(deleteWorkflowSource('demo', malformed)).rejects.toThrow(/invalid workflow delete response/i)
  })

  it('解析运行输入声明、启动参数与启动结果', async () => {
    const hint = {
      workflowId: 'demo',
      prompt: 'run demo',
      reason: 'needs an Agent session',
      inputs: [{
        name: 'level',
        type: 'string',
        required: true,
        description: 'Log level',
        defaultValue: 'ERROR',
      }],
    }
    const hintFetch: typeof fetch = async () => jsonResponse({
      ...hint,
      inputs: [{ name: 'level', type: 'string', required: true, description: 'Log level', default: 'ERROR' }],
    })
    await expect(loadWorkflowRunHint('demo', hintFetch)).resolves.toEqual(hint)

    let capturedBody = ''
    const runFetch: typeof fetch = async (_input, init) => {
      capturedBody = requestBody(init)
      return jsonResponse({ ok: true, sessionId: 'session-1', workflowId: 'demo' })
    }
    await expect(startWorkflow('demo', { level: 'ERROR', retries: 0 }, runFetch)).resolves.toEqual({
      ok: true,
      sessionId: 'session-1',
      workflowId: 'demo',
    })
    expect(capturedBody).toBe(JSON.stringify({
      workflowId: 'demo',
      inputs: { level: 'ERROR', retries: 0 },
    }))

    const failedRunFetch: typeof fetch = async () => jsonResponse({ ok: false, reason: 'unavailable' }, 503)
    await expect(startWorkflow('demo', {}, failedRunFetch)).resolves.toEqual({
      ok: false,
      reason: 'unavailable',
    })

    const malformedRunFetch: typeof fetch = async () => jsonResponse({ ok: true })
    await expect(startWorkflow('demo', {}, malformedRunFetch)).rejects.toThrow(/invalid workflow run response/i)
  })

  it('拒绝格式错误、重复或默认值类型不匹配的运行输入声明', async () => {
    const baseHint = {
      workflowId: 'demo',
      prompt: 'run demo',
      reason: 'needs an Agent session',
      inputs: [],
    }
    const malformed = [
      { ...baseHint, workflowId: 1 },
      { ...baseHint, reason: null },
      { ...baseHint, inputs: [{}] },
      { ...baseHint, inputs: [
        { name: 'level', type: 'string', required: true },
        { name: 'level', type: 'string', required: false },
      ] },
      { ...baseHint, inputs: [{ name: 'level', type: 'integer', required: true, default: 1.5 }] },
      { ...baseHint, inputs: [{ name: 'ratio', type: 'number', required: true, default: '1' }] },
      { ...baseHint, inputs: [{ name: 'enabled', type: 'boolean', required: true, default: 0 }] },
      { ...baseHint, inputs: [{ name: 'tags', type: 'array', required: true, default: {} }] },
    ]

    for (const body of malformed) {
      const fetchImpl: typeof fetch = async () => jsonResponse(body)
      await expect(loadWorkflowRunHint('demo', fetchImpl))
        .rejects.toThrow(/invalid workflow run hint response/i)
    }
  })
})
