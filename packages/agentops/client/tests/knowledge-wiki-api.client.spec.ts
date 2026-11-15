// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  createKnowledgeSpace,
  createWikiDraft,
  fetchKnowledgeMemory,
  fetchWikiSnapshot,
  publishWikiDraft,
  reviewWikiCategory,
} from '../src/client/knowledge-wiki-api.ts'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

describe('knowledge wiki browser api', () => {
  it('creates task-report drafts and publishes them through the wiki routes', async () => {
    const calls: { path: string; method: string; body: unknown }[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      calls.push({
        path,
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      })
      if (path.endsWith('/wiki/draft')) return response({ draft: { id: 'd1', status: 'ready', conflicts: [] } })
      if (path.endsWith('/spaces')) return response({ space: { id: 'project-analysis', name: '项目分析', visibility: 'shared' } })
      if (path.endsWith('/wiki/publish')) return response({ draft: { id: 'd1', status: 'published' }, page: { id: 'p1', documentId: 'wiki_d1' } })
      if (path.endsWith('/wiki/category/review')) return response({ category: { spaceId: 'project_analysis', path: '技术分析/本地部署', reviewStatus: 'reviewed' } })
      if (path.endsWith('/wiki')) return response({ drafts: [], pages: [], operations: [], spaces: [], schema: '# schema', stats: {} })
      if (path.endsWith('/memory')) return response({ nodes: [{ documentId: 'doc-1', title: '财务制度' }] })
      return response({}, 404)
    }))

    const draft = await createWikiDraft({
      title: '视频提取流程', content: '# 视频提取流程', sourceKind: 'task_report', sourceTaskId: 't1', sourceReportId: 'r1',
      targetSpaceId: 'smart_query',
    })
    expect(draft.id).toBe('d1')
    await publishWikiDraft('d1', 'project_analysis', '技术分析/本地部署')
    await reviewWikiCategory('project_analysis', '技术分析/本地部署')
    await createKnowledgeSpace({ id: 'project-analysis', name: '项目分析', visibility: 'shared' })
    expect(await fetchWikiSnapshot()).toEqual(expect.objectContaining({ schema: '# schema' }))
    expect(await fetchKnowledgeMemory()).toEqual([expect.objectContaining({ documentId: 'doc-1' })])
    expect(calls.map(call => [call.path, call.method])).toEqual([
      ['/api/agentops/knowledge/wiki/draft', 'POST'],
      ['/api/agentops/knowledge/wiki/publish', 'POST'],
      ['/api/agentops/knowledge/wiki/category/review', 'POST'],
      ['/api/agentops/knowledge/spaces', 'POST'],
      ['/api/agentops/knowledge/wiki', 'GET'],
      ['/api/agentops/knowledge/memory', 'GET'],
    ])
  })

  it('surfaces the server error message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response({ error: { code: 'draft_conflicted', message: '草稿仍有阻断项' } }, 409)))
    await expect(publishWikiDraft('d1', 'smart_query')).rejects.toThrow('草稿仍有阻断项')
  })

  it('turns a plain-text missing route into an actionable restart error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not found', { status: 404 })))
    await expect(fetchWikiSnapshot()).rejects.toThrow('知识库 Wiki 服务尚未加载，请重启 dsh web 后重试')
  })
})
