import { describe, expect, it } from 'vitest'

import {
  WorkflowCycleError,
  dataEdges,
  isRelativeArtifactPath,
  loadAgentDefinition,
  loadWorkflowDefinition,
  parseAgentDefinition,
  parseWorkflowDefinition,
  scheduleDependencies,
  serializeAgentDefinition,
  topoLayers,
} from '../src/index.js'

const AGENT_T3 = `
agent_id: coding_agent
display_name: 编码助手
domain: coding
harness: local_llm
model:
  provider: minimax
  id: MiniMax-M2.7
tier: T3
permissions:
  allowed_tools: [bash, write_file]
  denied_tools: [wecom_notify]
output_files:
  report: reports/report.md
`

describe('Agent 定义往返', () => {
  it('保存后 tier 不丢：T3 仍是 T3', () => {
    const parsed = loadAgentDefinition(AGENT_T3)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return

    expect(parsed.value.tier).toBe('T3')

    const round = loadAgentDefinition(serializeAgentDefinition(parsed.value))
    expect(round.ok).toBe(true)
    if (!round.ok) return
    expect(round.value).toEqual(parsed.value)
    expect(round.value.tier).toBe('T3')
  })

  it('T1 的 agent 保存后不会被提权成 T2', () => {
    const parsed = loadAgentDefinition(AGENT_T3.replace('tier: T3', 'tier: T1'))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const round = loadAgentDefinition(serializeAgentDefinition(parsed.value))
    expect(round.ok).toBe(true)
    if (!round.ok) return
    expect(round.value.tier).toBe('T1')
  })

  it('缺 tier 时按 T2 兜底', () => {
    const parsed = parseAgentDefinition({ agent_id: 'x' })
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.value.tier).toBe('T2')
    expect(parsed.issues).toEqual([{ path: 'tier', message: '缺少 tier，按 T2 处理' }])
  })

  it('未知 tier 按 T2 兜底', () => {
    const parsed = parseAgentDefinition({ agent_id: 'x', tier: 'T9' })
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.value.tier).toBe('T2')
    expect(parsed.issues).toEqual([{ path: 'tier', message: '未知 tier：T9，按 T2 处理' }])
  })

  it('产物路径必须是业务相对路径', () => {
    for (const bad of ['/abs/report.md', 'C:/x/report.md', '../escape.md', 'a/../../b.md', '']) {
      expect(isRelativeArtifactPath(bad)).toBe(false)
    }
    expect(isRelativeArtifactPath('reports/report.md')).toBe(true)
  })

  it('绝对产物路径在解析期就被拒', () => {
    const parsed = parseAgentDefinition({
      agent_id: 'x',
      output_files: { report: '/data/report.md' },
    })
    expect(parsed.ok).toBe(false)
  })

  it('缺少 agent_id 无法解析', () => {
    expect(parseAgentDefinition({}).ok).toBe(false)
    expect(parseAgentDefinition('nope').ok).toBe(false)
  })

  it('完整字段逐项往返，包含权限、知识库与运行限制', () => {
    const source = `
agent_id: log_analyst
display_name: 日志分析员
domain: observability
description: 分析告警日志
harness: local_llm
model:
  provider: deepseek
  id: deepseek-chat
system_prompt: 只根据证据回答
tier: T1
permissions:
  allowed_tools: [read_file]
  denied_tools: [bash]
knowledge_bases: [runbooks, incidents]
timeout_seconds: 900
max_concurrent_runs: 3
cost_limit_per_run: 2.5
output_files:
  report: reports/{run_id}.md
`
    const parsed = loadAgentDefinition(source)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.value).toMatchObject({
      description: '分析告警日志',
      systemPrompt: '只根据证据回答',
      knowledgeBases: ['runbooks', 'incidents'],
      timeoutSeconds: 900,
      maxConcurrentRuns: 3,
      costLimitPerRun: 2.5,
    })
    const round = loadAgentDefinition(serializeAgentDefinition(parsed.value))
    expect(round.ok).toBe(true)
    if (!round.ok) return
    expect(round.value).toEqual(parsed.value)
  })

  it('非法 ID、数值与知识库类型在解析期被拒绝', () => {
    for (const input of [
      { agent_id: '../escape' },
      { agent_id: 'bad/id' },
      { agent_id: 'ok', timeout_seconds: -1 },
      { agent_id: 'ok', max_concurrent_runs: 0 },
      { agent_id: 'ok', cost_limit_per_run: Number.POSITIVE_INFINITY },
      { agent_id: 'ok', knowledge_bases: ['ok', 1] },
    ]) {
      expect(parseAgentDefinition(input).ok).toBe(false)
    }
  })

  it('cost_limit_per_run 允许 null 表示不设上限', () => {
    const parsed = parseAgentDefinition({ agent_id: 'ok', cost_limit_per_run: null })
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.value.costLimitPerRun).toBeNull()
  })
})

