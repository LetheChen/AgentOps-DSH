import { test } from 'node:test'
import assert from 'node:assert/strict'

import { askKnowledge } from '../src/http.ts'
import { KnowledgeService } from '../src/service.ts'
import { SqliteKnowledgeRepository } from '../src/sqlite.ts'

const NOW = '2026-10-25T00:00:00+08:00'

function service(): KnowledgeService {
  const svc = KnowledgeService.open(new SqliteKnowledgeRepository(':memory:'))
  svc.addSpace({ id: 'finance', name: '财务', visibility: 'shared', readers: [] })
  svc.addSpace({ id: 'secret', name: '机密', visibility: 'restricted', readers: ['user:owner'] })
  svc.addDocument({
    id: 'doc-travel', spaceId: 'finance', title: '差旅报销办法', mime: 'text/markdown',
    parser: 'md@1', contentHash: 'h1', now: NOW,
    text: '# 住宿\n\n北京上海住宿标准每晚 600 元。',
  })
  svc.addDocument({
    id: 'doc-secret', spaceId: 'secret', title: '机密制度', mime: 'text/markdown',
    parser: 'md@1', contentHash: 'h2', now: NOW,
    text: '# 住宿\n\n机密住宿标准 9999 元。',
  })
  return svc
}

void test('askKnowledge：返回带序号的版本化引用，且不含生成答案', () => {
  const result = askKnowledge(service(), '住宿标准', ['finance'])
  assert.equal(result.composed, false)
  assert.equal(result.citations.length, 1)
  const first = result.citations[0]!
  assert.equal(first.marker, 1)
  assert.equal(first.citation.documentId, 'doc-travel')
  assert.equal(first.citation.title, '差旅报销办法')
  assert.equal(first.citation.version, 1)
  assert.equal(first.citation.section, '住宿')
  assert.match(first.text, /600 元/)
})

void test('askKnowledge：未授权知识域不参与，空授权零引用', () => {
  const svc = service()
  const restricted = askKnowledge(svc, '住宿标准', ['finance', 'secret'])
  assert.equal(restricted.citations.length, 2)
  assert.ok(restricted.citations.every(item => item.marker >= 1))

  assert.deepEqual(askKnowledge(svc, '住宿标准', []), { composed: false, citations: [] })
})

void test('askKnowledge：limit 生效', () => {
  const svc = service()
  const result = askKnowledge(svc, '住宿标准', ['finance', 'secret'], 1)
  assert.equal(result.citations.length, 1)
})

void test('askKnowledge：启用部署后，新建 shared 知识域自动可读，restricted 仍需显式授权', () => {
  const svc = service()
  svc.addSpace({ id: 'project', name: '项目分析', visibility: 'shared', readers: [] })
  svc.addDocument({
    id: 'doc-project', spaceId: 'project', title: 'Strata 技术资料', mime: 'text/markdown',
    parser: 'md@1', contentHash: 'h3', now: NOW,
    text: '# Strata\n\n12G 显卡通过整机协同与 MTP 解码运行 Qwen3.8。',
  })

  const result = askKnowledge(svc, 'Strata 12G MTP', ['finance'])
  assert.ok(result.citations.some(item => item.citation.spaceId === 'project'))
  assert.ok(result.citations.every(item => item.citation.spaceId !== 'secret'))
})
