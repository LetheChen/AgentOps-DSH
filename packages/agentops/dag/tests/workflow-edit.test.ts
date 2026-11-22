import assert from 'node:assert/strict'
import { test } from 'node:test'

import { loadWorkflowDefinition } from '@agentops/dsh-contracts'

import {
  WorkflowEditError,
  applyWorkflowEdit,
  parseWorkflowEditOperation,
} from '../src/workflow-edit.ts'

const CRLF_SOURCE = [
  '# header stays',
  'workflow_id: demo',
  'version: 2',
  'business_id: demo',
  'nodes:',
  '  - id: scan',
  '    agent: scanner',
  '    role_prompt: scan logs',
  '    outputs:',
  '      result: analyze',
  '  - id: analyze',
  '    agent: analyst',
  '    role_prompt: analyze logs',
  '    after: [scan]',
  '# footer stays',
  '',
].join('\r\n')

function parsed(source: string) {
  const result = loadWorkflowDefinition(source)
  assert.equal(result.ok, true)
  if (!result.ok) throw new Error('expected a valid workflow')
  return result.value
}

void test('workflow edit operation 运行时拒绝未知字段和错误类型', () => {
  assert.deepEqual(parseWorkflowEditOperation({
    kind: 'add-node',
    id: 'collect',
    agent: 'collector',
    rolePrompt: 'collect logs',
  }), {
    kind: 'add-node',
    id: 'collect',
    agent: 'collector',
    rolePrompt: 'collect logs',
  })

  assert.throws(() => parseWorkflowEditOperation({
    kind: 'add-node',
    id: 'collect',
    agent: 'collector',
    rolePrompt: 'collect logs',
    extra: true,
  }), WorkflowEditError)
  assert.throws(() => parseWorkflowEditOperation({
    kind: 'remove-node',
    id: '',
  }), WorkflowEditError)
})

