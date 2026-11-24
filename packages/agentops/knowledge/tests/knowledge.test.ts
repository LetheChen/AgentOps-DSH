import { test } from 'node:test'
import assert from 'node:assert/strict'

import { chunkText, normalizeText } from '../src/chunk.ts'
import { searchChunks, tokenize } from '../src/search.ts'
import { planImport, summarizePlan } from '../src/import-plan.ts'
import { KnowledgeStore } from '../src/store.ts'

const NOW = '2026-10-25T00:00:00+08:00'

function seed() {
  const store = new KnowledgeStore()
  store.addSpace({ id: 'finance', name: '财务与审批', description: '', visibility: 'shared', readers: [] })
  store.addSpace({ id: 'personal-u1', name: '个人', description: '', visibility: 'restricted', readers: ['user:u1'] })
  store.addDocument({
    id: 'doc-travel', spaceId: 'finance', title: '差旅费用管理办法',
    mime: 'application/pdf', parser: 'pdftotext@1',
    contentHash: 'hash-travel', now: NOW,
    text: '# 住宿标准\n\n北京上海住宿标准为每晚 600 元。\n\n# 交通\n\n市内交通实报实销。',
  })
  store.addDocument({
    id: 'doc-weekly', spaceId: 'personal-u1', title: '个人周报',
    mime: 'text/markdown', parser: 'markdown@1',
    contentHash: 'hash-weekly', now: NOW,
    text: '# 本周\n\n完成知识库迁移评估，等待评审。',
  })
  return store
}

void test('normalize 统一行尾与空行', () => {
  assert.equal(normalizeText('a\r\nb\r\n\r\n\r\n\r\nc   '), 'a\nb\n\nc')
})

void test('chunk 保留定位与标题分段，且确定性', () => {
  const text = normalizeText('# 一\n\n' + '甲'.repeat(300) + '\n\n# 二\n\n' + '乙'.repeat(300))
  const a = chunkText(text, { maxChars: 200, overlap: 20 })
  const b = chunkText(text, { maxChars: 200, overlap: 20 })
  assert.deepEqual(a, b)
  assert.ok(a.length >= 3)
  assert.equal(a[0]!.locator.start, 0)
  assert.equal(a[0]!.locator.section, '一')
  assert.ok(a.some(c => c.locator.section === '二'))
  assert.ok(a.every(c => c.text.length <= 200))
})

void test('tokenize：英文整词 + 中文二元组', () => {
  assert.deepEqual(tokenize('API Key 差旅标准'), ['api', 'key', '差旅', '旅标', '标准'])
})

void test('检索按可见空间过滤，且中文命中', () => {
  const store = seed()
  const hits = store.search('住宿标准', ['finance'])
  assert.ok(hits.length > 0)
  assert.equal(hits[0]!.chunk.documentId, 'doc-travel')

  const blocked = store.search('住宿标准', ['personal-u1'])
  assert.equal(blocked.length, 0, '不可见空间不得得分')
  assert.equal(store.search('住宿标准', []).length, 0)
})

void test('空查询与零结果返回空数组，不做模糊兜底', () => {
  const store = seed()
  assert.deepEqual(store.search('   ', ['finance']), [])
  assert.deepEqual(store.search('完全不存在的词', ['finance']), [])
})

void test('删除文档后其切片不可检索，历史版本不再参与', () => {
  const store = seed()
  assert.ok(store.search('住宿标准', ['finance']).length > 0)
  const updated = store.addDocument({
    id: 'doc-travel', spaceId: 'finance', title: '差旅费用管理办法(修订)',
    mime: 'application/pdf', parser: 'pdftotext@1',
    contentHash: 'hash-travel-2', now: NOW,
    text: '# 住宿标准\n\n北京上海住宿标准调整为每晚 700 元。',
  })
  assert.equal(updated.version.version, 2)
  const hits = store.search('600', ['finance'])
  assert.equal(hits.length, 0, '旧版本切片必须退出检索')

  assert.equal(store.deleteDocument('doc-travel'), true)
  assert.equal(store.search('700', ['finance']).length, 0)
})