describe('Agent 执行方式与工作流归属', () => {
  it('未声明 execution 时按 skill 解析，且不产生问题', () => {
    const parsed = parseAgentDefinition({ agent_id: 'oa_assistant' })
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.value.execution).toBe('skill')
    expect(parsed.value.workflow).toBeUndefined()
    expect(parsed.issues.map(issue => issue.path)).not.toContain('execution')
  })

  it('execution: workflow 必须同时声明 workflow', () => {
    const parsed = parseAgentDefinition({ agent_id: 'smart_query', execution: 'workflow' })
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.issues).toContainEqual({
      path: 'workflow',
      message: 'execution: workflow 的 Agent 必须声明 workflow',
    })
  })

  it('skill 型 Agent 声明 workflow 会被拒绝：写了也不会生效，所以不允许静默存在', () => {
    const parsed = parseAgentDefinition({ agent_id: 'x', workflow: 'smart-query' })
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.issues.map(issue => issue.message))
      .toContain('只有 execution: workflow 的 Agent 才能声明 workflow')
  })

  it('未知 execution 与非法 workflow id 都被拒绝', () => {
    expect(parseAgentDefinition({ agent_id: 'x', execution: 'dag' }).ok).toBe(false)
    expect(parseAgentDefinition({ agent_id: 'x', execution: 'workflow', workflow: '../escape' }).ok).toBe(false)
    expect(parseAgentDefinition({ agent_id: 'x', workflow: 1 }).ok).toBe(false)
  })

  it('执行方式与归属随序列化往返，不会被写丢', () => {
    const source = `
agent_id: smart_query
display_name: 智能问数
domain: smart_query
harness: local_llm
execution: workflow
workflow: smart-query
tier: T2
output_files: {}
`
    const parsed = loadAgentDefinition(source)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.value.execution).toBe('workflow')
    expect(parsed.value.workflow).toBe('smart-query')

    const round = loadAgentDefinition(serializeAgentDefinition(parsed.value))
    expect(round.ok).toBe(true)
    if (!round.ok) return
    expect(round.value).toEqual(parsed.value)
  })
})

const WORKFLOW = `
workflow_id: log-patrol
version: 2
business_id: maxkb-smart-audit
nodes:
  - id: scan
    agent: log_analyst
    role_prompt: 扫描日志
    after: []
    outputs:
      scan_result: analyze
  - id: analyze
    agent: log_analyst
    role_prompt: 分析异常
    after: [scan]
  - id: report
    agent: log_analyst
    role_prompt: 写报告
    after: [analyze]
`

