import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ImportRunner } from '../src/import-runner.ts'
import type { ImportPlanEntry } from '../src/import-plan.ts'
import { KnowledgeService } from '../src/service.ts'
import { SqliteKnowledgeRepository } from '../src/sqlite.ts'
import { resolveKnowledgeDbPath } from '../src/dsh.ts'

const NOW = '2026-10-25T00:00:00+08:00'

function plan(): ImportPlanEntry[] {
  return [
    { path: 'E:/Docs/a.md', action: 'import', reason: 'ok', spaceId: 'finance', contentHash: 'ha', sensitive: [] },
    { path: 'E:/Docs/b.md', action: 'import', reason: 'ok', spaceId: 'finance', contentHash: 'hb', sensitive: [] },
    { path: 'E:/Docs/dup.md', action: 'duplicate', reason: 'dup', sensitive: [] },
  ]
}

function withRepo(run: (repo: SqliteKnowledgeRepository, service: KnowledgeService, runner: ImportRunner) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'agentops-imp-'))
  const path = join(dir, 'kb.db')
  const repo = new SqliteKnowledgeRepository(path)
  const service = KnowledgeService.open(repo)
  service.addSpace({ id: 'finance', name: '财务', description: '', visibility: 'shared', readers: [] })
  const runner = new ImportRunner(service, repo)
  return run(repo, service, runner).finally(() => {
    repo.close()
    rmSync(dir, { recursive: true, force: true })
  })
}

void test('执行导入：只读可导入项，重复项记为跳过', async () => {
  await withRepo(async (repo, service, runner) => {
    const job = await runner.execute(plan(), async path => ({ text: `内容 ${path}` }))
    assert.equal(job.status, 'completed')
    assert.equal(job.imported, 2)
    assert.equal(job.skipped, 1)
    assert.equal(job.failed, 0)
    assert.equal(service.search('内容', ['finance']).length, 2)
    assert.equal(repo.listIngestionJobs().length, 1)
    assert.equal(repo.listIngestionDocuments(job.id).length, 3)
  })
})

void test('单个文件读取失败：其余继续，任务标记 partial 并记录错误', async () => {
  await withRepo(async (repo, service, runner) => {
    const job = await runner.execute(plan().slice(0, 2), async (path) => {
      if (path.endsWith('b.md')) throw new Error('权限不足')
      return { text: `内容 ${path}` }
    })
    assert.equal(job.status, 'partial')
    assert.equal(job.imported, 1)
    assert.equal(job.failed, 1)
    const docs = repo.listIngestionDocuments(job.id)
    assert.equal(docs.find(d => d.path.endsWith('b.md'))?.error, '权限不足')
    assert.equal(service.search('内容', ['finance']).length, 1)
  })
})

void test('回滚只删除该任务导入的文档，其它文档不受影响', async () => {
  await withRepo(async (repo, service, runner) => {
    service.addDocument({
      id: 'manual', spaceId: 'finance', title: '手工文档', mime: 'text/markdown',
      parser: 'md@1', contentHash: 'hm', now: NOW, text: '手工维护的内容',
    })
    const job = await runner.execute(plan(), async path => ({ text: `内容 ${path}` }))
    assert.equal(job.imported, 2)

    assert.equal(runner.rollback(job.id), 2)
    const remaining = service.listDocuments()
    assert.deepEqual(remaining.map(d => d.id), ['manual'])
    assert.equal(service.search('E:/Docs', ['finance']).length, 0)
    assert.equal(service.search('手工维护', ['finance']).length, 1)
    assert.equal(repo.listIngestionJobs()[0]?.status, 'rolled-back')
  })
})

void test('dbPath 解析：配置 > 环境变量 > DSH_HOME 默认', () => {
  assert.equal(resolveKnowledgeDbPath({ dbPath: '/x/kb.db', readableSpaces: [], allowedImportRoots: [] }), '/x/kb.db')
  assert.equal(
    resolveKnowledgeDbPath({ readableSpaces: [], allowedImportRoots: [] }, { AGENTOPS_KNOWLEDGE_DB: '/env/kb.db' }, '/home/u'),
    '/env/kb.db',
  )
  assert.equal(
    resolveKnowledgeDbPath({ readableSpaces: [], allowedImportRoots: [] }, { DSH_HOME: '/dsh' }, '/home/u'),
    join('/dsh', 'agentops', 'knowledge.db'),
  )
  assert.equal(
    resolveKnowledgeDbPath({ readableSpaces: [], allowedImportRoots: [] }, {}, '/home/u'),
    join('/home/u', '.dsh', 'agentops', 'knowledge.db'),
  )
})