void test('workflow edit operation 接受非空且不含 NUL 的任意 id、agent 和 port', () => {
  assert.deepEqual(parseWorkflowEditOperation({
    kind: 'add-data-edge',
    from: 'scan logs',
    to: 'analyze.result',
    port: 'result: #1',
  }), {
    kind: 'add-data-edge',
    from: 'scan logs',
    to: 'analyze.result',
    port: 'result: #1',
  })

  assert.deepEqual(parseWorkflowEditOperation({
    kind: 'add-node',
    id: 'collect logs',
    agent: 'collector.prod',
    rolePrompt: '',
  }), {
    kind: 'add-node',
    id: 'collect logs',
    agent: 'collector.prod',
    rolePrompt: '',
  })

  assert.throws(() => parseWorkflowEditOperation({
    kind: 'add-data-edge',
    from: 'scan',
    to: 'report',
    port: `bad${String.fromCharCode(0)}port`,
  }), WorkflowEditError)
})
void test('workflow edit operation 解析六类节点并严格校验类型专用字段', () => {
  assert.deepEqual(parseWorkflowEditOperation({
    kind: 'add-node',
    id: 'cmd',
    type: 'command',
    cliTemplate: 'echo hi',
  }), {
    kind: 'add-node',
    id: 'cmd',
    type: 'command',
    cliTemplate: 'echo hi',
  })
  assert.deepEqual(parseWorkflowEditOperation({
    kind: 'add-node',
    id: 'wait',
    type: 'await_command',
  }), {
    kind: 'add-node',
    id: 'wait',
    type: 'await_command',
    targetActors: [],
    commandPort: 'command',
    expirySeconds: 86400,
    maxCommands: 10,
  })
  assert.deepEqual(parseWorkflowEditOperation({
    kind: 'add-node',
    id: 'wait-for-approval',
    type: 'await_command',
    targetActors: ['scan', 'analyze logs'],
    commandPort: 'approval',
    expirySeconds: 3600,
    maxCommands: 3,
  }), {
    kind: 'add-node',
    id: 'wait-for-approval',
    type: 'await_command',
    targetActors: ['scan', 'analyze logs'],
    commandPort: 'approval',
    expirySeconds: 3600,
    maxCommands: 3,
  })
  assert.deepEqual(parseWorkflowEditOperation({
    kind: 'add-node',
    id: 'choose',
    type: 'gateway',
    condition: 'score > 0',
  }), {
    kind: 'add-node',
    id: 'choose',
    type: 'gateway',
    condition: 'score > 0',
  })
  assert.deepEqual(parseWorkflowEditOperation({
    kind: 'add-node',
    id: 'fork',
    type: 'parallel_branch',
    branches: ['scan', 'analyze'],
  }), {
    kind: 'add-node',
    id: 'fork',
    type: 'parallel_branch',
    branches: ['scan', 'analyze'],
  })
  assert.deepEqual(parseWorkflowEditOperation({
    kind: 'add-node',
    id: 'loop',
    type: 'while',
    body: ['scan', 'analyze'],
    continueIf: 'more',
    maxIterations: 10,
  }), {
    kind: 'add-node',
    id: 'loop',
    type: 'while',
    body: ['scan', 'analyze'],
    continueIf: 'more',
    maxIterations: 10,
  })

  assert.throws(() => parseWorkflowEditOperation({
    kind: 'add-node',
    id: 'cmd',
    type: 'command',
    cliTemplate: 'echo hi',
    agent: 'scanner',
  }), WorkflowEditError)
  assert.throws(() => parseWorkflowEditOperation({
    kind: 'add-node',
    id: 'cmd',
    type: 'command',
  }), WorkflowEditError)
  assert.throws(() => parseWorkflowEditOperation({
    kind: 'add-node',
    id: 'fork',
    type: 'parallel_branch',
    branches: [],
  }), WorkflowEditError)
  assert.throws(() => parseWorkflowEditOperation({
    kind: 'add-node',
    id: 'loop',
    type: 'while',
    body: ['scan'],
    continueIf: 'more',
    maxIterations: 0,
  }), WorkflowEditError)
  assert.throws(() => parseWorkflowEditOperation({
    kind: 'add-node',
    id: 'wait',
    type: 'await_command',
    targetActors: 'scan',
  }), WorkflowEditError)
  assert.throws(() => parseWorkflowEditOperation({
    kind: 'add-node',
    id: 'wait',
    type: 'await_command',
    targetActors: ['scan', ''],
  }), WorkflowEditError)
  assert.throws(() => parseWorkflowEditOperation({
    kind: 'add-node',
    id: 'wait',
    type: 'await_command',
    commandPort: '',
  }), WorkflowEditError)
  assert.throws(() => parseWorkflowEditOperation({
    kind: 'add-node',
    id: 'wait',
    type: 'await_command',
    expirySeconds: 1.5,
  }), WorkflowEditError)
  assert.throws(() => parseWorkflowEditOperation({
    kind: 'add-node',
    id: 'wait',
    type: 'await_command',
    maxCommands: Number.MAX_SAFE_INTEGER + 1,
  }), WorkflowEditError)
  assert.throws(() => parseWorkflowEditOperation({
    kind: 'add-node',
    id: 'wait',
    type: 'await_command',
    extra: true,
  }), WorkflowEditError)
  assert.throws(() => parseWorkflowEditOperation({
    kind: 'add-node',
    id: 'agent-with-explicit-type',
    type: 'agent',
    agent: 'scanner',
    rolePrompt: 'scan',
  }), WorkflowEditError)
})

