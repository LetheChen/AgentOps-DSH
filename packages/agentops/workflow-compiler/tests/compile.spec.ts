import { Script } from 'node:vm'

import { describe, expect, it } from 'vitest'

import { parseWorkflowDefinition } from '@agentops/dsh-contracts'
import type { WorkflowDefinition } from '@agentops/dsh-contracts'

import { compileWorkflow } from '../src/index.js'
import type { CompiledWorkflow } from '../src/index.js'

interface Trace {
  readonly log: string[]
}

interface Result {
  readonly value: unknown
  readonly trace: Trace
}

/** Execute a compiled script against stub hooks and record the call order. */
async function execute(source: string): Promise<Result> {
  const log: string[] = []
  const agent = async (prompt: string, options: { label: string; phase: string }) => {
    log.push(`agent:${options.label}@${options.phase}`)
    return { label: options.label, prompt }
  }
  const parallel = async (thunks: ReadonlyArray<() => Promise<unknown>>) => {
    log.push('parallel')
    return Promise.all(thunks.map(thunk => thunk()))
  }
  const phase = (title: string) => {
    log.push(`phase:${title}`)
  }
  const value = await new Script(source).runInNewContext({ agent, parallel, phase })
  return { value, trace: { log } }
}

function parse(raw: unknown): WorkflowDefinition {
  const parsed = parseWorkflowDefinition(raw)
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues))
  return parsed.value
}

function compile(definition: WorkflowDefinition): CompiledWorkflow {
  const result = compileWorkflow(definition)
  if (!result.ok) throw new Error(JSON.stringify(result.issues))
  return result.value
}

const LINEAR = {
  workflow_id: 'log-patrol',
  version: 2,
  business_id: 'maxkb',
  nodes: [
    { id: 'scan', agent: 'log_analyst', role_prompt: '扫描日志' },
    { id: 'analyze', agent: 'log_analyst', role_prompt: '分析异常', after: ['scan'] },
    { id: 'report', agent: 'log_analyst', role_prompt: '生成报告', after: ['analyze'] },
  ],
}

describe('编译输出结构', () => {
  it('按 after 分层，每层一个 phase', () => {
    const compiled = compile(parse(LINEAR))
    expect(compiled.layers).toEqual([['scan'], ['analyze'], ['report']])
    expect(compiled.source).toContain('phase("layer-0")')
    expect(compiled.source).toContain('phase("layer-1")')
    expect(compiled.source).toContain('phase("layer-2")')
    expect(compiled.source).not.toContain('parallel(')
  })

  it('单节点层用 await，多节点层用 parallel 屏障', () => {
    const compiled = compile(
      parse({
        workflow_id: 'fan',
        business_id: 'b',
        nodes: [
          { id: 'start', agent: 'x', role_prompt: 'start' },
          { id: 'left', agent: 'x', role_prompt: 'left', after: ['start'] },
          { id: 'right', agent: 'x', role_prompt: 'right', after: ['start'] },
        ],
      }),
    )
    expect(compiled.layers).toEqual([['start'], ['left', 'right']])
    expect(compiled.source).toContain('] = await parallel([')
    expect(compiled.source).toContain('() => agent("left"')
    expect(compiled.source).toContain('() => agent("right"')
  })

  it('节点 id 含非法字符时生成合法标识符', () => {
    const compiled = compile(
      parse({
        workflow_id: 'w',
        business_id: 'b',
        nodes: [
          { id: 'a-b.c', agent: 'x', role_prompt: 'p' },
          { id: '2fa', agent: 'x', role_prompt: 'q' },
        ],
      }),
    )
    expect(compiled.source).toContain('node_a_b_c,')
    expect(compiled.source).toContain('node__2fa,')
  })

  it('model 选项写入每个 agent 调用', () => {
    const result = compileWorkflow(parse(LINEAR), { model: { provider: 'minimax', id: 'MiniMax-M2.7' } })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const compiled = result.value
    expect(compiled.source).toContain('provider: "minimax"')
    expect(compiled.source).toContain('model: "MiniMax-M2.7"')
  })
})

