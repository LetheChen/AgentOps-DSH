import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { SqliteKnowledgeRepository } from '../src/sqlite.ts'
import { KnowledgeService } from '../src/service.ts'

const NOW = '2026-10-25T00:00:00+08:00'

function withTempRepo(run: (open: () => { repo: SqliteKnowledgeRepository; service: KnowledgeService }) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'agentops-kb-'))
  const path = join(dir, 'knowledge.db')
  try {
    run(() => {
      const repo = new SqliteKnowledgeRepository(path)
      return { repo, service: KnowledgeService.open(repo) }
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

void test('写入后可重开：空间、文档、切片与引用都在', () => {
  withTempRepo((open) => {
    const first = open()
    first.service.addSpace({ id: 'finance', name: '财务', description: '财务制度', visibility: 'shared', readers: [] })
    first.service.addDocument({
      id: 'doc-1', spaceId: 'finance', categoryPath: '差旅报销', title: '差旅办法', mime: 'text/markdown',
      parser: 'markdown@1', contentHash: 'h1', now: NOW,
      text: '# 住宿\n\n北京上海住宿标准每晚 600 元。',
    })
    const hit = first.service.search('住宿标准', ['finance'])[0]!
    first.repo.close()

    const second = open()
    const hits = second.service.search('住宿标准', ['finance'])
    assert.equal(hits.length, 1)
    assert.equal(hits[0]!.chunk.id, hit.chunk.id)
    assert.equal(hits[0]!.chunk.locator.section, '住宿')
    assert.equal(second.service.resolveCitation({
      chunkId: hit.chunk.id, documentId: 'doc-1', version: 1, spaceId: 'finance', marker: 1,
    })?.text.includes('600 元'), true)
    assert.equal(second.service.listDocuments().length, 1)
    assert.equal(second.service.listDocuments()[0]?.categoryPath, '')
    assert.equal(second.service.listSpaces()[0]?.description, '财务制度')
    second.repo.close()
  })
})

void test('新版本落库后旧版切片不再被检索，但版本记录保留', () => {
  withTempRepo((open) => {
    const { repo, service } = open()
    service.addSpace({ id: 's', name: 'S', description: '', visibility: 'shared', readers: [] })
    service.addDocument({
      id: 'd', spaceId: 's', title: 'v1', mime: 'text/markdown', parser: 'md@1',
      contentHash: 'h1', now: NOW, text: '住宿标准 600 元',
    })
    service.addDocument({
      id: 'd', spaceId: 's', title: 'v2', mime: 'text/markdown', parser: 'md@1',
      contentHash: 'h2', now: NOW, text: '住宿标准 700 元',
    })
    assert.equal(repo.search('600', ['s']).length, 0)
    assert.equal(repo.search('700', ['s']).length, 1)
    assert.deepEqual(repo.listVersions('d').map(v => v.version), [1, 2])
    repo.close()
  })
})

void test('删除文档级联清理版本与切片', () => {
  withTempRepo((open) => {
    const { repo, service } = open()
    service.addSpace({ id: 's', name: 'S', description: '', visibility: 'shared', readers: [] })
    service.addDocument({
      id: 'd', spaceId: 's', title: 't', mime: 'text/markdown', parser: 'md@1',
      contentHash: 'h', now: NOW, text: '可检索内容',
    })
    assert.equal(service.deleteDocument('d'), true)
    assert.equal(repo.search('可检索内容', ['s']).length, 0)
    assert.deepEqual(repo.listVersions('d'), [])
    assert.equal(repo.listDocuments().length, 0)
    repo.close()
  })
})

void test('持久层同样强制空间可见性', () => {
  withTempRepo((open) => {
    const { repo, service } = open()
    service.addSpace({ id: 'a', name: 'A', description: '', visibility: 'shared', readers: [] })
    service.addSpace({ id: 'b', name: 'B', description: '', visibility: 'restricted', readers: ['user:u1'] })
    service.addDocument({
      id: 'da', spaceId: 'a', title: 'A 文档', mime: 'text/markdown', parser: 'md@1',
      contentHash: 'ha', now: NOW, text: '共享知识',
    })
    service.addDocument({
      id: 'db', spaceId: 'b', title: 'B 文档', mime: 'text/markdown', parser: 'md@1',
      contentHash: 'hb', now: NOW, text: '私有知识',
    })
    assert.equal(repo.search('知识', ['a']).length, 1)
    assert.equal(repo.search('知识', ['b']).length, 1)
    assert.equal(repo.search('知识', []).length, 0)
    repo.close()
  })
})

void test('旧 weekly 空间迁移为内容创作并保留文档', () => {
  withTempRepo((open) => {
    const first = open()
    first.service.addSpace({ id: 'weekly', name: 'Weekly 周报', description: '周报', visibility: 'shared', readers: [] })
    first.service.addDocument({
      id: 'weekly-report', spaceId: 'weekly', categoryPath: '周报模板', title: '周报', mime: 'text/markdown',
      parser: 'md@1', contentHash: 'weekly-hash', now: NOW, text: '经营周报内容',
    })
    first.repo.close()

    const second = open()
    assert.equal(second.service.listSpaces()[0]?.id, 'content_creation')
    assert.equal(second.service.listSpaces()[0]?.name, '内容创作')
    assert.equal(second.service.listDocuments()[0]?.spaceId, 'content_creation')
    assert.equal(second.service.search('经营周报', ['content_creation']).length, 1)
    second.repo.close()
  })
})
