/**
 * File-tree corpus for the knowledge base.
 *
 * The corpus is the reviewable source of truth for space content: one
 * directory per space holds a `space.yaml` and its Markdown documents, so a
 * space can be added or edited without touching code or the database. Loading
 * is read-only; {@link syncCorpus} is the only place that writes.
 *
 * @module @agentops/dsh-knowledge/corpus
 */

import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, extname, join, relative } from 'node:path'

import { parse as parseYaml } from 'yaml'

import { normalizeText } from './chunk.ts'
import type { AddDocumentInput } from './store.ts'
import type { DocumentMeta, KnowledgeSpace } from './types.ts'

/** Space manifest file inside each space directory. */
export const SPACE_MANIFEST = 'space.yaml'

/** Document extension the corpus accepts. */
export const DOCUMENT_EXTENSION = '.md'

/** Parser label recorded for corpus documents. */
export const CORPUS_PARSER = 'markdown@1'

const SPACE_ID = /^[a-z0-9][a-z0-9_-]*$/
const DOCUMENT_ID = /^[a-z0-9][a-z0-9_-]*$/

/** One space directory and the policy its manifest declares. */
export interface CorpusSpace {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly visibility: KnowledgeSpace['visibility']
  readonly readers: readonly string[]
  /** Absolute directory holding the manifest and its documents. */
  readonly directory: string
}

/** One Markdown document with its extracted text and content hash. */
export interface CorpusDocument {
  readonly id: string
  readonly spaceId: string
  readonly title: string
  /** Absolute file path. */
  readonly path: string
  /** Body without front matter. */
  readonly text: string
  /** SHA-256 of the normalized body; re-syncing an unchanged file is a no-op. */
  readonly contentHash: string
}

/** A file the loader refused, with the reason shown to the operator. */
export interface CorpusProblem {
  readonly path: string
  readonly reason: string
}

/** Everything one corpus directory holds. */
export interface Corpus {
  readonly root: string
  readonly spaces: readonly CorpusSpace[]
  readonly documents: readonly CorpusDocument[]
  readonly problems: readonly CorpusProblem[]
}

/**
 * Read a corpus directory tree.
 *
 * A space directory without a usable manifest is reported as a problem rather
 * than guessed; a document without an `id` in its front matter is reported
 * instead of being named after its file, because ids appear in citations and
 * document routes.
 * @param root - absolute corpus root.
 * @returns the spaces, documents and problems found.
 */
export function loadCorpus(root: string): Corpus {
  const problems: CorpusProblem[] = []
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    return { root, spaces: [], documents: [], problems: [{ path: root, reason: '知识库目录不存在' }] }
  }

  const spaces: CorpusSpace[] = []
  const documents: CorpusDocument[] = []
  const spaceIds = new Set<string>()
  const documentIds = new Set<string>()

  for (const entry of readdirSync(root, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory()) continue
    const directory = join(root, entry.name)
    const space = readSpace(directory, problems)
    if (space === undefined) continue
    if (spaceIds.has(space.id)) {
      problems.push({ path: directory, reason: `空间标识重复：${space.id}` })
      continue
    }
    spaceIds.add(space.id)
    spaces.push(space)

    for (const file of listMarkdown(directory)) {
      const document = readDocument(file, space.id, problems)
      if (document === undefined) continue
      if (documentIds.has(document.id)) {
        problems.push({ path: file, reason: `文档标识重复：${document.id}` })
        continue
      }
      documentIds.add(document.id)
      documents.push(document)
    }
  }

  return { root, spaces, documents, problems }
}

/** How one space registration was applied. */
export type SpaceWrite = 'created' | 'updated' | 'unchanged'

/** The writes a corpus needs, in the order they were applied. */
export interface CorpusSyncReport {
  readonly spacesCreated: readonly string[]
  readonly spacesUpdated: readonly string[]
  readonly documentsCreated: readonly string[]
  readonly documentsUpdated: readonly string[]
  readonly documentsUnchanged: readonly string[]
  readonly problems: readonly CorpusProblem[]
}

/** The write surface {@link syncCorpus} needs; `KnowledgeService` satisfies it. */
export interface CorpusSyncTarget {
  /** Register or replace a space, reporting what changed. */
  ensureSpace(space: KnowledgeSpace): SpaceWrite
  /** Current document metadata, used to detect unchanged content. */
  listDocuments(): DocumentMeta[]
  /** Accept one document version. */
  addDocument(input: AddDocumentInput): unknown
}

/**
 * Apply a loaded corpus to a knowledge store.
 *
 * Unchanged documents are skipped by content hash, so a repeated sync writes
 * nothing and does not advance versions.
 * @param target - the write surface to apply to.
 * @param corpus - value returned by {@link loadCorpus}.
 * @param now - ISO timestamp recorded on accepted versions.
 * @returns the applied writes and the loader problems carried through.
 */
