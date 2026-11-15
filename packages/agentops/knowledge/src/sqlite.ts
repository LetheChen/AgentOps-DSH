/**
 * SQLite persistence for the knowledge core.
 *
 * Uses Node's built-in `node:sqlite` so the knowledge package adds no native
 * dependency. Spaces, documents and versions are authoritative; chunks are
 * derived from a version and cascade away with their document.
 */

import { DatabaseSync } from 'node:sqlite'

import { KnowledgeStore } from './store.js'
import type { AddDocumentResult } from './store.js'
import { searchChunks } from './search.js'
import type { Chunk, DocumentMeta, DocumentVersion, KnowledgeSpace, SearchHit } from './types.js'
import { DEFAULT_WIKI_CATEGORY } from './wiki.js'
import type { WikiCategory, WikiConflict, WikiDraft, WikiOperation, WikiPage } from './wiki.js'

const SCHEMA = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS spaces (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  visibility  TEXT NOT NULL CHECK (visibility IN ('shared','restricted')),
  readers     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS documents (
  id              TEXT PRIMARY KEY,
  space_id        TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  title           TEXT NOT NULL,
  mime            TEXT NOT NULL,
  content_hash    TEXT NOT NULL,
  current_version INTEGER NOT NULL,
  status          TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS document_versions (
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  version     INTEGER NOT NULL,
  checksum    TEXT NOT NULL,
  parser      TEXT NOT NULL,
  chunk_count INTEGER NOT NULL,
  PRIMARY KEY (document_id, version)
);

CREATE TABLE IF NOT EXISTS chunks (
  id          TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  version     INTEGER NOT NULL,
  space_id    TEXT NOT NULL,
  ordinal     INTEGER NOT NULL,
  text        TEXT NOT NULL,
  start_off   INTEGER NOT NULL,
  end_off     INTEGER NOT NULL,
  page        INTEGER,
  section     TEXT,
  FOREIGN KEY (document_id, version) REFERENCES document_versions(document_id, version) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS ingestion_jobs (
  id          TEXT PRIMARY KEY,
  status      TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  finished_at TEXT,
  total       INTEGER NOT NULL,
  imported    INTEGER NOT NULL,
  skipped     INTEGER NOT NULL,
  failed      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS ingestion_documents (
  job_id      TEXT NOT NULL REFERENCES ingestion_jobs(id) ON DELETE CASCADE,
  document_id TEXT,
  path        TEXT NOT NULL,
  action      TEXT NOT NULL,
  error       TEXT,
  PRIMARY KEY (job_id, path)
);

CREATE TABLE IF NOT EXISTS wiki_drafts (
  id                    TEXT PRIMARY KEY,
  title                 TEXT NOT NULL,
  content               TEXT NOT NULL,
  source_kind           TEXT NOT NULL,
  source_ref            TEXT,
  source_task_id        TEXT,
  source_report_id      TEXT,
  page_type             TEXT NOT NULL,
  status                TEXT NOT NULL,
  target_space_id       TEXT,
  category_path         TEXT NOT NULL DEFAULT '待复核/自动归档',
  conflicts_json        TEXT NOT NULL,
  content_hash          TEXT NOT NULL,
  published_document_id TEXT,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS wiki_pages (
  id           TEXT PRIMARY KEY,
  draft_id     TEXT NOT NULL REFERENCES wiki_drafts(id) ON DELETE CASCADE,
  document_id  TEXT NOT NULL,
  space_id     TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  category_path TEXT NOT NULL DEFAULT '待复核/自动归档',
  title        TEXT NOT NULL,
  page_type    TEXT NOT NULL,
  summary      TEXT NOT NULL,
  source_refs  TEXT NOT NULL,
  status       TEXT NOT NULL,
  version      INTEGER NOT NULL,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS wiki_categories (
  space_id      TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  path          TEXT NOT NULL,
  review_status TEXT NOT NULL CHECK (review_status IN ('auto','reviewed')),
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  PRIMARY KEY (space_id, path)
);

CREATE TABLE IF NOT EXISTS wiki_operations (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  action      TEXT NOT NULL,
  draft_id    TEXT,
  page_id     TEXT,
  detail_json TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS chunks_space ON chunks(space_id);
CREATE INDEX IF NOT EXISTS chunks_doc ON chunks(document_id, version);
CREATE INDEX IF NOT EXISTS wiki_drafts_status ON wiki_drafts(status, updated_at DESC);
CREATE INDEX IF NOT EXISTS wiki_pages_space ON wiki_pages(space_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS wiki_categories_space ON wiki_categories(space_id, path);
CREATE INDEX IF NOT EXISTS wiki_operations_time ON wiki_operations(created_at DESC);
`

/** The durable record of one import run. */
export interface IngestionJobRecord {
  id: string
  status: 'running' | 'completed' | 'partial' | 'failed' | 'rolled-back'
  createdAt: string
  finishedAt?: string
  total: number
  imported: number
  skipped: number
  failed: number
}

/** What one file did during an import run. */
export interface IngestionDocumentRecord {
  documentId?: string
  path: string
  action: string
  error?: string
}

interface JobRow {
  id: string
  status: string
  created_at: string
  finished_at: string | null
  total: number
  imported: number
  skipped: number
  failed: number
}

interface JobDocRow { document_id: string | null; path: string; action: string; error: string | null }

interface SpaceRow { id: string; name: string; visibility: string; readers: string }
interface DocumentRow {
  id: string
  space_id: string
  title: string
  mime: string
  content_hash: string
  current_version: number
  status: string
  updated_at: string
}
interface ChunkRow {
  id: string
  document_id: string
  version: number
  space_id: string
  ordinal: number
  text: string
  start_off: number
  end_off: number
  page: number | null
  section: string | null
}

interface WikiDraftRow {
  id: string
  title: string
  content: string
  source_kind: string
  source_ref: string | null
  source_task_id: string | null
  source_report_id: string | null
  page_type: string
  status: string
  target_space_id: string | null
  category_path: string
  conflicts_json: string
  content_hash: string
  published_document_id: string | null
  created_at: string
  updated_at: string
}

interface WikiPageRow {
  id: string
  draft_id: string
  document_id: string
  space_id: string
  category_path: string
  title: string
  page_type: string
  summary: string
  source_refs: string
  status: string
  version: number
  created_at: string
  updated_at: string
}

interface WikiCategoryRow {
  space_id: string
  path: string
  review_status: string
  created_at: string
  updated_at: string
}

interface WikiOperationRow {
  id: number
  action: string
  draft_id: string | null
  page_id: string | null
  detail_json: string
  created_at: string
}

/**
 * A knowledge repository backed by one SQLite file.
 *
 * Reads keep the in-memory {@link KnowledgeStore} as the working copy; writes
 * are transactional per document version so a crash cannot leave chunks
 * without their version row.
 */
export class SqliteKnowledgeRepository {
  readonly #db: DatabaseSync

  constructor(path: string) {
    this.#db = new DatabaseSync(path)
    this.#db.exec(SCHEMA)
    this.#ensureColumn('wiki_drafts', 'category_path', `TEXT NOT NULL DEFAULT '${DEFAULT_WIKI_CATEGORY}'`)
    this.#ensureColumn('wiki_pages', 'category_path', `TEXT NOT NULL DEFAULT '${DEFAULT_WIKI_CATEGORY}'`)
    this.#db.exec(`
      INSERT OR IGNORE INTO wiki_categories(space_id, path, review_status, created_at, updated_at)
      SELECT space_id, category_path, 'auto', updated_at, updated_at FROM wiki_pages;
      INSERT OR IGNORE INTO wiki_categories(space_id, path, review_status, created_at, updated_at)
      SELECT target_space_id, category_path, 'auto', updated_at, updated_at
      FROM wiki_drafts WHERE target_space_id IS NOT NULL;
    `)
  }

  #ensureColumn(table: string, column: string, definition: string): void {
    const columns = this.#db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
    if (!columns.some(item => item.name === column)) {
      this.#db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
    }
  }

  /** Close the underlying database. */
  close(): void {
    this.#db.close()
  }

  /**
   * Load every space, document, version and chunk into a fresh store.
   * @returns hydrated store; callers own it.
   */
  load(): KnowledgeStore {
    const store = new KnowledgeStore()
    for (const row of this.#db.prepare('SELECT * FROM spaces ORDER BY id').all() as unknown as SpaceRow[]) {
      store.addSpace({
        id: row.id,
        name: row.name,
        visibility: row.visibility === 'restricted' ? 'restricted' : 'shared',
        readers: parseReaders(row.readers),
      })
    }

    const docs = this.#db.prepare('SELECT * FROM documents ORDER BY id').all() as unknown as DocumentRow[]
    const chunkStmt = this.#db.prepare('SELECT * FROM chunks WHERE document_id = ? ORDER BY version, ordinal')
    const versionStmt = this.#db.prepare('SELECT * FROM document_versions WHERE document_id = ? ORDER BY version')

    for (const doc of docs) {
      const rows = chunkStmt.all(doc.id) as unknown as ChunkRow[]
      const byVersion = new Map<number, Chunk[]>()
      for (const row of rows) {
        const list = byVersion.get(row.version) ?? []
        list.push({
          id: row.id,
          documentId: row.document_id,
          version: row.version,
          spaceId: row.space_id,
          ordinal: row.ordinal,
          text: row.text,
          locator: {
            start: row.start_off,
            end: row.end_off,
            ...(row.page === null ? {} : { page: row.page }),
            ...(row.section === null ? {} : { section: row.section }),
          },
        })
        byVersion.set(row.version, list)
      }
      const versions = (versionStmt.all(doc.id) as unknown as {
        document_id: string
        version: number
        checksum: string
        parser: string
        chunk_count: number
      }[]).map(row => ({
        documentId: row.document_id,
        version: row.version,
        checksum: row.checksum,
        parser: row.parser,
        chunkCount: row.chunk_count,
      }))
      store.hydrate({
        meta: {
          id: doc.id,
          spaceId: doc.space_id,
          title: doc.title,
          mime: doc.mime,
          contentHash: doc.content_hash,
          currentVersion: doc.current_version,
          status: doc.status === 'failed' ? 'failed' : doc.status === 'pending' ? 'pending' : 'indexed',
          updatedAt: doc.updated_at,
        },
        versions,
        chunksByVersion: byVersion,
      })
    }
    return store
  }

  /**
   * Insert or replace a space definition.
   * @param space - the space to store.
   */
  saveSpace(space: KnowledgeSpace): void {
    this.#db.prepare(`
      INSERT INTO spaces(id, name, visibility, readers) VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name, visibility = excluded.visibility, readers = excluded.readers
    `).run(space.id, space.name, space.visibility, JSON.stringify(space.readers))
  }

  /**
   * Persist one accepted document version and its chunks atomically.
   * @param result - value returned by `KnowledgeStore.addDocument`.
   */
  saveDocument(result: AddDocumentResult): void {
    const { meta, version, chunks } = result
    this.#db.exec('BEGIN')
    try {
      this.#db.prepare(`
        INSERT INTO documents(id, space_id, title, mime, content_hash, current_version, status, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          space_id = excluded.space_id, title = excluded.title, mime = excluded.mime,
          content_hash = excluded.content_hash, current_version = excluded.current_version,
          status = excluded.status, updated_at = excluded.updated_at
      `).run(meta.id, meta.spaceId, meta.title, meta.mime, meta.contentHash, meta.currentVersion, meta.status, meta.updatedAt)

      this.#db.prepare(`
        INSERT INTO document_versions(document_id, version, checksum, parser, chunk_count)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(document_id, version) DO UPDATE SET
          checksum = excluded.checksum, parser = excluded.parser, chunk_count = excluded.chunk_count
      `).run(version.documentId, version.version, version.checksum, version.parser, version.chunkCount)

      const insert = this.#db.prepare(`
        INSERT INTO chunks(id, document_id, version, space_id, ordinal, text, start_off, end_off, page, section)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      for (const chunk of chunks) {
        insert.run(
          chunk.id, chunk.documentId, chunk.version, chunk.spaceId, chunk.ordinal, chunk.text,
          chunk.locator.start, chunk.locator.end,
          chunk.locator.page ?? null, chunk.locator.section ?? null,
        )
      }
      this.#db.exec('COMMIT')
    } catch (error) {
      this.#db.exec('ROLLBACK')
      throw error
    }
  }

  /**
   * Delete a document; versions and chunks cascade.
   * @param documentId - the document to delete.
   * @returns whether a document was deleted.
   */
  deleteDocument(documentId: string): boolean {
    const result = this.#db.prepare('DELETE FROM documents WHERE id = ?').run(documentId)
    return result.changes > 0
  }

  /**
   * Search over persisted chunks, enforcing space visibility in SQL-adjacent
   * filtering before scoring.
   * @param query - user query.
   * @param allowedSpaces - readable spaces.
   * @param limit - optional cap.
   * @returns ranked hits.
   */
  search(query: string, allowedSpaces: readonly string[], limit?: number): SearchHit[] {
    if (allowedSpaces.length === 0) return []
    const placeholders = allowedSpaces.map(() => '?').join(',')
    const rows = this.#db.prepare(`
      SELECT c.* FROM chunks c
      JOIN documents d ON d.id = c.document_id AND d.current_version = c.version
      WHERE c.space_id IN (${placeholders})
    `).all(...allowedSpaces) as unknown as ChunkRow[]

    const chunks: Chunk[] = rows.map(row => ({
      id: row.id,
      documentId: row.document_id,
      version: row.version,
      spaceId: row.space_id,
      ordinal: row.ordinal,
      text: row.text,
      locator: {
        start: row.start_off,
        end: row.end_off,
        ...(row.page === null ? {} : { page: row.page }),
        ...(row.section === null ? {} : { section: row.section }),
      },
    }))
    return searchChunks(chunks, {
      query,
      allowedSpaces,
      ...(limit === undefined ? {} : { limit }),
    })
  }

  /**
   * List the persisted documents.
   * @returns the document metadata, newest first.
   */
  listDocuments(): DocumentMeta[] {
    return (this.#db.prepare('SELECT * FROM documents ORDER BY updated_at DESC').all() as unknown as DocumentRow[])
      .map(row => ({
        id: row.id,
        spaceId: row.space_id,
        title: row.title,
        mime: row.mime,
        contentHash: row.content_hash,
        currentVersion: row.current_version,
        status: row.status === 'failed' ? 'failed' : row.status === 'pending' ? 'pending' : 'indexed',
        updatedAt: row.updated_at,
      }))
  }

  /**
   * Record the start of an import run.
   * @param job - the job record to insert.
   */
  createIngestionJob(job: IngestionJobRecord): void {
    this.#db.prepare(`
      INSERT INTO ingestion_jobs(id, status, created_at, finished_at, total, imported, skipped, failed)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(job.id, job.status, job.createdAt, job.finishedAt ?? null, job.total, job.imported, job.skipped, job.failed)
  }

  /**
   * Record the end of an import run.
   * @param job - the finished job record.
   */
  finishIngestionJob(job: IngestionJobRecord): void {
    this.#db.prepare(`
      UPDATE ingestion_jobs SET status = ?, finished_at = ?, imported = ?, skipped = ?, failed = ? WHERE id = ?
    `).run(job.status, job.finishedAt ?? null, job.imported, job.skipped, job.failed, job.id)
  }

  /**
   * Record what one file did during an import run.
   * @param jobId - the import job id.
   * @param record - the per-file outcome.
   */
  recordIngestionDocument(jobId: string, record: IngestionDocumentRecord): void {
    this.#db.prepare(`
      INSERT INTO ingestion_documents(job_id, document_id, path, action, error)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(job_id, path) DO UPDATE SET
        document_id = excluded.document_id, action = excluded.action, error = excluded.error
    `).run(jobId, record.documentId ?? null, record.path, record.action, record.error ?? null)
  }

  /**
   * List the recorded import jobs.
   * @returns the job records, newest first.
   */
  listIngestionJobs(): IngestionJobRecord[] {
    return (this.#db.prepare('SELECT * FROM ingestion_jobs ORDER BY created_at DESC').all() as unknown as JobRow[])
      .map(row => ({
        id: row.id,
        status: normalizeJobStatus(row.status),
        createdAt: row.created_at,
        ...(row.finished_at === null ? {} : { finishedAt: row.finished_at }),
        total: row.total, imported: row.imported, skipped: row.skipped, failed: row.failed,
      }))
  }

  /**
   * List the files one import job touched.
   * @param jobId - the import job id.
   * @returns the per-file records of that job.
   */
  listIngestionDocuments(jobId: string): IngestionDocumentRecord[] {
    return (this.#db.prepare('SELECT * FROM ingestion_documents WHERE job_id = ? ORDER BY path').all(jobId) as unknown as JobDocRow[])
      .map(row => ({
        ...(row.document_id === null ? {} : { documentId: row.document_id }),
        path: row.path, action: row.action,
        ...(row.error === null ? {} : { error: row.error }),
      }))
  }

  /**
   * Insert or replace one wiki draft.
   * @param draft - draft record to persist.
   */
  saveWikiDraft(draft: WikiDraft): void {
    this.#db.prepare(`
      INSERT INTO wiki_drafts(
        id, title, content, source_kind, source_ref, source_task_id, source_report_id,
        page_type, status, target_space_id, category_path, conflicts_json, content_hash,
        published_document_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title, content = excluded.content, source_kind = excluded.source_kind,
        source_ref = excluded.source_ref, source_task_id = excluded.source_task_id,
        source_report_id = excluded.source_report_id, page_type = excluded.page_type,
        status = excluded.status, target_space_id = excluded.target_space_id,
        category_path = excluded.category_path, conflicts_json = excluded.conflicts_json, content_hash = excluded.content_hash,
        published_document_id = excluded.published_document_id, updated_at = excluded.updated_at
    `).run(
      draft.id, draft.title, draft.content, draft.sourceKind, draft.sourceRef,
      draft.sourceTaskId, draft.sourceReportId, draft.pageType, draft.status,
      draft.targetSpaceId, draft.categoryPath, JSON.stringify(draft.conflicts), draft.contentHash,
      draft.publishedDocumentId, draft.createdAt, draft.updatedAt,
    )
  }

  /**
   * Read one wiki draft.
   * @param draftId - draft identity.
   * @returns the draft, or undefined when it does not exist.
   */
  getWikiDraft(draftId: string): WikiDraft | undefined {
    const row = this.#db.prepare('SELECT * FROM wiki_drafts WHERE id = ?').get(draftId) as unknown as WikiDraftRow | undefined
    return row === undefined ? undefined : draftFromRow(row)
  }

  /**
   * List wiki drafts, newest first.
   * @returns all draft records.
   */
  listWikiDrafts(): WikiDraft[] {
    return (this.#db.prepare('SELECT * FROM wiki_drafts ORDER BY updated_at DESC').all() as unknown as WikiDraftRow[])
      .map(draftFromRow)
  }

  /**
   * Insert or replace one published wiki page.
   * @param page - page metadata to persist.
   */
  saveWikiPage(page: WikiPage): void {
    this.#db.prepare(`
      INSERT INTO wiki_pages(
        id, draft_id, document_id, space_id, category_path, title, page_type, summary,
        source_refs, status, version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        document_id = excluded.document_id, space_id = excluded.space_id,
        category_path = excluded.category_path, title = excluded.title,
        page_type = excluded.page_type, summary = excluded.summary,
        source_refs = excluded.source_refs, status = excluded.status,
        version = excluded.version, updated_at = excluded.updated_at
    `).run(
      page.id, page.draftId, page.documentId, page.spaceId, page.categoryPath, page.title,
      page.pageType, page.summary, JSON.stringify(page.sourceRefs), page.status,
      page.version, page.createdAt, page.updatedAt,
    )
  }

  /**
   * List published wiki pages, newest first.
   * @returns all page records.
   */
  listWikiPages(): WikiPage[] {
    return (this.#db.prepare('SELECT * FROM wiki_pages ORDER BY updated_at DESC').all() as unknown as WikiPageRow[])
      .map(pageFromRow)
  }

  /**
   * Insert or replace one Agent-maintained category.
   * @param category - persisted category identity and review state.
   */
  saveWikiCategory(category: WikiCategory): void {
    this.#db.prepare(`
      INSERT INTO wiki_categories(space_id, path, review_status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(space_id, path) DO UPDATE SET
        review_status = excluded.review_status, updated_at = excluded.updated_at
    `).run(category.spaceId, category.path, category.reviewStatus, category.createdAt, category.updatedAt)
  }

  /**
   * Read one category.
   * @param spaceId - owning knowledge space.
   * @param path - normalized category path.
   * @returns the category, or undefined when it does not exist.
   */
  getWikiCategory(spaceId: string, path: string): WikiCategory | undefined {
    const row = this.#db.prepare('SELECT * FROM wiki_categories WHERE space_id = ? AND path = ?')
      .get(spaceId, path) as unknown as WikiCategoryRow | undefined
    return row === undefined ? undefined : categoryFromRow(row, 0, 0)
  }

  /**
   * List all maintained categories.
   * @returns category records ordered by space and path.
   */
  listWikiCategories(): WikiCategory[] {
    return (this.#db.prepare('SELECT * FROM wiki_categories ORDER BY space_id, path').all() as unknown as WikiCategoryRow[])
      .map(row => categoryFromRow(row, 0, 0))
  }

  /**
   * Append one wiki operation to the audit timeline.
   * @param operation - operation without its generated sequence.
   * @returns the generated operation sequence.
   */
  appendWikiOperation(operation: Omit<WikiOperation, 'id'>): number {
    const result = this.#db.prepare(`
      INSERT INTO wiki_operations(action, draft_id, page_id, detail_json, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(operation.action, operation.draftId, operation.pageId, JSON.stringify(operation.detail), operation.createdAt)
    return Number(result.lastInsertRowid)
  }

  /**
   * List recent wiki operations.
   * @param limit - maximum rows, newest first.
   * @returns the operation timeline.
   */
  listWikiOperations(limit = 50): WikiOperation[] {
    return (this.#db.prepare('SELECT * FROM wiki_operations ORDER BY created_at DESC, id DESC LIMIT ?').all(limit) as unknown as WikiOperationRow[])
      .map(operationFromRow)
  }

  /**
   * List the stored versions of one document.
   * @param documentId - the document id.
   * @returns the version records, oldest first.
   */
  listVersions(documentId: string): DocumentVersion[] {
    const rows = this.#db.prepare('SELECT * FROM document_versions WHERE document_id = ? ORDER BY version').all(documentId) as unknown as {
      document_id: string
      version: number
      checksum: string
      parser: string
      chunk_count: number
    }[]
    return rows.map(row => ({
      documentId: row.document_id,
      version: row.version,
      checksum: row.checksum,
      parser: row.parser,
      chunkCount: row.chunk_count,
    }))
  }
}

function normalizeJobStatus(value: string): IngestionJobRecord['status'] {
  return value === 'completed' || value === 'partial' || value === 'failed' || value === 'rolled-back'
    ? value
    : 'running'
}

function parseReaders(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}

function draftFromRow(row: WikiDraftRow): WikiDraft {
  return {
    id: row.id,
    title: row.title,
    content: row.content,
    sourceKind: row.source_kind === 'task_report' || row.source_kind === 'archive' ? row.source_kind : 'manual',
    sourceRef: row.source_ref,
    sourceTaskId: row.source_task_id,
    sourceReportId: row.source_report_id,
    pageType: pageType(row.page_type),
    status: draftStatus(row.status),
    targetSpaceId: row.target_space_id,
    categoryPath: row.category_path || DEFAULT_WIKI_CATEGORY,
    conflicts: parseConflicts(row.conflicts_json),
    contentHash: row.content_hash,
    publishedDocumentId: row.published_document_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function pageFromRow(row: WikiPageRow): WikiPage {
  return {
    id: row.id,
    draftId: row.draft_id,
    documentId: row.document_id,
    spaceId: row.space_id,
    categoryPath: row.category_path || DEFAULT_WIKI_CATEGORY,
    title: row.title,
    pageType: pageType(row.page_type),
    summary: row.summary,
    sourceRefs: parseStringArray(row.source_refs),
    status: row.status === 'archived' ? 'archived' : 'published',
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function categoryFromRow(row: WikiCategoryRow, documentCount: number, draftCount: number): WikiCategory {
  return {
    spaceId: row.space_id,
    path: row.path,
    reviewStatus: row.review_status === 'reviewed' ? 'reviewed' : 'auto',
    documentCount,
    draftCount,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function operationFromRow(row: WikiOperationRow): WikiOperation {
  return {
    id: row.id,
    action: operationAction(row.action),
    draftId: row.draft_id,
    pageId: row.page_id,
    detail: parseObject(row.detail_json),
    createdAt: row.created_at,
  }
}

function pageType(value: string): WikiDraft['pageType'] {
  return value === 'source' || value === 'concept' || value === 'comparison' || value === 'overview'
    ? value
    : 'entity'
}

function draftStatus(value: string): WikiDraft['status'] {
  return value === 'ready' || value === 'conflicted' || value === 'published' || value === 'archived'
    ? value
    : 'inbox'
}

function operationAction(value: string): WikiOperation['action'] {
  return value === 'draft.create' || value === 'wiki.publish' || value === 'draft.archive'
    || value === 'category.create' || value === 'category.review'
    ? value
    : 'draft.check'
}

function parseStringArray(raw: string): string[] {
  try {
    const value: unknown = JSON.parse(raw)
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}

function parseConflicts(raw: string): WikiConflict[] {
  try {
    const value: unknown = JSON.parse(raw)
    if (!Array.isArray(value)) return []
    return value.filter((item): item is WikiConflict => {
      if (typeof item !== 'object' || item === null) return false
      const row = item as Record<string, unknown>
      return typeof row.code === 'string'
        && (row.severity === 'block' || row.severity === 'warn' || row.severity === 'info')
        && typeof row.message === 'string'
    })
  } catch {
    return []
  }
}

function parseObject(raw: string): Readonly<Record<string, unknown>> {
  try {
    const value: unknown = JSON.parse(raw)
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {}
  } catch {
    return {}
  }
}