void test('添加 Agent 节点只插入新 YAML 片段并保留 CRLF、缩进和注释', () => {
  const result = applyWorkflowEdit(CRLF_SOURCE, {
    kind: 'add-node',
    id: 'collect',
    agent: 'collector',
    rolePrompt: 'collect logs',
  })

  const expected = [
    '# header stays',
    'workflow_id: demo',
    'version: 2',
    'business_id: demo',
    'nodes:',
    '  - id: collect',
    '    agent: collector',
    '    role_prompt: "collect logs"',
    '  - id: scan',
    '    agent: scanner',
    '    role_prompt: scan logs',
    '    outputs:',
    '      result: analyze',
    '  - id: analyze',
    '    agent: analyst',
    '    role_prompt: analyze logs',
    '    after: [scan]',
    '# footer stays',
    '',
  ].join('\r\n')

  assert.equal(result.text, expected)
})
void test('依次添加 command、await_command、gateway、parallel_branch 与 while，并保留 CRLF 和注释', () => {
  let text = CRLF_SOURCE

  const command = applyWorkflowEdit(text, {
    kind: 'add-node',
    id: 'cmd logs',
    type: 'command',
    cliTemplate: 'echo "hello: #world"',
  })
  text = command.text
  assert.deepEqual(parsed(text).nodes[0], {
    id: 'cmd logs',
    type: 'command',
    rolePrompt: '',
    after: [],
    inputs: [],
    outputs: {},
    commandConfig: { cli_template: 'echo "hello: #world"' },
  })
  assert.match(text, /- id: "cmd logs"\r\n    type: command\r\n    command_config:\r\n      cli_template: 'echo "hello: #world"'\r\n/)

  const awaiting = applyWorkflowEdit(text, {
    kind: 'add-node',
    id: 'wait',
    type: 'await_command',
    targetActors: ['scan', 'analyze'],
    commandPort: 'approval',
    expirySeconds: 3600,
    maxCommands: 3,
  })
  text = awaiting.text
  assert.deepEqual(parsed(text).nodes[1], {
    id: 'wait',
    type: 'await_command',
    rolePrompt: '',
    after: [],
    inputs: [],
    outputs: {},
    awaitCommandConfig: {
      targetActors: ['scan', 'analyze'],
      commandPort: 'approval',
      expirySeconds: 3600,
      maxCommands: 3,
    },
  })
  assert.match(
    text,
    new RegExp(
      '    await_command_config:\\r\\n'
      + '      target_actors: \\[scan, analyze\\]\\r\\n'
      + '      command_port: approval\\r\\n'
      + '      expiry_seconds: 3600\\r\\n'
      + '      max_commands: 3\\r\\n',
    ),
  )

  const gateway = applyWorkflowEdit(text, {
    kind: 'add-node',
    id: 'choose',
    type: 'gateway',
    condition: 'score > 0',
  })
  text = gateway.text
  assert.deepEqual(parsed(text).nodes[2], {
    id: 'choose',
    type: 'gateway',
    rolePrompt: '',
    after: [],
    inputs: [],
    outputs: { next: [] },
    condition: 'score > 0',
  })
  assert.match(text, /    outputs:\r\n      next: \[\]\r\n/)

  const parallel = applyWorkflowEdit(text, {
    kind: 'add-node',
    id: 'fork',
    type: 'parallel_branch',
    branches: ['scan', 'analyze'],
  })
  text = parallel.text
  assert.deepEqual(parsed(text).nodes[3], {
    id: 'fork',
    type: 'parallel_branch',
    rolePrompt: '',
    after: [],
    inputs: [],
    outputs: {},
    branches: ['scan', 'analyze'],
  })
  assert.match(text, /    branches: \[scan, analyze\]\r\n/)

  const loop = applyWorkflowEdit(text, {
    kind: 'add-node',
    id: 'loop',
    type: 'while',
    body: ['scan', 'analyze'],
    continueIf: 'more',
    maxIterations: 10,
  })
  text = loop.text
  assert.deepEqual(parsed(text).nodes[4], {
    id: 'loop',
    type: 'while',
    rolePrompt: '',
    after: [],
    inputs: [],
    outputs: {},
    body: ['scan', 'analyze'],
    continueIf: 'more',
    maxIterations: 10,
  })
  assert.match(text, /    body: \[scan, analyze\]\r\n    continue_if: more\r\n    max_iterations: 10\r\n/)
  assert.match(text, /# header stays/)
  assert.match(text, /# footer stays/)
  assert.ok(text.includes('\r\n'))
})

void test('添加任意合法 id、agent 与 port 时安全引号化 YAML', () => {
  const added = applyWorkflowEdit(CRLF_SOURCE, {
    kind: 'add-node',
    id: 'collect logs: #1',
    agent: 'collector.prod',
    rolePrompt: 'collect: #logs',
  })
  const value = parsed(added.text)
  assert.deepEqual(value.nodes[0], {
    id: 'collect logs: #1',
    type: 'agent',
    agentRef: 'collector.prod',
    rolePrompt: 'collect: #logs',
    after: [],
    inputs: [],
    outputs: {},
  })
  assert.match(added.text, /- id: "collect logs: #1"/)
  assert.match(added.text, /agent: "collector\.prod"/)

  const withPort = applyWorkflowEdit(added.text, {
    kind: 'add-data-edge',
    from: 'scan',
    to: 'analyze',
    port: 'result: #1',
  })
  const ported = parsed(withPort.text)
  assert.deepEqual(ported.nodes.find(node => node.id === 'scan')?.outputs, {
    result: ['analyze'],
    'result: #1': ['analyze'],
  })
  assert.match(withPort.text, /"result: #1": \[analyze\]/)
})

void test('删除节点同时清理 after 与 outputs，保留无关注释', () => {
  const source = [
    '# header',
    'workflow_id: demo',
    'nodes:',
    '  - id: scan',
    '    agent: scanner',
    '    outputs:',
    '      result: analyze',
    '      fanout: [analyze, report]',
    '  - id: analyze',
    '    agent: analyst',
    '    after: [scan]',
    '  - id: report',
    '    agent: reporter',
    '    after: [scan, analyze]',
    '# footer',
    '',
  ].join('\n')

  const result = applyWorkflowEdit(source, { kind: 'remove-node', id: 'analyze' })
  const value = parsed(result.text)

  assert.deepEqual(value.nodes.map(node => node.id), ['scan', 'report'])
  assert.deepEqual(value.nodes[0]?.outputs, { fanout: ['report'] })
  assert.deepEqual(value.nodes[1]?.after, ['scan'])
  assert.match(result.text, /# header/)
  assert.match(result.text, /# footer/)
})

void test('添加调度边只修改 after，不把 outputs 变成调度依赖', () => {
  const source = CRLF_SOURCE.replace(
    '# footer stays',
    [
      '  - id: report',
      '    agent: reporter',
      '# footer stays',
      '',
    ].join('\r\n'),
  )
  const result = applyWorkflowEdit(source, {
    kind: 'add-schedule-edge',
    from: 'analyze',
    to: 'report',
  })

  const value = parsed(result.text)
  assert.deepEqual(value.nodes.find(node => node.id === 'analyze')?.after, ['scan'])
  assert.deepEqual(value.nodes.find(node => node.id === 'report')?.after, ['analyze'])
  assert.deepEqual(value.nodes[0]?.outputs, { result: ['analyze'] })
})

void test('添加数据边只修改 outputs，不增加 after', () => {
  const result = applyWorkflowEdit(CRLF_SOURCE, {
    kind: 'add-data-edge',
    from: 'scan',
    to: 'analyze',
    port: 'metrics',
  })

  const value = parsed(result.text)
  assert.deepEqual(value.nodes[0]?.outputs, {
    result: ['analyze'],
    metrics: ['analyze'],
  })
  assert.deepEqual(value.nodes[1]?.after, ['scan'])
  assert.match(result.text, /# footer stays/)
})
void test('编辑 flow-style outputs 时保留 gateway 的空端口', () => {
  const source = [
    'workflow_id: demo',
    'nodes:',
    '  - id: gate',
    '    type: gateway',
    '    condition: ok',
    '    outputs: {next: [], reject: [scan]}',
    '  - id: scan',
    '    type: command',
    '    command_config: {cli_template: echo scan}',
    '  - id: analyze',
    '    type: command',
    '    command_config: {cli_template: echo analyze}',
    '',
  ].join('\n')

  const result = applyWorkflowEdit(source, {
    kind: 'add-data-edge',
    from: 'gate',
    to: 'analyze',
    port: 'result',
  })
  const gate = parsed(result.text).nodes[0]
  assert.deepEqual(gate?.outputs, {
    next: [],
    reject: ['scan'],
    result: ['analyze'],
  })
  assert.match(result.text, /next: \[\]/)
})

void test('删除数据边只移除指定 port 与 target', () => {
  const source = [
    'workflow_id: demo',
    'business_id: demo',
    'nodes:',
    '  - id: scan',
    '    agent: scanner',
    '    outputs:',
    '      result: [analyze, report]',
    '  - id: analyze',
    '    agent: analyst',
    '    after: [scan]',
    '  - id: report',
    '    agent: reporter',
    '',
  ].join('\r\n')
  const result = applyWorkflowEdit(source, {
    kind: 'remove-data-edge',
    from: 'scan',
    to: 'report',
    port: 'result',
  })

  const value = parsed(result.text)
  assert.deepEqual(value.nodes[0]?.outputs, { result: ['analyze'] })
  assert.deepEqual(value.nodes.find(node => node.id === 'analyze')?.after, ['scan'])
})

void test('点号、空格与冒号组成的既有节点 id 可删除并清理两类边', () => {
  const source = [
    'workflow_id: demo',
    'nodes:',
    '  - id: "scan logs"',
    '    agent: scanner',
    '    outputs:',
    '      "records: #1": "analyze.result"',
    '  - id: analyze.result',
    '    agent: analyst',
    '    after: ["scan logs"]',
    '',
  ].join('\n')

  const removed = applyWorkflowEdit(source, { kind: 'remove-node', id: 'analyze.result' })
  const value = parsed(removed.text)
  assert.deepEqual(value.nodes.map(node => node.id), ['scan logs'])
  assert.deepEqual(value.nodes[0]?.outputs, {})

  const withoutTarget = applyWorkflowEdit(source, {
    kind: 'remove-schedule-edge',
    from: 'scan logs',
    to: 'analyze.result',
  })
  assert.deepEqual(parsed(withoutTarget.text).nodes[1]?.after, [])
})

void test('语义无效的编辑抛出带 issue 的 WorkflowEditError', () => {
  assert.throws(() => applyWorkflowEdit(CRLF_SOURCE, {
    kind: 'add-node',
    id: 'scan',
    agent: 'scanner',
    rolePrompt: 'duplicate',
  }), (reason: unknown) => {
    assert.ok(reason instanceof WorkflowEditError)
    assert.ok(reason.issues.length > 0)
    return true
  })

  assert.throws(() => applyWorkflowEdit(CRLF_SOURCE, {
    kind: 'remove-node',
    id: 'missing',
  }), (reason: unknown) => {
    assert.ok(reason instanceof WorkflowEditError)
    assert.equal(reason.issues[0]?.path, 'nodes.missing')
    return true
  })

  assert.throws(() => applyWorkflowEdit(CRLF_SOURCE, {
    kind: 'add-schedule-edge',
    from: 'analyze',
    to: 'analyze',
  }), (reason: unknown) => {
    assert.ok(reason instanceof WorkflowEditError)
    assert.ok(reason.issues.some(issue => issue.kind === 'cycle'))
    return true
  })
})

void test('mapping 形式的 nodes 支持添加与删除节点', () => {
  const source = [
    'workflow_id: demo',
    'nodes:',
    '  scan:',
    '    agent: scanner',
    '    outputs:',
    '      result: analyze',
    '  analyze:',
    '    agent: analyst',
    '    after: [scan]',
    '',
  ].join('\n')

  const added = applyWorkflowEdit(source, {
    kind: 'add-node',
    id: 'collect',
    agent: 'collector',
    rolePrompt: 'collect',
  })
  assert.deepEqual(parsed(added.text).nodes.map(node => node.id), ['collect', 'scan', 'analyze'])

  const removed = applyWorkflowEdit(added.text, { kind: 'remove-node', id: 'scan' })
  const value = parsed(removed.text)
  assert.deepEqual(value.nodes.map(node => node.id), ['collect', 'analyze'])
  assert.deepEqual(value.nodes[1]?.after, [])
})
void test('mapping 形式的 nodes 支持添加全部非 Agent 节点', () => {
  let text = [
    'workflow_id: demo',
    'nodes:',
    '  scan:',
    '    type: command',
    '    command_config: {cli_template: echo scan}',
    '',
  ].join('\n')
  const operations = [
    { kind: 'add-node', id: 'cmd', type: 'command', cliTemplate: 'echo hi' },
    {
      kind: 'add-node',
      id: 'wait',
      type: 'await_command',
      targetActors: [],
      commandPort: 'command',
      expirySeconds: 86400,
      maxCommands: 10,
    },
    { kind: 'add-node', id: 'choose', type: 'gateway', condition: 'ok' },
    { kind: 'add-node', id: 'fork', type: 'parallel_branch', branches: ['scan'] },
    { kind: 'add-node', id: 'loop', type: 'while', body: ['scan'], continueIf: 'more', maxIterations: 3 },
  ] as const

  for (const operation of operations) {
    text = applyWorkflowEdit(text, operation).text
  }

  assert.deepEqual(parsed(text).nodes.map(node => [node.id, node.type]), [
    ['cmd', 'command'],
    ['wait', 'await_command'],
    ['choose', 'gateway'],
    ['fork', 'parallel_branch'],
    ['loop', 'while'],
    ['scan', 'command'],
  ])
  assert.match(text, /  choose:\n    type: gateway\n    condition: ok\n    outputs:\n      next: \[\]\n/)
  assert.match(
    text,
    new RegExp(
      '  wait:\\n    type: await_command\\n    await_command_config:\\n'
      + '      target_actors: \\[\\]\\n'
      + '      command_port: command\\n'
      + '      expiry_seconds: 86400\\n'
      + '      max_commands: 10\\n',
    ),
  )
})

void test('添加第二个 await_command 在写入 YAML 前失败', () => {
  const source = [
    'workflow_id: demo',
    'nodes:',
    '  - id: wait',
    '    type: await_command',
    '    await_command_config: {}',
    '  - id: scan',
    '    agent: scanner',
    '',
  ].join('\n')

  assert.throws(() => applyWorkflowEdit(source, {
    kind: 'add-node',
    id: 'wait-again',
    type: 'await_command',
    targetActors: [],
    commandPort: 'command',
    expirySeconds: 86400,
    maxCommands: 10,
  }), (reason: unknown) => {
    assert.ok(reason instanceof WorkflowEditError)
    assert.match(reason.issues[0]?.message ?? '', /最多只能有一个/)
    return true
  })
})