void test('引用可解析到确切版本，删除后解析失败', () => {
  const store = seed()
  const hit = store.search('实报实销', ['finance'])[0]!
  const citation = {
    chunkId: hit.chunk.id,
    documentId: hit.chunk.documentId,
    version: hit.chunk.version,
    spaceId: hit.chunk.spaceId,
    marker: 1,
  }
  assert.equal(store.resolveCitation(citation)?.text.includes('实报实销'), true)
  store.deleteDocument('doc-travel')
  assert.equal(store.resolveCitation(citation), undefined)
})

void test('导入计划：越界、超限、重复、缺映射、敏感命中分别标注', () => {
  const plan = planImport([
    { path: 'E:/Docs/a.md', size: 100, mime: 'text/markdown', contentHash: 'h1', sample: '普通内容' },
    { path: 'E:/Other/b.md', size: 100, mime: 'text/markdown', contentHash: 'h2' },
    { path: 'E:/Docs/big.pdf', size: 60 * 1024 * 1024, mime: 'application/pdf', contentHash: 'h3' },
    { path: 'E:/Docs/video.mp4', size: 1024, mime: 'video/mp4', contentHash: 'h4' },
    { path: 'E:/Docs/dup.md', size: 10, mime: 'text/markdown', contentHash: 'h1' },
    { path: 'E:/Docs/../secret.md', size: 10, mime: 'text/markdown', contentHash: 'h5' },
    { path: 'E:/Docs/sens.md', size: 10, mime: 'text/markdown', contentHash: 'h6', sample: 'api_key=abcdef123456 10.1.2.3' },
  ], {
    allowedRoots: ['E:/Docs'],
    existingHashes: ['h1'],
    spaceMap: { 'E:/Docs': 'finance' },
  })

  const byPath = new Map(plan.map(e => [e.path, e]))
  assert.equal(byPath.get('E:/Docs/a.md')!.action, 'duplicate')
  assert.equal(byPath.get('E:/Other/b.md')!.action, 'outside-root')
  assert.equal(byPath.get('E:/Docs/big.pdf')!.action, 'too-large')
  assert.equal(byPath.get('E:/Docs/video.mp4')!.action, 'unsupported')
  assert.equal(byPath.get('E:/Docs/dup.md')!.action, 'duplicate')
  assert.equal(byPath.get('E:/Docs/../secret.md')!.action, 'outside-root')
  assert.deepEqual([...byPath.get('E:/Docs/sens.md')!.sensitive].sort(), ['credential-assignment', 'private-ipv4'])

  const summary = summarizePlan(plan)
  assert.equal(summary.total, 7)
  assert.equal(summary.sensitiveFiles, 1)
})

void test('导入计划：未匹配知识域时要求人工映射，不默认落库', () => {
  const plan = planImport(
    [{ path: 'E:/Docs/x.md', size: 10, mime: 'text/markdown', contentHash: 'hx' }],
    { allowedRoots: ['E:/Docs'] },
  )
  assert.equal(plan[0]!.action, 'needs-mapping')
  assert.equal(plan[0]!.spaceId, undefined)
})

void test('空文本拒绝入域，未知空间拒绝写入', () => {
  const store = new KnowledgeStore()
  store.addSpace({ id: 's', name: 'S', description: '', visibility: 'shared', readers: [] })
  assert.throws(() => store.addDocument({
    id: 'd', spaceId: 's', title: 't', mime: 'text/plain', parser: 'p', contentHash: 'h', now: NOW, text: '   ',
  }), /empty/)
  assert.throws(() => store.addDocument({
    id: 'd', spaceId: 'nope', title: 't', mime: 'text/plain', parser: 'p', contentHash: 'h', now: NOW, text: 'x',
  }), /unknown space/)
})

void test('BM25 排序：更匹配的切片排前', () => {
  const chunks = [
    { id: 'c1', documentId: 'd', version: 1, spaceId: 's', ordinal: 0, text: '差旅住宿标准 600 元', locator: { start: 0, end: 10 } },
    { id: 'c2', documentId: 'd', version: 1, spaceId: 's', ordinal: 1, text: '差旅住宿标准 住宿标准 住宿标准 700 元', locator: { start: 10, end: 20 } },
    { id: 'c3', documentId: 'd', version: 1, spaceId: 's', ordinal: 2, text: '交通报销', locator: { start: 20, end: 30 } },
  ]
  const hits = searchChunks(chunks, { query: '住宿标准', allowedSpaces: ['s'] })
  assert.equal(hits[0]!.chunk.id, 'c2')
  assert.ok(hits.every(h => h.chunk.id !== 'c3'))
})
