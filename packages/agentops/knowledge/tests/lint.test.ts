import { test } from 'node:test'
import assert from 'node:assert/strict'

import { lintIssues } from '../src/http.ts'
import { KnowledgeService } from '../src/service.ts'
import { SqliteKnowledgeRepository } from '../src/sqlite.ts'

const NOW = '2026-10-25T00:00:00+08:00'

function service(): KnowledgeService {
  const svc = KnowledgeService.open(new SqliteKnowledgeRepository(':memory:'))
  svc.addSpace({ id: 'finance', name: '财务', description: '', visibility: 'shared', readers: [] })
  svc.addSpace({ id: 'hr', name: '人事', description: '', visibility: 'restricted', readers: ['user:owner'] })
  svc.addDocument({
    id: 'doc-a', spaceId: 'finance', title: '差旅办法', mime: 'text/markdown',
    parser: 'md@1', contentHash: 'same', now: NOW, text: '住宿标准 600 元',
  })
  svc.addDocument({
    id: 'doc-b', spaceId: 'finance', title: '差旅办法副本', mime: 'text/markdown',
    parser: 'md@1', contentHash: 'same', now: NOW, text: '住宿标准 600 元',
  })
  svc.addDocument({
    id: 'doc-c', spaceId: 'hr', title: '请假制度', mime: 'text/markdown',
    parser: 'md@1', contentHash: 'same', now: NOW, text: '年假 5 天',
  })
  return svc
}

void test('lint：同哈希文档产出 index_sync 警告，且只报重复者', () => {
  const issues = lintIssues(service(), ['finance', 'hr'])
  const duplicates = issues.filter(issue => issue.id.startsWith('duplicate:'))
  assert.equal(duplicates.length, 2)
  assert.deepEqual(duplicates.map(issue => issue.type), ['index_sync', 'index_sync'])
  assert.ok(duplicates.every(issue => issue.severity === 'warning'))
  assert.ok(duplicates.every(issue => ! issue.auto_fixable))
})

void test('lint：未授权知识域不出现在结果里', () => {
  const issues = lintIssues(service(), ['finance'])
  assert.equal(issues.length, 1)
  assert.equal(issues[0]!.domain, 'finance')
})

void test('lint：干净库返回空列表', () => {
  const svc = KnowledgeService.open(new SqliteKnowledgeRepository(':memory:'))
  svc.addSpace({ id: 's', name: 'S', description: '', visibility: 'shared', readers: [] })
  svc.addDocument({
    id: 'only', spaceId: 's', title: 'T', mime: 'text/plain',
    parser: 'text@1', contentHash: 'h', now: NOW, text: '内容',
  })
  assert.deepEqual(lintIssues(svc, ['s']), [])
})
