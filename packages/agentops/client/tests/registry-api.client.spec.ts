import { describe, expect, it } from 'vitest'

import {
  loadActorRegistry,
  loadDomainRegistry,
  RegistryResponseError,
} from '../src/client/registry-api.js'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

const DOMAIN = {
  domain: 'smart_query',
  displayName: '智能问数',
  description: '用自然语言查询业务库',
  defaultAllowedTools: ['sql_query'],
  defaultDeniedTools: ['shell_exec'],
  defaultKnowledgeBases: ['metrics'],
  costLimitPerRun: 2.5,
  valid: true,
  issues: [],
}

const ACTOR = {
  actorId: 'log_puller',
  description: '抽取日志中的异常',
  views: [
    {
      viewId: 'log_summary',
      outputContract: 'LogSummary',
      description: '异常摘要',
      requiredPhases: ['partial'],
      fieldCount: 2,
    },
  ],
  valid: true,
  issues: [],
}

describe('业务域注册表客户端', () => {
  it('解析注册表条目', async () => {
    const entries = await loadDomainRegistry(async () => jsonResponse({ domains: [DOMAIN] }))
    expect(entries).toHaveLength(1)
    expect(entries[0]?.domain).toBe('smart_query')
    expect(entries[0]?.defaultAllowedTools).toEqual(['sql_query'])
    expect(entries[0]?.costLimitPerRun).toBe(2.5)
  })

  it('响应缺少 domains 时报错而不是返回空列表', async () => {
    await expect(loadDomainRegistry(async () => jsonResponse({})))
      .rejects.toBeInstanceOf(RegistryResponseError)
  })

  it('字段类型不符时报错', async () => {
    await expect(loadDomainRegistry(async () => jsonResponse({
      domains: [{ ...DOMAIN, costLimitPerRun: '2.5' }],
    }))).rejects.toBeInstanceOf(RegistryResponseError)
  })

  it('HTTP 失败时携带状态码', async () => {
    await expect(loadDomainRegistry(async () => jsonResponse({ message: 'boom' }, 500)))
      .rejects.toMatchObject({ status: 500, message: 'boom' })
  })
})

describe('Actor 注册表客户端', () => {
  it('解析 Actor 与其视图', async () => {
    const entries = await loadActorRegistry(async () => jsonResponse({ actors: [ACTOR] }))
    expect(entries).toHaveLength(1)
    expect(entries[0]?.actorId).toBe('log_puller')
    expect(entries[0]?.views[0]?.viewId).toBe('log_summary')
    expect(entries[0]?.views[0]?.fieldCount).toBe(2)
  })

  it('视图缺少 requiredPhases 时报错', async () => {
    await expect(loadActorRegistry(async () => jsonResponse({
      actors: [{ ...ACTOR, views: [{ ...ACTOR.views[0], requiredPhases: undefined }] }],
    }))).rejects.toBeInstanceOf(RegistryResponseError)
  })
})
