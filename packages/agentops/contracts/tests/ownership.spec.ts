import { describe, expect, it } from 'vitest'

import { buildWorkflowOwnership, parseAgentDefinition, type AgentDefinition } from '../src/index.js'

/**
 * Build a parsed definition so the tests exercise the same path the catalogue
 * does; a hand-written literal would not catch a field the parser drops.
 * @param agentId - catalogue id.
 * @param workflow - workflow the Agent claims, when it owns one.
 * @returns the parsed definition, failing the test when it does not parse.
 */
function agent(agentId: string, workflow?: string): AgentDefinition {
  const parsed = parseAgentDefinition({
    agent_id: agentId,
    ...(workflow === undefined ? {} : { execution: 'workflow', workflow }),
  })
  expect(parsed.ok).toBe(true)
  if (!parsed.ok) throw new Error('unreachable: parseAgentDefinition failed')
  return parsed.value
}

describe('工作流归属索引', () => {
  it('每个 workflow 归属唯一 Agent 时不产生问题', () => {
    const result = buildWorkflowOwnership(
      [agent('smart_query', 'smart-query'), agent('log_analyst', 'log-patrol'), agent('oa_assistant')],
      ['smart-query', 'log-patrol'],
    )

    expect([...result.owners]).toEqual([['smart-query', 'smart_query'], ['log-patrol', 'log_analyst']])
    expect(result.issues).toEqual([])
  })

  it('同一条工作流被两个 Agent 声明时报告冲突，先声明者胜出', () => {
    const result = buildWorkflowOwnership(
      [agent('first', 'shared'), agent('second', 'shared')],
      ['shared'],
    )

    expect(result.owners.get('shared')).toBe('first')
    expect(result.issues).toEqual([{
      path: 'agents.second.workflow',
      message: '工作流 shared 已被 Agent first 声明：一条工作流只能有一个所属 Agent',
      kind: 'workflow-claimed-twice',
    }])
  })

  it('Agent 引用不存在的工作流时报告，且不产生幽灵归属', () => {
    const result = buildWorkflowOwnership([agent('typo', 'smrt-query')], ['smart-query'])

    expect(result.owners.size).toBe(0)
    expect(result.issues.map(issue => issue.kind)).toEqual(['workflow-not-found', 'workflow-unclaimed'])
  })

  it('没有任何 Agent 声明的工作流被报告出来，供调用方标为遗留', () => {
    const result = buildWorkflowOwnership([agent('smart_query', 'smart-query')], ['smart-query', 'travel-expense'])

    expect(result.issues).toEqual([{
      path: 'workflows.travel-expense',
      message: '没有任何 Agent 声明该工作流：travel-expense',
      kind: 'workflow-unclaimed',
    }])
  })

  it('skill 型 Agent 不参与归属索引', () => {
    const result = buildWorkflowOwnership([agent('oa_assistant')], [])

    expect(result.owners.size).toBe(0)
    expect(result.issues).toEqual([])
  })
})