export function syncCorpus(target: CorpusSyncTarget, corpus: Corpus, now: string): CorpusSyncReport {
  const spacesCreated: string[] = []
  const spacesUpdated: string[] = []
  const documentsCreated: string[] = []
  const documentsUpdated: string[] = []
  const documentsUnchanged: string[] = []

  for (const space of corpus.spaces) {
    const outcome = target.ensureSpace({
      id: space.id,
      name: space.name,
      visibility: space.visibility,
      readers: [...space.readers],
    })
    if (outcome === 'created') spacesCreated.push(space.id)
    else if (outcome === 'updated') spacesUpdated.push(space.id)
  }

  const existing = new Map(target.listDocuments().map(document => [document.id, document]))
  for (const document of corpus.documents) {
    const current = existing.get(document.id)
    if (
      current !== undefined
      && current.spaceId === document.spaceId
      && current.title === document.title
      && current.contentHash === document.contentHash
    ) {
      documentsUnchanged.push(document.id)
      continue
    }
    target.addDocument({
      id: document.id,
      spaceId: document.spaceId,
      title: document.title,
      mime: 'text/markdown',
      parser: CORPUS_PARSER,
      contentHash: document.contentHash,
      now,
      text: document.text,
    })
    if (current === undefined) documentsCreated.push(document.id)
    else documentsUpdated.push(document.id)
  }

  return {
    spacesCreated,
    spacesUpdated,
    documentsCreated,
    documentsUpdated,
    documentsUnchanged,
    problems: corpus.problems,
  }
}

/**
 * List the corpus document ids declared under one space.
 * @param corpus - value returned by {@link loadCorpus}.
 * @param spaceId - the space to filter by.
 * @returns document ids of that space, in load order.
 */
export function documentIdsOf(corpus: Corpus, spaceId: string): string[] {
  return corpus.documents.filter(document => document.spaceId === spaceId).map(document => document.id)
}

function readSpace(directory: string, problems: CorpusProblem[]): CorpusSpace | undefined {
  const manifest = join(directory, SPACE_MANIFEST)
  if (!existsSync(manifest)) {
    problems.push({ path: directory, reason: `缺少 ${SPACE_MANIFEST}，无法确定空间标识` })
    return undefined
  }
  let parsed: unknown
  try {
    parsed = parseYaml(readFileSync(manifest, 'utf8'))
  } catch (error) {
    problems.push({ path: manifest, reason: `YAML 解析失败：${messageOf(error)}` })
    return undefined
  }
  if (parsed === null || typeof parsed !== 'object') {
    problems.push({ path: manifest, reason: '清单内容必须是对象' })
    return undefined
  }
  const record = parsed as Record<string, unknown>
  const id = typeof record.id === 'string' ? record.id.trim() : ''
  const name = typeof record.name === 'string' ? record.name.trim() : ''
  if (!SPACE_ID.test(id)) {
    problems.push({ path: manifest, reason: `空间标识必须匹配 ${String(SPACE_ID)}：${JSON.stringify(record.id)}` })
    return undefined
  }
  if (name.length === 0) {
    problems.push({ path: manifest, reason: '缺少空间名称 name' })
    return undefined
  }
  const visibility = record.visibility === 'restricted' ? 'restricted' : 'shared'
  const readers = Array.isArray(record.readers)
    ? record.readers.filter((item): item is string => typeof item === 'string' && item.length > 0)
    : []
  return {
    id,
    name,
    description: typeof record.description === 'string' ? record.description.trim() : '',
    visibility,
    readers,
    directory,
  }
}

function readDocument(file: string, spaceId: string, problems: CorpusProblem[]): CorpusDocument | undefined {
  const raw = readFileSync(file, 'utf8')
  const split = splitFrontMatter(raw)
  if (split === undefined) {
    problems.push({ path: file, reason: '缺少 front matter，需要在文件开头声明 id' })
    return undefined
  }
  let front: unknown
  try {
    front = parseYaml(split.front)
  } catch (error) {
    problems.push({ path: file, reason: `front matter 解析失败：${messageOf(error)}` })
    return undefined
  }
  const record = front !== null && typeof front === 'object' ? front as Record<string, unknown> : {}
  const id = typeof record.id === 'string' ? record.id.trim() : ''
  if (!DOCUMENT_ID.test(id)) {
    problems.push({ path: file, reason: `文档标识必须匹配 ${String(DOCUMENT_ID)}：${JSON.stringify(record.id)}` })
    return undefined
  }
  const text = split.body.trim()
  if (text.length === 0) {
    problems.push({ path: file, reason: '正文为空' })
    return undefined
  }
  const declaredTitle = typeof record.title === 'string' ? record.title.trim() : ''
  const title = declaredTitle.length > 0 ? declaredTitle : (firstHeading(text) ?? basename(file, extname(file)))
  return {
    id,
    spaceId,
    title,
    path: file,
    text,
    contentHash: createHash('sha256').update(normalizeText(text)).digest('hex'),
  }
}

function splitFrontMatter(raw: string): { front: string; body: string } | undefined {
  const normalized = raw.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
  if (!normalized.startsWith('---\n')) return undefined
  const end = normalized.indexOf('\n---', 3)
  if (end === -1) return undefined
  const front = normalized.slice(4, end + 1)
  const rest = normalized.slice(end + 4)
  return { front, body: rest.startsWith('\n') ? rest.slice(1) : rest }
}

function firstHeading(text: string): string | undefined {
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.startsWith('# ')) return trimmed.slice(2).trim()
  }
  return undefined
}

function listMarkdown(directory: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...listMarkdown(path))
    else if (entry.isFile() && extname(entry.name).toLowerCase() === DOCUMENT_EXTENSION) files.push(path)
  }
  return files
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Render one file's path relative to the corpus root, for operator output.
 * @param corpus - value returned by {@link loadCorpus}.
 * @param path - absolute path inside the corpus.
 * @returns the root-relative path with forward slashes.
 */
export function relativeToCorpus(corpus: Corpus, path: string): string {
  return relative(corpus.root, path).replace(/\\/g, '/')
}
