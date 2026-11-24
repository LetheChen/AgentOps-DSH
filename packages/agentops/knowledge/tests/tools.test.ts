import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createImportPlanTool, createSearchTool } from '../src/dsh.ts'
import { apply } from '../src/tools.ts'
import { KnowledgeService } from '../src/service.ts'
import { SqliteKnowledgeRepository } from '../src/sqlite.ts'

const NOW = '2026-10-25T00:00:00+08:00'

function service(seed = true): KnowledgeService {
  const repo = new SqliteKnowledgeRepository(':memory:')
  const svc = KnowledgeService.open(repo)
  if (seed) {
    svc.addSpace({ id: 'finance', name: '财务', description: '', visibility: 'shared', readers: [] })
    svc.addDocument({
      id: 'doc-travel', spaceId: 'finance', title: '差旅办法', mime: 'text/markdown',
      parser: 'md@1', contentHash: 'h-travel', now: NOW,
      text: '# 住宿\n\n北京上海住宿标准每晚 600 元。\n\n# 交通\n\n市内交通实报实销。',
    })
  }
  return svc
}

const CONFIG = {
  dbPath: ':memory:',
  readableSpaces: ['finance'],
  allowedImportRoots: ['E:/Docs'],
  spaceMap: { 'E:/Docs': 'finance' },
}

interface SearchHit {
  documentId: string
  version: number
  locator: { section: string }
}

interface SearchValue {
  hits: SearchHit[]
}

interface PlanValue {
  total: number
  byAction: Record<string, number>
  sensitiveFiles: number
  entries: { contentHash: string; sensitive: unknown[] }[]
}

const exec = <T>(tool: unknown, args: Record<string, unknown>): Promise<T> =>
  (tool as { execute: (a: never, e: never) => Promise<T> }).execute(args as never, {} as never)


void test('knowledge_search：命中带定位，空结果不编造', async () => {
  const svc = service()
  const tool = createSearchTool(svc, CONFIG)
  const value = await exec<SearchValue>(tool, { query: '住宿标准' })
  assert.equal(value.hits.length, 1)
  assert.equal(value.hits[0]!.documentId, 'doc-travel')
  assert.equal(value.hits[0]!.version, 1)
  assert.equal(value.hits[0]!.locator.section, '住宿')

  const empty = await exec<SearchValue>(tool, { query: '不存在的词' })
  assert.equal(empty.hits.length, 0)
  const blocks = tool.output.render({}, empty as never) as { text: string }[]
  assert.match(blocks[0]!.text, /Do not fabricate a citation/)
})

void test('knowledge_search：空可见空间永远零结果', async () => {
  const svc = service()
  const tool = createSearchTool(svc, { ...CONFIG, readableSpaces: [] })
  const value = await exec<SearchValue>(tool, { query: '住宿标准' })
  assert.equal(value.hits.length, 0)
})

void test('knowledge_import_plan：只出计划、标出敏感与越界', async () => {
  const svc = service()
  const tool = createImportPlanTool(svc, CONFIG)
  const value = await exec<PlanValue>(tool, {
    candidates: [
      { path: 'E:/Docs/new.md', size: 10, mime: 'text/markdown', contentHash: 'hn' },
      { path: 'E:/Docs/dup.md', size: 10, mime: 'text/markdown', contentHash: 'h-travel' },
      { path: 'E:/Other/x.md', size: 10, mime: 'text/markdown', contentHash: 'ho' },
      { path: 'E:/Docs/s.md', size: 10, mime: 'text/markdown', contentHash: 'hs', sample: 'token=abcdef123456' },
    ],
  })

  assert.equal(value.total, 4)
  assert.equal(value.byAction.import, 2)
  assert.equal(value.byAction.duplicate, 1)
  assert.equal(value.byAction['outside-root'], 1)
  assert.equal(value.sensitiveFiles, 1)
  assert.equal(value.entries.find(e => e.contentHash === 'hs')!.sensitive.length, 1)
})

void test('插件挂载注册检索、导入计划与 LLM Wiki 工具', () => {
  const registered: string[] = []
  const ctx = { tools: { register: (def: { name: string }) => { registered.push(def.name); return () => {} } } }
  apply(ctx as never, { ...CONFIG, dbPath: ':memory:' })
  assert.deepEqual(registered.sort(), [
    'knowledge_import_plan',
    'knowledge_search',
    'knowledge_wiki_categories',
    'knowledge_wiki_check',
    'knowledge_wiki_draft',
    'knowledge_wiki_publish',
  ])
})
