import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { analyzeWikiDraft, createWikiDraftRecord, normalizeWikiCategoryPath, renderWikiMarkdown, suggestWikiCategory } from '../src/wiki.ts'
import { KnowledgeService } from '../src/service.ts'
import { SqliteKnowledgeRepository } from '../src/sqlite.ts'
import { WikiService } from '../src/wiki-service.ts'

const NOW = '2026-11-15T00:00:00.000Z'

function withRepo(run: (repo: SqliteKnowledgeRepository, service: KnowledgeService, wiki: WikiService) => void): void {
  const directory = mkdtempSync(join(tmpdir(), 'agentops-wiki-'))
  const path = join(directory, 'knowledge.db')
  try {
    const repo = new SqliteKnowledgeRepository(path)
    const service = KnowledgeService.open(repo)
    service.addSpace({ id: 'smart_query', name: '问数口径', visibility: 'shared', readers: [] })
    service.addSpace({ id: 'project_analysis', name: '项目分析报告', visibility: 'shared', readers: [] })
    run(repo, service, new WikiService(service, repo))
    repo.close()
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

void test('task report draft: auto check, publish, search and persist', () => {
  withRepo((repo, service, wiki) => {
    const draft = wiki.createDraft({
      title: '视频内容提取流程',
      content: '# 视频内容提取流程\n\n视频任务完成后提取转写稿、章节摘要和关键帧说明，归档前检查来源、冲突与敏感信息，再生成可检索的 Wiki 页面。\n\n- 来源：任务报告 task-video-1\n- 关联：[[概念/多模态知识归档]]',
      sourceKind: 'task_report',
      sourceRef: 'task-video-1/report-1',
      sourceTaskId: 'task-video-1',
      sourceReportId: 'report-1',
      now: NOW,
    }, ['smart_query'])
    assert.equal(draft.status, 'ready')
    assert.equal(wiki.createDraft({
      title: '重复提交',
      content: draft.content,
      sourceKind: 'task_report',
      sourceRef: 'task-video-1/report-1',
      now: NOW,
    }, ['smart_query']).id, draft.id)

    const published = wiki.publishDraft(draft.id, 'smart_query', ['smart_query'])
    assert.equal(published.page.documentId, `wiki_${draft.id}`)
    assert.ok(service.search('关键帧说明', ['smart_query']).length > 0)

    const second = new WikiService(KnowledgeService.open(repo), repo)
    assert.equal(second.snapshot().pages[0]?.documentId, published.page.documentId)
    assert.ok(second.snapshot().operations.some(operation => operation.action === 'wiki.publish'))
  })
})

void test('draft checks block duplicate content and sensitive values', () => {
  const draft = createWikiDraftRecord({
    title: '生产配置说明',
    content: '# 生产配置说明\n\n这是一段足够长的知识内容，用于验证重复内容与敏感信息检查。api_key=abcdef123456',
    sourceKind: 'manual',
    sourceRef: 'manual/config',
    now: NOW,
  })
  const conflicts = analyzeWikiDraft(draft, [{
    documentId: 'existing', title: '生产配置说明', spaceId: 'ops', contentHash: draft.contentHash,
  }])
  assert.ok(conflicts.some(conflict => conflict.code === 'duplicate-content' && conflict.severity === 'block'))
  assert.ok(conflicts.some(conflict => conflict.code === 'sensitive-content' && conflict.severity === 'block'))
  assert.match(renderWikiMarkdown(draft), /type: entity/)
})

void test('uploaded technical documents default to source pages', () => {
  const draft = createWikiDraftRecord({
    title: '接口设计说明',
    content: '# 接口设计说明\n\n这是一份足以进入 Wiki 的技术文档内容，说明接口、数据结构和错误处理。',
    sourceKind: 'archive',
    sourceRef: 'upload:api-design.md',
    now: NOW,
  })
  assert.equal(draft.pageType, 'source')
})

void test('category maintenance: auto classify, create, publish and review', () => {
  withRepo((_repo, service, wiki) => {
    assert.equal(normalizeWikiCategoryPath('技术分析/../本地部署'), '技术分析/本地部署')
    assert.equal(suggestWikiCategory({
      title: 'Strata · 12G 显卡畅跑 Qwen3.8 Flash Next',
      content: '整机协同、MTP 解码和本地部署方案。',
      sourceKind: 'archive',
    }), '技术分析/本地部署')

    const draft = wiki.createDraft({
      title: 'Strata · 12G 显卡畅跑 Qwen3.8 Flash Next',
      content: '# Strata\n\n整机协同、MTP 解码和本地部署方案。使用 12G 显卡运行 Qwen3.8，并保留来源、性能与部署边界。\n',
      sourceKind: 'archive',
      sourceRef: 'upload:strata-intro.html',
      targetSpaceId: 'project_analysis',
      now: NOW,
    }, ['project_analysis'])
    assert.equal(draft.categoryPath, '技术分析/本地部署')
    assert.equal(wiki.snapshot().categories[0]?.reviewStatus, 'auto')

    const published = wiki.publishDraft(draft.id, 'project_analysis', ['project_analysis'])
    assert.equal(published.page.categoryPath, '技术分析/本地部署')
    assert.ok(service.search('MTP 显卡', ['project_analysis']).length > 0)

    const reviewed = wiki.reviewCategory('project_analysis', '技术分析/本地部署')
    assert.equal(reviewed.reviewStatus, 'reviewed')
    assert.ok(wiki.snapshot().operations.some(operation => operation.action === 'category.create'))
    assert.ok(wiki.snapshot().operations.some(operation => operation.action === 'category.review'))
  })
})
