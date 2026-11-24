import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { loadCorpus, syncCorpus } from '../src/corpus.ts'
import { KnowledgeService } from '../src/service.ts'
import { SqliteKnowledgeRepository } from '../src/sqlite.ts'

const NOW = '2026-11-04T00:00:00+08:00'

function withCorpus(write: (root: string) => void): string {
  const root = mkdtempSync(join(tmpdir(), 'agentops-corpus-'))
  try {
    write(root)
  } catch (error) {
    rmSync(root, { recursive: true, force: true })
    throw error
  }
  return root
}

function space(root: string, dir: string, manifest: string): void {
  const path = join(root, dir)
  mkdirSync(path, { recursive: true })
  writeFileSync(join(path, 'space.yaml'), manifest, 'utf8')
}

function document(root: string, dir: string, file: string, text: string): void {
  writeFileSync(join(root, dir, file), text, 'utf8')
}

function withService(run: (service: KnowledgeService) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'agentops-corpus-db-'))
  const repository = new SqliteKnowledgeRepository(join(dir, 'knowledge.db'))
  try {
    run(KnowledgeService.open(repository))
  } finally {
    repository.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

void test('loadCorpus 读取分区清单与文档，标题缺省取一级标题', () => {
  const root = withCorpus((dir) => {
    space(dir, 'finance', 'id: finance\nname: 财务制度\n')
    document(dir, 'finance', 'travel.md', '---\nid: finance-travel\ntitle: 差旅办法\n---\n\n# 住宿\n\n每晚 600 元。\n')
    document(dir, 'finance', 'invoice.md', '---\nid: finance-invoice\n---\n\n# 发票核验\n\n抬头必须一致。\n')
  })
  try {
    const corpus = loadCorpus(root)
    assert.deepEqual(corpus.problems, [])
    assert.equal(corpus.spaces.length, 1)
    assert.equal(corpus.spaces[0]!.id, 'finance')
    assert.equal(corpus.spaces[0]!.visibility, 'shared')
    assert.equal(corpus.documents.length, 2)
    const travel = corpus.documents.find(item => item.id === 'finance-travel')!
    assert.equal(travel.title, '差旅办法')
    assert.equal(travel.spaceId, 'finance')
    assert.equal(travel.text, '# 住宿\n\n每晚 600 元。')
    assert.equal(travel.contentHash.length, 64)
    assert.equal(corpus.documents.find(item => item.id === 'finance-invoice')!.title, '发票核验')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

void test('loadCorpus 报告缺清单、非法标识、缺 front matter 与重复标识', () => {
  const root = withCorpus((dir) => {
    mkdirSync(join(dir, 'orphan'), { recursive: true })
    space(dir, 'finance', 'id: Finance\nname: 财务\n')
    space(dir, 'ops', 'id: ops\nname: 运维\n')
    document(dir, 'ops', 'plain.md', '# 没有 front matter\n')
    document(dir, 'ops', 'a.md', '---\nid: ops-shared\n---\n\n# 一\n')
    document(dir, 'ops', 'b.md', '---\nid: ops-shared\n---\n\n# 二\n')
    document(dir, 'ops', 'c.md', '---\nid: ops-empty\n---\n\n   \n')
  })
  try {
    const corpus = loadCorpus(root)
    const reasons = corpus.problems.map(problem => problem.reason).join('\n')
    assert.match(reasons, /缺少 space\.yaml/)
    assert.match(reasons, /空间标识必须匹配/)
    assert.match(reasons, /缺少 front matter/)
    assert.match(reasons, /文档标识重复：ops-shared/)
    assert.match(reasons, /正文为空/)
    assert.equal(corpus.spaces.length, 1, '非法清单的分区不得注册')
    assert.deepEqual(corpus.documents.map(item => item.id), ['ops-shared'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

void test('loadCorpus 在语料目录不存在时报告而不是抛错', () => {
  const corpus = loadCorpus(join(tmpdir(), 'agentops-corpus-missing-does-not-exist'))
  assert.equal(corpus.spaces.length, 0)
  assert.equal(corpus.problems[0]?.reason, '知识库目录不存在')
})

void test('loadCorpus 记录业务分类，分类移动不产生新内容版本', () => {
  const firstRoot = withCorpus((dir) => {
    space(dir, 'office_docs', 'id: office_docs\nname: 办公协作\ndescription: 办公过程知识\n')
    mkdirSync(join(dir, 'office_docs', '周报'), { recursive: true })
    document(dir, 'office_docs/周报', 'weekly.md', '---\nid: office-weekly\ntitle: 第 46 周经营周报\n---\n\n# 本周进展\n\n完成知识库目录重构。\n')
  })
  const secondRoot = withCorpus((dir) => {
    space(dir, 'office_docs', 'id: office_docs\nname: 办公协作\ndescription: 办公过程知识\n')
    mkdirSync(join(dir, 'office_docs', '会议记录'), { recursive: true })
    document(dir, 'office_docs/会议记录', 'weekly.md', '---\nid: office-weekly\ntitle: 第 46 周经营周报\n---\n\n# 本周进展\n\n完成知识库目录重构。\n')
  })
  try {
    const first = loadCorpus(firstRoot)
    assert.equal(first.documents[0]?.categoryPath, '周报')
    withService((service) => {
      syncCorpus(service, first, NOW)
      const original = service.listDocuments()[0]!
      assert.equal(original.categoryPath, '周报')
      assert.equal(original.currentVersion, 1)

      const moved = syncCorpus(service, loadCorpus(secondRoot), NOW)
      const current = service.listDocuments()[0]!
      assert.deepEqual(moved.documentsUpdated, ['office-weekly'])
      assert.equal(current.categoryPath, '会议记录')
      assert.equal(current.currentVersion, 1)
    })
  } finally {
    rmSync(firstRoot, { recursive: true, force: true })
    rmSync(secondRoot, { recursive: true, force: true })
  }
})

void test('syncCorpus 首次写入空间与文档，重复同步不产生新版本', () => {
  const root = withCorpus((dir) => {
    space(dir, 'finance', 'id: finance\nname: 财务制度\n')
    document(dir, 'finance', 'travel.md', '---\nid: finance-travel\ntitle: 差旅办法\n---\n\n# 住宿标准\n\n北京上海每晚 600 元。\n')
  })
  try {
    const corpus = loadCorpus(root)
    withService((service) => {
      const first = syncCorpus(service, corpus, NOW)
      assert.deepEqual(first.spacesCreated, ['finance'])
      assert.deepEqual(first.documentsCreated, ['finance-travel'])
      assert.deepEqual(service.listSpaces().map(item => item.name), ['财务制度'])
      assert.equal(service.listDocuments()[0]!.currentVersion, 1)
      assert.equal(service.search('住宿标准', ['finance']).length, 1)

      const second = syncCorpus(service, corpus, NOW)
      assert.deepEqual(second.documentsUnchanged, ['finance-travel'])
      assert.deepEqual(second.spacesCreated, [])
      assert.deepEqual(second.spacesUpdated, [])
      assert.equal(service.listDocuments()[0]!.currentVersion, 1, '内容未变不得追加版本')
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

void test('syncCorpus 内容变化追加版本，旧切片退出检索', () => {
  const root = withCorpus((dir) => {
    space(dir, 'finance', 'id: finance\nname: 财务制度\n')
    document(dir, 'finance', 'travel.md', '---\nid: finance-travel\ntitle: 差旅办法\n---\n\n# 住宿标准\n\n每晚 600 元。\n')
  })
  try {
    withService((service) => {
      syncCorpus(service, loadCorpus(root), NOW)
      document(root, 'finance', 'travel.md', '---\nid: finance-travel\ntitle: 差旅办法（修订）\n---\n\n# 住宿标准\n\n每晚 700 元。\n')
      const report = syncCorpus(service, loadCorpus(root), NOW)
      assert.deepEqual(report.documentsUpdated, ['finance-travel'])
      assert.equal(service.listDocuments()[0]!.currentVersion, 2)
      assert.equal(service.listDocuments()[0]!.title, '差旅办法（修订）')
      assert.equal(service.search('600', ['finance']).length, 0)
      assert.equal(service.search('700', ['finance']).length, 1)
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

void test('ensureSpace 幂等：同定义不改，改名或改可见性才算更新', () => {
  withService((service) => {
    assert.equal(service.ensureSpace({ id: 'content_creation', name: '内容创作', description: '内容模板', visibility: 'shared', readers: [] }), 'created')
    assert.equal(service.ensureSpace({ id: 'content_creation', name: '内容创作', description: '内容模板', visibility: 'shared', readers: [] }), 'unchanged')
    assert.equal(service.ensureSpace({ id: 'content_creation', name: '内容工作流', description: '内容模板与周报', visibility: 'restricted', readers: ['user:owner'] }), 'updated')
    const stored = service.listSpaces()[0]!
    assert.equal(stored.name, '内容工作流')
    assert.equal(stored.description, '内容模板与周报')
    assert.equal(stored.visibility, 'restricted')
    assert.deepEqual(stored.readers, ['user:owner'])
  })
})
