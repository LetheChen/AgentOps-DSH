import { describe, expect, it } from 'vitest'

import {
  loadActorVisualProfile,
  loadDomainDefinition,
  parseActorVisualProfile,
  parseDomainDefinition,
} from '../src/index.js'

const DOMAIN_YAML = `
domain: smart_query
display_name: 智能问数
description: 用自然语言查询业务库
default_permissions:
  allowed_tools: [sql_query]
  denied_tools: [shell_exec]
default_knowledge_bases: [metrics]
cost_limit_per_run: 2.5
`

const ACTOR_PROFILE = {
  actor_id: 'log_puller',
  description: '抽取日志中的异常',
  allowed_surface_views: [
    {
      view_id: 'log_summary',
      output_contract: 'LogSummary',
      description: '异常摘要',
      required_phases: ['partial'],
      fields: {
        count: { type: 'integer', required: true },
        level: { type: 'enum', values: ['warn', 'error'] },
      },
    },
  ],
}

describe('业务域定义解析', () => {
  it('解析完整的业务域默认值', () => {
    const parsed = loadDomainDefinition(DOMAIN_YAML)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return

    expect(parsed.value.domain).toBe('smart_query')
    expect(parsed.value.displayName).toBe('智能问数')
    expect(parsed.value.defaultPermissions.allowedTools).toEqual(['sql_query'])
    expect(parsed.value.defaultPermissions.deniedTools).toEqual(['shell_exec'])
    expect(parsed.value.defaultKnowledgeBases).toEqual(['metrics'])
    expect(parsed.value.costLimitPerRun).toBe(2.5)
    expect(parsed.issues).toEqual([])
  })

  it('缺少 domain 是致命错误，其余字段降级并记 issue', () => {
    const parsed = loadDomainDefinition('display_name: 无主域\n')
    expect(parsed.ok).toBe(false)
    expect(parsed.issues.some(issue => issue.path === 'domain')).toBe(true)
  })

  it('缺省值与旧项目一致：auto 模型、空权限、成本 1.0', () => {
    const parsed = parseDomainDefinition({ domain: 'plain' })
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return

    expect(parsed.value.defaultPermissions).toEqual({ allowedTools: [], deniedTools: [] })
    expect(parsed.value.defaultKnowledgeBases).toEqual([])
    expect(parsed.value.costLimitPerRun).toBe(1)
  })

  it('YAML 语法错误返回行号', () => {
    const parsed = loadDomainDefinition('domain: a\n  bad: [')
    expect(parsed.ok).toBe(false)
    expect(parsed.issues[0]?.kind).toBe('yaml')
  })
})

describe('Actor Profile 解析', () => {
  it('解析 Actor 与其允许发布的视图', () => {
    const parsed = parseActorVisualProfile(ACTOR_PROFILE)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return

    expect(parsed.value.actorId).toBe('log_puller')
    expect(parsed.value.allowedSurfaceViews).toHaveLength(1)
    const view = parsed.value.allowedSurfaceViews[0]
    expect(view?.viewId).toBe('log_summary')
    expect(view?.outputContract).toBe('LogSummary')
    expect(view?.requiredPhases).toEqual(['partial'])
    expect(view?.fields['count']?.type).toBe('integer')
    expect(view?.fields['level']?.enumValues).toEqual(['warn', 'error'])
  })

  it('缺少 actor_id 是致命错误', () => {
    const parsed = parseActorVisualProfile({ description: '无主' })
    expect(parsed.ok).toBe(false)
    expect(parsed.issues.some(issue => issue.path === 'actor_id')).toBe(true)
  })

  it('缺少 view_id 的视图被丢弃，其余视图保留', () => {
    const parsed = parseActorVisualProfile({
      actor_id: 'manager',
      allowed_surface_views: [
        { output_contract: 'NoId' },
        { view_id: 'ok_view', output_contract: 'Ok' },
      ],
    })
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return

    expect(parsed.value.allowedSurfaceViews.map(view => view.viewId)).toEqual(['ok_view'])
    expect(parsed.issues.some(issue => issue.path.endsWith('view_id'))).toBe(true)
  })

  it('enum 字段缺少 values 记 issue', () => {
    const parsed = parseActorVisualProfile({
      actor_id: 'manager',
      allowed_surface_views: [
        { view_id: 'v', fields: { level: { type: 'enum' } } },
      ],
    })
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return

    expect(parsed.issues.some(issue => issue.path.endsWith('values'))).toBe(true)
  })

  it('非法 JSON 返回解析失败', () => {
    const parsed = loadActorVisualProfile('{ not json')
    expect(parsed.ok).toBe(false)
    expect(parsed.issues[0]?.kind).toBe('json')
  })
})