describe('工作流的边规则', () => {
  it('调度只认 after，outputs 不产生依赖', () => {
    const parsed = loadWorkflowDefinition(WORKFLOW)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return

    const nodes = parsed.value.nodes
    const scan = nodes.find(node => node.id === 'scan')
    const analyze = nodes.find(node => node.id === 'analyze')
    expect(scan).toBeDefined()
    expect(analyze).toBeDefined()
    if (scan === undefined || analyze === undefined) return

    // scan 与 analyze 的调度关系只来自 analyze.after；同向 outputs 不改变调度层。
    // scan 的调度依赖保持为空，证明数据边没有偷偷变成调度边。
    expect(scheduleDependencies(scan)).toEqual([])
    expect(scheduleDependencies(analyze)).toEqual(['scan'])
    expect(dataEdges(nodes)).toContainEqual({ from: 'scan', to: 'analyze', port: 'scan_result' })

    const layers = topoLayers(nodes)
    expect(layers).toEqual([['scan'], ['analyze'], ['report']])

    // 这份 fixture 的 outputs 与 after 同向：清空 outputs 在正确实现与「把 outputs 当调度边」
    // 的错误实现下结果相同，区分不出任何东西。真正有判别力的是清空 after——若 outputs 参与
    // 调度，层次仍会被它撑开；若 outputs 只做数据流，三个节点必须落到同一层。
    const withoutAfter = nodes.map(node => ({ ...node, after: [] }))
    expect(withoutAfter.every(node => scheduleDependencies(node).length === 0)).toBe(true)
    expect(topoLayers(withoutAfter)).toEqual([['scan', 'analyze', 'report']])
  })

  it('dataEdges 展开多目标，并容忍没有 outputs 的节点', () => {
    const nodes = [
      { id: 'scan', outputs: { records: ['analyze', 'report'], summary: 'audit' } },
      { id: 'analyze' },
      { id: 'report' },
      { id: 'audit' },
    ]

    expect(dataEdges(nodes)).toEqual([
      { from: 'scan', to: 'analyze', port: 'records' },
      { from: 'scan', to: 'report', port: 'records' },
      { from: 'scan', to: 'audit', port: 'summary' },
    ])
  })

  it('只用 outputs 声明依赖的节点与生产者同层（会被并行执行）', () => {
    const nodes = parseWorkflowDefinition({
      workflow_id: 'w',
      business_id: 'b',
      nodes: [
        { id: 'a', agent: 'x', outputs: { out: 'b' } },
        { id: 'b', agent: 'x' },
      ],
    })
    expect(nodes.ok).toBe(true)
    if (!nodes.ok) return
    expect(topoLayers(nodes.value.nodes)).toEqual([['a', 'b']])
  })

  it('环路被拒绝', () => {
    const parsed = parseWorkflowDefinition({
      workflow_id: 'w',
      business_id: 'b',
      nodes: [
        { id: 'a', agent: 'x', after: ['b'] },
        { id: 'b', agent: 'x', after: ['a'] },
      ],
    })
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.issues.some(issue => issue.message.includes('环'))).toBe(true)
  })

  it('topoLayers 自己也会抛环错误', () => {
    expect(() =>
      topoLayers([
        { id: 'a', type: 'agent', rolePrompt: '', after: ['b'], inputs: [], outputs: {} },
        { id: 'b', type: 'agent', rolePrompt: '', after: ['a'], inputs: [], outputs: {} },
      ]),
    ).toThrow(WorkflowCycleError)
  })

  it('依赖不存在的节点被拒绝', () => {
    const parsed = parseWorkflowDefinition({
      workflow_id: 'w',
      business_id: 'b',
      nodes: [{ id: 'a', agent: 'x', after: ['ghost'] }],
    })
    expect(parsed.ok).toBe(false)
  })

  it('agent 与 inline_agent 不能同时声明', () => {
    const parsed = parseWorkflowDefinition({
      workflow_id: 'w',
      business_id: 'b',
      nodes: [{ id: 'a', agent: 'x', inline_agent: { agent_id: 'y' } }],
    })
    expect(parsed.ok).toBe(false)
  })

  it('既没有 agent 也没有 inline_agent 被拒绝', () => {
    const parsed = parseWorkflowDefinition({
      workflow_id: 'w',
      business_id: 'b',
      nodes: [{ id: 'a' }],
    })
    expect(parsed.ok).toBe(false)
  })

  it('business_id 不能带路径分隔段', () => {
    const parsed = parseWorkflowDefinition({
      workflow_id: 'w',
      business_id: '../escape',
      nodes: [{ id: 'a', agent: 'x' }],
    })
    expect(parsed.ok).toBe(false)
  })

  it('空节点列表被拒绝', () => {
    expect(parseWorkflowDefinition({ workflow_id: 'w', business_id: 'b', nodes: [] }).ok).toBe(false)
  })
})

