import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { analyzeWikiDraft, createWikiDraftRecord, normalizeWikiCategoryPath, renderWikiMarkdown, suggestWikiCategory, suggestWikiSpace } from '../src/wiki.ts'
import { KnowledgeService } from '../src/service.ts'
import { SqliteKnowledgeRepository } from '../src/sqlite.ts'
import { WikiService } from '../src/wiki-service.ts'

const NOW = '2026-11-15T00:00:00.000Z'

function withRepo(run: (repo: SqliteKnowledgeRepository, service: KnowledgeService, wiki: WikiService) => void): void {
  const directory = mkdtempSync(join(tmpdir(), 'agentops-wiki-'))
  const path = join(directory, 'knowledge.db')
  let repo: SqliteKnowledgeRepository | undefined
  try {
    repo = new SqliteKnowledgeRepository(path)
    const service = KnowledgeService.open(repo)
    const spaces = [
      ['finance', '财务制度'],
      ['hr', '人事政策'],
      ['ops', '运维手册'],
      ['office_docs', '办公协作'],
      ['project_analysis', '项目分析报告'],
      ['technical_docs', '技术文档'],
      ['learning', '学习资料'],
      ['smart_query', '业务资产'],
      ['content_creation', '内容创作'],
      ['review', '待复核'],
    ] as const
    for (const [id, name] of spaces) {
      service.addSpace({ id, name, description: `${name}测试空间`, visibility: 'shared', readers: [] })
    }
    run(repo, service, new WikiService(service, repo))
  } finally {
    repo?.close()
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
      targetSpaceId: 'content_creation',
      now: NOW,
    }, ['content_creation'])
    assert.equal(draft.status, 'ready')
    assert.equal(wiki.createDraft({
      title: '重复提交',
      content: draft.content,
      sourceKind: 'task_report',
      sourceRef: 'task-video-1/report-1',
      now: NOW,
    }, ['content_creation']).id, draft.id)

    const published = wiki.publishDraft(draft.id, 'content_creation', ['content_creation'])
    assert.equal(published.page.documentId, `wiki_${draft.id}`)
    assert.ok(service.search('关键帧说明', ['content_creation']).length > 0)

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

void test('categorized space: auto classify, create, publish and review', () => {
  withRepo((_repo, service, wiki) => {
    assert.equal(normalizeWikiCategoryPath('架构设计/../系统设计'), '架构设计/系统设计')
    assert.equal(suggestWikiCategory({
      title: '知识库系统架构设计',
      content: '说明模块边界、权限与检索链路。',
      sourceKind: 'archive',
      targetSpaceId: 'technical_docs',
    }), '架构设计/系统设计')

    const draft = wiki.createDraft({
      title: '知识库系统架构设计',
      content: '# 知识库系统架构设计\n\n说明模块边界、权限与检索链路，并记录架构决策和部署约束。',
      sourceKind: 'archive',
      sourceRef: 'upload:knowledge-architecture.html',
      targetSpaceId: 'technical_docs',
      now: NOW,
    }, ['technical_docs'])
    assert.equal(draft.categoryPath, '架构设计/系统设计')
    assert.equal(wiki.snapshot().categories[0]?.reviewStatus, 'auto')

    const published = wiki.publishDraft(draft.id, 'technical_docs', ['technical_docs'])
    assert.equal(published.page.categoryPath, '架构设计/系统设计')
    assert.ok(service.search('检索链路', ['technical_docs']).length > 0)

    const reviewed = wiki.reviewCategory('technical_docs', '架构设计/系统设计')
    assert.equal(reviewed.reviewStatus, 'reviewed')
    assert.ok(wiki.snapshot().operations.some(operation => operation.action === 'category.create'))
    assert.ok(wiki.snapshot().operations.some(operation => operation.action === 'category.review'))
  })
})

void test('flat spaces publish at the root and create no categories', () => {
  withRepo((_repo, service, wiki) => {
    const draft = wiki.createDraft({
      title: '项目选型评估结论',
      content: '# 项目选型评估结论\n\n对比三套知识库方案的实施成本、检索质量和维护边界，形成推荐结论。',
      sourceKind: 'manual',
      sourceRef: 'manual/project-selection',
      targetSpaceId: 'project_analysis',
      categoryPath: '技术分析/错误分类',
      now: NOW,
    }, ['project_analysis'])
    assert.equal(draft.categoryPath, '')
    const published = wiki.publishDraft(draft.id, 'project_analysis', ['project_analysis'], '技术分析/错误分类')
    assert.equal(published.page.categoryPath, '')
    assert.equal(service.listDocuments().find(document => document.id === published.page.documentId)?.categoryPath, '')
    assert.equal(wiki.snapshot().categories.some(category => category.spaceId === 'project_analysis'), false)
  })
})

void test('category suggestions cover built-in domains and publication preserves the path', () => {
  withRepo((_repo, service, wiki) => {
    assert.equal(suggestWikiSpace({ title: '2026 年第 46 周经营周报', content: '本周进展与风险。', sourceKind: 'manual' }), 'office_docs')
    assert.equal(suggestWikiSpace({ title: 'RAG 系统学习笔记', content: '课程摘录与读书笔记。', sourceKind: 'manual' }), 'learning')
    assert.equal(suggestWikiSpace({ title: '知识库接口文档', content: 'API 协议与错误码。', sourceKind: 'manual' }), 'technical_docs')
    assert.equal(suggestWikiSpace({ title: '知识库产品技术选型', content: '竞品比较与方案评估。', sourceKind: 'manual' }), 'project_analysis')
    assert.equal(suggestWikiSpace({ title: '零散材料', content: '无法判断用途。', sourceKind: 'manual' }), 'review')
    assert.equal(suggestWikiCategory({
      title: '产品发布视频模板',
      content: '用于 HyperFrames 的分镜、旁白和字幕模板。',
      sourceKind: 'manual',
      targetSpaceId: 'content_creation',
    }), '视频模板/视频生产')
    assert.equal(suggestWikiCategory({
      title: '第 46 周经营周报',
      content: '本周进展与风险。',
      sourceKind: 'manual',
      targetSpaceId: 'office_docs',
    }), '周报/经营周报')
    assert.equal(suggestWikiCategory({
      title: 'RAG 学习笔记',
      content: '课程摘录和知识整理。',
      sourceKind: 'manual',
      targetSpaceId: 'learning',
    }), '课程/学习笔记')

    const draft = wiki.createDraft({
      title: '审批通过率口径',
      content: '# 审批通过率口径\n\n通过率按当期已出决策的单量作为分母，处理中单据不进入分母。字段以数据库探测结果为准。',
      sourceKind: 'manual',
      sourceRef: 'manual/metrics',
      targetSpaceId: 'smart_query',
      categoryPath: '智能问数/审批指标',
      now: NOW,
    }, ['smart_query'])

    assert.equal(draft.categoryPath, '智能问数/审批指标')
    const published = wiki.publishDraft(draft.id, 'content_creation', ['content_creation'])
    assert.equal(published.page.categoryPath, '智能问数/审批指标')
    assert.equal(service.listDocuments().find(document => document.id === published.page.documentId)?.categoryPath, '智能问数/审批指标')
  })
})
