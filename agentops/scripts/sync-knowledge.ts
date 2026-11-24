/**
 * 知识库同步脚本：把 `packages/agentops/knowledge-base/` 的分区目录写进 SQLite。
 *
 * 语料是唯一可评审的来源：每个分区目录里有 `space.yaml` 与若干 Markdown，
 * 脚本按内容哈希判断是否需要新版本，重复执行不产生新版本。
 *
 * 用法：
 *   node --import tsx agentops/scripts/sync-knowledge.ts            # 只比对，不写入
 *   node --import tsx agentops/scripts/sync-knowledge.ts --write    # 写入
 *   node --import tsx agentops/scripts/sync-knowledge.ts --write --prune
 *
 * `--root <dir>` 指定其他语料目录；`--db <path>` 指定其他数据库（默认走
 * `resolveKnowledgeDbPath`：显式配置 → AGENTOPS_KNOWLEDGE_DB → $DSH_HOME/agentops/knowledge.db）。
 *
 * `--prune` 会删除「属于语料分区、但语料里已不存在」的文档；默认关闭，避免
 * 误删手工导入的内容。
 */

import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  KnowledgeService,
  SqliteKnowledgeRepository,
  documentIdsOf,
  loadCorpus,
  relativeToCorpus,
  resolveKnowledgeDbPath,
  syncCorpus,
} from '@agentops/dsh-knowledge'
import type { Corpus, CorpusSyncReport, DocumentMeta } from '@agentops/dsh-knowledge'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(scriptDir, '..', '..')

function argumentValue(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name)
  if (index < 0) return undefined
  return argv[index + 1]
}

function main(): void {
  const argv = process.argv.slice(2)
  const root = resolve(argumentValue(argv, '--root') ?? join(repoRoot, 'packages', 'agentops', 'knowledge-base'))
  const write = argv.includes('--write')
  const prune = argv.includes('--prune')

  const corpus = loadCorpus(root)
  if (corpus.spaces.length === 0) {
    process.stderr.write(`语料目录里没有可用分区：${root}\n`)
    for (const problem of corpus.problems) {
      process.stderr.write(`  ${relativeToCorpus(corpus, problem.path)}：${problem.reason}\n`)
    }
    process.exit(2)
  }

  const dbPath = argumentValue(argv, '--db') ?? resolveKnowledgeDbPath()
  const repository = new SqliteKnowledgeRepository(dbPath)
  try {
    const service = KnowledgeService.open(repository)

    process.stdout.write(`语料目录：${root}\n数据库：${dbPath}\n\n`)
    printCorpus(corpus)

    const existing = service.listDocuments()
    const pending = pendingDocuments(corpus, existing)
    const prunable = prune ? prunableDocuments(corpus, existing) : []

    if (!write) {
      process.stdout.write(`\n待写入 ${pending.length} 篇`)
      process.stdout.write(prunable.length > 0 ? `，待删除 ${prunable.length} 篇\n` : '\n')
      const known = new Set(existing.map(document => document.id))
      for (const document of pending) {
        process.stdout.write(`  ${known.has(document.id) ? '更新' : '新增'} ${document.id}\n`)
      }
      for (const id of prunable) process.stdout.write(`  删除 ${id}\n`)
      if (corpus.problems.length > 0) {
        process.stderr.write(`\n语料问题 ${corpus.problems.length} 处（先修好再加 --write）\n`)
        process.exit(1)
      }
      if (pending.length > 0 || prunable.length > 0) {
        process.stderr.write('\n--check 失败：语料与数据库不一致（跑 --write 写入）\n')
        process.exit(1)
      }
      process.stdout.write('\n--check 通过：数据库与语料一致\n')
      return
    }

    const report = syncCorpus(service, corpus, new Date().toISOString())
    const removed: string[] = []
    for (const id of prunable) {
      if (service.deleteDocument(id)) removed.push(id)
    }
    printReport(report, removed)
    if (corpus.problems.length > 0) process.exit(1)
  } finally {
    repository.close()
  }
}

function printCorpus(corpus: Corpus): void {
  process.stdout.write(`分区 ${corpus.spaces.length} 个，文档 ${corpus.documents.length} 篇\n`)
  for (const space of corpus.spaces) {
    const count = documentIdsOf(corpus, space.id).length
    process.stdout.write(`  ${space.id.padEnd(10)} ${space.name}（${space.visibility}）  ${count} 篇\n`)
  }
  for (const problem of corpus.problems) {
    process.stdout.write(`  问题 ${relativeToCorpus(corpus, problem.path)}：${problem.reason}\n`)
  }
}

function pendingDocuments(corpus: Corpus, existing: readonly DocumentMeta[]): Corpus['documents'] {
  const current = new Map(existing.map(document => [document.id, document]))
  return corpus.documents.filter((document) => {
    const meta = current.get(document.id)
    return meta === undefined
      || meta.spaceId !== document.spaceId
      || meta.categoryPath !== document.categoryPath
      || meta.title !== document.title
      || meta.contentHash !== document.contentHash
  })
}

function prunableDocuments(corpus: Corpus, existing: readonly DocumentMeta[]): string[] {
  const declared = new Set(corpus.documents.map(document => document.id))
  const spaceIds = new Set(corpus.spaces.map(space => space.id))
  return existing
    .filter(document => spaceIds.has(document.spaceId) && !declared.has(document.id))
    .map(document => document.id)
}

function printReport(report: CorpusSyncReport, removed: readonly string[]): void {
  process.stdout.write(
    `\n写入完成：空间 新建 ${report.spacesCreated.length} / 更新 ${report.spacesUpdated.length}；`
    + `文档 新建 ${report.documentsCreated.length} / 更新 ${report.documentsUpdated.length} / `
    + `未变 ${report.documentsUnchanged.length} / 删除 ${removed.length}\n`,
  )
  for (const id of report.documentsCreated) process.stdout.write(`  + ${id}\n`)
  for (const id of report.documentsUpdated) process.stdout.write(`  * ${id}\n`)
  for (const id of removed) process.stdout.write(`  - ${id}\n`)
  if (report.problems.length > 0) {
    process.stderr.write(`\n语料问题 ${report.problems.length} 处：\n`)
    for (const problem of report.problems) process.stderr.write(`  ${problem.path}：${problem.reason}\n`)
  }
}

main()
