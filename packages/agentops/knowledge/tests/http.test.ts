import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { domainSummaries } from '../src/http.ts'
import { KnowledgeService } from '../src/service.ts'
import { SqliteKnowledgeRepository } from '../src/sqlite.ts'

const NOW = '2026-11-16T00:00:00.000Z'

void test('domainSummaries 返回业务说明、页面数和分类统计', () => {
  const directory = mkdtempSync(join(tmpdir(), 'agentops-http-'))
  const repo = new SqliteKnowledgeRepository(join(directory, 'knowledge.db'))
  try {
    const service = KnowledgeService.open(repo)
    service.addSpace({
      id: 'smart_query', name: '业务资产', description: '业务口径、数据目录、查询方法与能力边界',
      visibility: 'shared', readers: [],
    })
    service.addDocument({
      id: 'metrics', spaceId: 'smart_query', categoryPath: '智能问数', title: '指标口径',
      mime: 'text/markdown', parser: 'md@1', contentHash: 'h1', now: NOW, text: '通过率口径',
    })
    service.addDocument({
      id: 'tables', spaceId: 'smart_query', categoryPath: '智能审批', title: '审批数据目录',
      mime: 'text/markdown', parser: 'md@1', contentHash: 'h2', now: NOW, text: '审批数据表',
    })

    const domain = domainSummaries(service)[0]!
    assert.equal(domain.display_name, '业务资产')
    assert.equal(domain.description, '业务口径、数据目录、查询方法与能力边界')
    assert.equal(domain.page_count, 2)
    assert.deepEqual(Object.fromEntries(domain.categories.map(category => [category.path, category.page_count])), {
      '智能问数': 1,
      '智能审批': 1,
    })
  } finally {
    repo.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