const LEGACY_MAPPING_WORKFLOW = `
workflow_id: log-patrol
version: 2
nodes:
  scan:
    type: agent
    agent: log_analyst
    after: []
    outputs:
      scan_result:
        to: "analyze.in:scan_result"
  analyze:
    type: agent
    agent: log_analyst
    after: [scan]
    outputs:
      done:
        to: ""
`

describe('工作流旧文件兼容与校验定位', () => {
  it('把旧 inline_agent 的 provider/model 规范化为对象', () => {
    const parsed = parseWorkflowDefinition({
      workflow_id: 'legacy-inline-model',
      business_id: 'b',
      nodes: [
        {
          id: 'fetch',
          inline_agent: {
            harness: 'codex',
            model: 'minimax/MiniMax-M3',
            role_prompt: '采集数据',
          },
        },
      ],
    })

    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.value.nodes[0]?.inlineAgent?.model).toEqual({
      provider: 'minimax',
      id: 'MiniMax-M3',
    })
  })

  it('旧模型字符串只在第一个斜杠处拆分', () => {
    const parsed = parseWorkflowDefinition({
      workflow_id: 'legacy-model-path',
      business_id: 'b',
      nodes: [{ id: 'a', inline_agent: { model: 'provider/model/v2' } }],
    })

    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.value.nodes[0]?.inlineAgent?.model).toEqual({
      provider: 'provider',
      id: 'model/v2',
    })
  })

  it('拒绝缺少 provider 或 model id 的旧模型字符串', () => {
    for (const model of ['/model', 'provider/', '/', 'provider']) {
      const parsed = parseWorkflowDefinition({
        workflow_id: 'bad-model',
        business_id: 'b',
        nodes: [{ id: 'a', inline_agent: { model } }],
      })
      expect(parsed.ok).toBe(false)
      if (parsed.ok) continue
      expect(parsed.issues.some(issue => issue.path === 'nodes.a.inline_agent.model')).toBe(true)
    }
  })

  it('旧三节点工作流保留全部节点，缺 business_id 仍只告警', () => {
    const parsed = loadWorkflowDefinition(`
workflow_id: docker-container-demo
version: 1
nodes:
  fetch:
    type: agent
    inline_agent:
      harness: codex
      model: minimax/MiniMax-M3
  think:
    type: agent
    inline_agent:
      harness: codex
      model: minimax/MiniMax-M3
    after: [fetch]
  report:
    type: agent
    inline_agent:
      harness: codex
      model: minimax/MiniMax-M3
    after: [think]
`)

    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.value.nodes.map(node => node.id)).toEqual(['fetch', 'think', 'report'])
    expect(parsed.value.nodes.every(node => node.inlineAgent?.model !== undefined)).toBe(true)
    expect(parsed.issues).toEqual([
      expect.objectContaining({ path: 'business_id' }),
    ])
  })

  it('mapping 节点与 to 形式 outputs 规范化，缺 business_id 仅告警', () => {
    const parsed = loadWorkflowDefinition(LEGACY_MAPPING_WORKFLOW)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return

    expect(parsed.value.businessId).toBeUndefined()
    expect(parsed.value.nodes.map(node => node.id)).toEqual(['scan', 'analyze'])
    const scan = parsed.value.nodes[0]
    const analyze = parsed.value.nodes[1]
    expect(scan?.outputs).toEqual({ scan_result: ['analyze'] })
    expect(analyze?.outputs).toEqual({ done: [] })
    expect(dataEdges(parsed.value.nodes)).toEqual([{ from: 'scan', to: 'analyze', port: 'scan_result' }])
    expect(parsed.issues.some(issue => issue.path === 'business_id')).toBe(true)
  })

  it('outputs 支持字符串、数组与 to 对象，并去掉端口后缀', () => {
    const parsed = parseWorkflowDefinition({
      workflow_id: 'w',
      nodes: {
        a: {
          agent: 'x',
          outputs: {
            one: 'b.out:value',
            many: ['c', { to: 'd.in:value' }],
            empty: { to: '' },
          },
        },
        b: { agent: 'x' },
        c: { agent: 'x' },
        d: { agent: 'x' },
      },
    })
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.value.nodes[0]?.outputs).toEqual({ one: ['b'], many: ['c', 'd'], empty: [] })
    expect(dataEdges(parsed.value.nodes)).toEqual([
      { from: 'a', to: 'b', port: 'one' },
      { from: 'a', to: 'c', port: 'many' },
      { from: 'a', to: 'd', port: 'many' },
    ])
  })

  it('outputs 的 to 对象支持字符串数组，并展开为多条数据边', () => {
    const parsed = parseWorkflowDefinition({
      workflow_id: 'w',
      nodes: {
        route: {
          agent: 'x',
          outputs: {
            intent: { to: ['resolve.in:intent', 'refuse.out:intent'] },
          },
        },
        resolve: { agent: 'x' },
        refuse: { agent: 'x' },
      },
    })
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.value.nodes[0]?.outputs).toEqual({ intent: ['resolve', 'refuse'] })
    expect(dataEdges(parsed.value.nodes)).toEqual([
      { from: 'route', to: 'resolve', port: 'intent' },
      { from: 'route', to: 'refuse', port: 'intent' },
    ])
  })

  it('空命名输出端口被保留，网关可由条件与空端口组成', () => {
    const parsed = parseWorkflowDefinition({
      workflow_id: 'w',
      nodes: {
        choose: { type: 'gateway', condition: 'ready', outputs: { next: [] } },
      },
    })
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.value.nodes[0]?.outputs).toEqual({ next: [] })
    expect(dataEdges(parsed.value.nodes)).toEqual([])
  })

  it('坏 YAML 返回带 1-based 行列的 issue 而不是抛异常', () => {
    const parsed = loadWorkflowDefinition('workflow_id: broken\nnodes:\n  a: [\n')
    expect(parsed.ok).toBe(false)
    const yamlIssue = parsed.issues.find(issue => issue.kind === 'yaml')
    expect(yamlIssue).toBeDefined()
    expect(yamlIssue?.line).toBeGreaterThanOrEqual(1)
    expect(yamlIssue?.column).toBeGreaterThanOrEqual(1)
  })

  it('语义 issue 定位到字段所在行', () => {
    const source = `
workflow_id: w
nodes:
  a:
    agent: x
    after: [ghost]
`
    const parsed = loadWorkflowDefinition(source)
    expect(parsed.ok).toBe(false)
    const issue = parsed.issues.find(item => item.path === 'nodes.a.after')
    expect(issue).toMatchObject({ line: 6, column: 5 })
  })

  it('环 issue 定位到闭合回边的 after 字段', () => {
    const source = `
workflow_id: w
nodes:
  a:
    agent: x
    after: [b]
  b:
    agent: x
    after: [a]
`
    const parsed = loadWorkflowDefinition(source)
    expect(parsed.ok).toBe(false)
    expect(parsed.issues.find(issue => issue.kind === 'cycle')).toMatchObject({
      path: 'nodes.b.after',
      line: 9,
      column: 5,
      cycle: ['a', 'b', 'a'],
      nodeIds: ['a', 'b'],
    })
  })
  it('结构错误与环同时返回，环成员稳定', () => {
    const parsed = parseWorkflowDefinition({
      workflow_id: 'w',
      nodes: {
        a: { agent: 'x', after: ['b'] },
        b: { agent: 'x', after: ['a'] },
        c: { agent: 'x', after: ['ghost'] },
      },
    })
    expect(parsed.ok).toBe(false)
    expect(parsed.issues.some(issue => issue.path === 'nodes.c.after')).toBe(true)
    expect(parsed.issues.find(issue => issue.kind === 'cycle')).toMatchObject({
      cycle: ['a', 'b', 'a'],
      nodeIds: ['a', 'b'],
    })
  })

  it('六类节点全部保留类型与专有配置，未知字段进入 rawFields', () => {
    const parsed = parseWorkflowDefinition({
      workflow_id: 'w',
      name: '节点原语',
      description: '覆盖六类节点',
      business_id: 'b',
      inputs: [
        { name: 'source', type: 'string', required: true },
        { name: 'limit', type: 'integer', required: false, default: 3, description: '最大次数' },
      ],
      nodes: {
        worker: {
          name: '执行者',
          agent: 'x',
          business_role: '分析员',
          after: [],
          outputs: { result: 'gateway' },
          custom_flag: true,
        },
        command: {
          type: 'command',
          command_config: { cli_template: 'echo {source}', timeout_seconds: 5 },
        },
        wait: { type: 'await_command', await_command_config: { max_commands: 2 } },
        gateway: {
          type: 'gateway',
          condition: "result ? 'yes' : 'no'",
          gateway_kind: 'condition',
          outputs: { yes: 'branches', no: 'loop' },
        },
        branches: {
          type: 'parallel_branch',
          branches: ['worker', 'command'],
          join_strategy: 'all',
          cancel_on_first_fail: false,
        },
        loop: {
          type: 'while',
          body: ['worker'],
          continue_if: 'not passed',
          max_iterations: 2,
          while_config: { backoff_seconds: [0, 1] },
        },
      },
      widgets: [
        {
          id: 'progress',
          type: 'progress_status',
          title: '进度',
          emit_on: { node: 'worker', event: 'node.started' },
        },
        {
          id: 'report',
          type: 'artifact_ref',
          title: '报告',
          emit_on_node: 'worker',
          emit_on_event: 'node.completed',
          props: { path: '{{worker.result}}' },
        },
      ],
    })

    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.value.name).toBe('节点原语')
    expect(parsed.value.inputs).toEqual([
      { name: 'source', type: 'string', required: true },
      { name: 'limit', type: 'integer', required: false, default: 3, description: '最大次数' },
    ])
    expect(parsed.value.nodes.map(node => node.type)).toEqual([
      'agent', 'command', 'await_command', 'gateway', 'parallel_branch', 'while',
    ])
    const worker = parsed.value.nodes.find(node => node.id === 'worker')
    const command = parsed.value.nodes.find(node => node.id === 'command')
    const wait = parsed.value.nodes.find(node => node.id === 'wait')
    const gateway = parsed.value.nodes.find(node => node.id === 'gateway')
    const branches = parsed.value.nodes.find(node => node.id === 'branches')
    const loop = parsed.value.nodes.find(node => node.id === 'loop')
    expect(worker).toMatchObject({
      displayName: '执行者',
      businessRole: '分析员',
      rawFields: { custom_flag: true },
    })
    expect(command?.commandConfig).toMatchObject({ cli_template: 'echo {source}', timeout_seconds: 5 })
    expect(wait?.awaitCommandConfig).toEqual({
      targetActors: [],
      commandPort: 'command',
      expirySeconds: 86400,
      maxCommands: 2,
    })
    expect(gateway).toMatchObject({ condition: "result ? 'yes' : 'no'", gatewayKind: 'condition' })
    expect(branches).toMatchObject({ branches: ['worker', 'command'], joinStrategy: 'all', cancelOnFirstFail: false })
    expect(loop).toMatchObject({ body: ['worker'], continueIf: 'not passed', maxIterations: 2 })
    expect(loop?.whileConfig).toEqual({ backoff_seconds: [0, 1] })
    expect(parsed.value.widgets).toEqual([
      {
        id: 'progress', type: 'progress_status', title: '进度',
        emitOnNode: 'worker', emitOnEvent: 'node.started',
      },
      {
        id: 'report', type: 'artifact_ref', title: '报告',
        emitOnNode: 'worker', emitOnEvent: 'node.completed', props: { path: '{{worker.result}}' },
      },
    ])
  })

  it('工作流输入与 widget 的重复名称、错误默认值和缺失事件都会被拒绝', () => {
    const parsed = parseWorkflowDefinition({
      workflow_id: 'w',
      inputs: [
        { name: 'same', type: 'integer', required: 'yes', default: 'bad' },
        { name: 'same', type: 'mystery' },
      ],
      nodes: { a: { agent: 'x' } },
      widgets: [
        { id: 'dup', type: 'memo', title: '一', emit_on_node: 'a', emit_on_event: 'node.started' },
        { id: 'dup', type: 'memo', title: '二' },
      ],
    })
    expect(parsed.ok).toBe(false)
    expect(parsed.issues.map(issue => issue.path)).toEqual(expect.arrayContaining([
      'inputs[0].required',
      'inputs[0].default',
      'inputs[1].type',
      'inputs[1].name',
      'widgets[1].id',
      'widgets[1].emit_on_node',
      'widgets[1].emit_on_event',
    ]))
  })
})