describe('编译产物的执行语义', () => {
  it('线性工作流按层顺序执行', async () => {
    const { trace } = await execute(compile(parse(LINEAR)).source)
    expect(trace.log).toEqual([
      'phase:layer-0',
      'agent:scan@layer-0',
      'phase:layer-1',
      'agent:analyze@layer-1',
      'phase:layer-2',
      'agent:report@layer-2',
    ])
  })

  it('并行层同时发起，且整体屏障后再进入下一层', async () => {
    const { trace, value } = await execute(
      compile(
        parse({
          workflow_id: 'fan',
          business_id: 'b',
          nodes: [
            { id: 'start', agent: 'x', role_prompt: 'start' },
            { id: 'left', agent: 'x', role_prompt: 'left', after: ['start'] },
            { id: 'right', agent: 'x', role_prompt: 'right', after: ['start'] },
            { id: 'join', agent: 'x', role_prompt: 'join', after: ['left', 'right'] },
          ],
        }),
      ).source,
    )
    expect(trace.log).toEqual([
      'phase:layer-0',
      'agent:start@layer-0',
      'phase:layer-1',
      'parallel',
      'agent:left@layer-1',
      'agent:right@layer-1',
      'phase:layer-2',
      'agent:join@layer-2',
    ])
    expect(Object.keys(value as Record<string, unknown>).sort()).toEqual(['join', 'left', 'right', 'start'])
  })

  it('只用 outputs 声明依赖的节点与生产者同层并行', async () => {
    const compiled = compile(
      parse({
        workflow_id: 'w',
        business_id: 'b',
        nodes: [
          { id: 'producer', agent: 'x', role_prompt: 'p', outputs: { out: 'consumer' } },
          { id: 'consumer', agent: 'x', role_prompt: 'c' },
        ],
      }),
    )
    expect(compiled.layers).toEqual([['producer', 'consumer']])
    const { trace } = await execute(compiled.source)
    expect(trace.log).toEqual(['phase:layer-0', 'parallel', 'agent:producer@layer-0', 'agent:consumer@layer-0'])
  })
})

describe('编译器的不变量', () => {
  it('同一输入两次编译得到相同 digest', () => {
    const a = compile(parse(LINEAR))
    const b = compile(parse(LINEAR))
    expect(a.digest).toBe(b.digest)
  })

  it('prompt 变化会改变 digest', () => {
    const a = compile(parse(LINEAR))
    const b = compile(
      parse({
        ...LINEAR,
        nodes: LINEAR.nodes.map((node, index) => (index === 0 ? { ...node, role_prompt: '换了措辞' } : node)),
      }),
    )
    expect(a.digest).not.toBe(b.digest)
  })

  it('环在解析阶段就被拒绝', () => {
    const cyclic = {
      workflow_id: 'w',
      business_id: 'b',
      nodes: [
        { id: 'a', agent: 'x', after: ['b'] },
        { id: 'b', agent: 'x', after: ['a'] },
      ],
    }
    expect(parseWorkflowDefinition(cyclic).ok).toBe(false)
  })

  it('编译器自身也拒绝环，不依赖调用方先解析', () => {
    const cyclic: WorkflowDefinition = {
      workflowId: 'w',
      name: 'Cycle',
      version: 1,
      businessId: 'b',
      inputs: [],
      nodes: [
        { id: 'a', type: 'agent', rolePrompt: '', after: ['b'], inputs: [], outputs: {} },
        { id: 'b', type: 'agent', rolePrompt: '', after: ['a'], inputs: [], outputs: {} },
      ],
      widgets: [],
    }
    const result = compileWorkflow(cyclic)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.issues[0]).toMatchObject({ kind: 'cycle', path: 'nodes.a.after' })
  })

  it('command 节点返回结构化 unsupported，不生成伪 Agent 调用', () => {
    const definition = parse({
      workflow_id: 'command-only',
      business_id: 'b',
      nodes: [{
        id: 'backup',
        type: 'command',
        command_config: { cli_template: 'tar -czf backup.tgz data' },
      }],
    })
    const result = compileWorkflow(definition)
    expect(result).toEqual({
      ok: false,
      issues: [{
        path: 'nodes.backup.type',
        kind: 'unsupported',
        message: '执行器当前只支持 agent 节点，backup 是 command',
      }],
    })
  })

  it('混合工作流仍可解析校验，但编译整体拒绝且不执行任一部分', () => {
    const definition = parse({
      workflow_id: 'mixed',
      business_id: 'b',
      nodes: [
        { id: 'scan', agent: 'x', role_prompt: 'scan' },
        {
          id: 'notify',
          type: 'command',
          command_config: { cli_template: 'echo done' },
          after: ['scan'],
        },
      ],
    })
    expect(definition.nodes.map(node => node.type)).toEqual(['agent', 'command'])
    expect(compileWorkflow(definition)).toMatchObject({
      ok: false,
      issues: [{ path: 'nodes.notify.type', kind: 'unsupported' }],
    })
  })
})