describe('await_command 配置', () => {
  function parseAwait(config: unknown) {
    return parseWorkflowDefinition({
      workflow_id: 'w',
      nodes: {
        wait: { type: 'await_command', await_command_config: config },
      },
    })
  }

  it('空配置补全四个默认值', () => {
    const parsed = parseAwait({})
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.value.nodes[0]?.awaitCommandConfig).toEqual({
      targetActors: [],
      commandPort: 'command',
      expirySeconds: 86400,
      maxCommands: 10,
    })
  })

  it('部分字段只覆盖对应默认值', () => {
    const parsed = parseAwait({ target_actors: ['scan', 'analyze'], max_commands: 2 })
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.value.nodes[0]?.awaitCommandConfig).toEqual({
      targetActors: ['scan', 'analyze'],
      commandPort: 'command',
      expirySeconds: 86400,
      maxCommands: 2,
    })
  })

  it('完整字段逐项解析并忽略未知字段', () => {
    const parsed = parseAwait({
      target_actors: ['scan'],
      command_port: 'next-command',
      expiry_seconds: 3600,
      max_commands: 5,
      legacy_flag: true,
    })
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.value.nodes[0]?.awaitCommandConfig).toEqual({
      targetActors: ['scan'],
      commandPort: 'next-command',
      expirySeconds: 3600,
      maxCommands: 5,
    })
  })

  it.each([
    ['target_actors 不是字符串数组', { target_actors: 'scan' }, 'nodes.wait.await_command_config.target_actors'],
    ['target_actors 含非字符串', { target_actors: ['scan', 2] }, 'nodes.wait.await_command_config.target_actors'],
    ['command_port 为空', { command_port: '' }, 'nodes.wait.await_command_config.command_port'],
    ['command_port 不是字符串', { command_port: 1 }, 'nodes.wait.await_command_config.command_port'],
    ['expiry_seconds 不是正整数', { expiry_seconds: 1.5 }, 'nodes.wait.await_command_config.expiry_seconds'],
    ['max_commands 不是正整数', { max_commands: 0 }, 'nodes.wait.await_command_config.max_commands'],
  ])('%s 时拒绝', (_label, config, path) => {
    const parsed = parseAwait(config)
    expect(parsed.ok).toBe(false)
    expect(parsed.issues.some(issue => issue.path === path)).toBe(true)
  })

  it('整个工作流最多有一个 await_command', () => {
    const parsed = parseWorkflowDefinition({
      workflow_id: 'w',
      nodes: {
        first: { type: 'await_command', await_command_config: {} },
        second: { type: 'await_command', await_command_config: {} },
      },
    })
    expect(parsed.ok).toBe(false)
    expect(parsed.issues).toContainEqual(expect.objectContaining({
      path: 'nodes.second.await_command_config',
      message: '整个工作流最多只能有一个 await_command 节点',
    }))
  })
})

it('execution_backend round-trips and defaults to auto', () => {
  const source = 'agent_id: coding_agent\ndisplay_name: Coding\ndomain: task\nharness: local_llm\nexecution_backend: codex\nmodel: auto\n'
  const parsed = loadAgentDefinition(source)
  expect(parsed.ok).toBe(true)
  if (parsed.ok) expect(parsed.value.executionBackend).toBe('codex')
  const serialized = serializeAgentDefinition(parsed.ok ? parsed.value : {} as never)
  expect(serialized).toContain('execution_backend: codex')
  const defaults = parseAgentDefinition({ agent_id: 'a', display_name: 'A', domain: 'd', model: 'auto' })
  expect(defaults.ok && defaults.value.executionBackend).toBe('auto')
})
