import { KnowledgeStore } from './store.js'
import type { AddDocumentInput, AddDocumentResult } from './store.js'
import { isFlatWikiSpace } from './wiki.js'
import type { SqliteKnowledgeRepository } from './sqlite.js'
import type { Chunk, Citation, DocumentMeta, KnowledgeSpace, SearchHit, SpaceId } from './types.js'

/**
 * Write-through knowledge service: the in-memory store serves reads, the
 * repository makes them survive a restart.
 *
 * Ordering is deliberate — validate and chunk in memory first, then persist —
 * so a rejected document never reaches the database.
 */
export class KnowledgeService {
  constructor(
    private readonly store: KnowledgeStore,
    private readonly repository: SqliteKnowledgeRepository,
  ) {}

  /**
   * Open a repository and hydrate a working store from it.
   * @param repository - the repository the working store is hydrated from.
   * @returns a service whose in-memory store mirrors the repository.
   */
  static open(repository: SqliteKnowledgeRepository): KnowledgeService {
    return new KnowledgeService(repository.load(), repository)
  }

  /**
   * Register a knowledge space.
   * @param space - the space to register.
   */
  addSpace(space: KnowledgeSpace): void {
    this.store.addSpace(space)
    this.repository.saveSpace(space)
  }

  /**
   * Register a knowledge space, or replace its definition when it exists.
   * @param space - the space to register.
   * @returns whether the space was created, changed, or already current.
   */
  ensureSpace(space: KnowledgeSpace): 'created' | 'updated' | 'unchanged' {
    const normalized = { ...space }
    const current = this.store.listSpaces().find(item => item.id === normalized.id)
    if (current !== undefined && sameSpace(current, normalized)) return 'unchanged'
    this.store.upsertSpace(normalized)
    this.repository.saveSpace(normalized)
    return current === undefined ? 'created' : 'updated'
  }

  /**
   * Add a document version and index its chunks.
   * @param input - extracted text plus identity and content hash.
   * @returns the accepted metadata, version and chunks.
   */
  addDocument(input: AddDocumentInput): AddDocumentResult {
    const result = this.store.addDocument(isFlatWikiSpace(input.spaceId) ? { ...input, categoryPath: '' } : input)
    this.repository.saveDocument(result)
    return result
  }

  /**
   * Change document classification metadata without creating a content version.
   * @param documentId - document to move.
   * @param categoryPath - category path inside its space; empty means the root.
   * @param tags - optional replacement cross-cutting tags.
   * @returns whether the document exists.
   */
  updateDocumentMetadata(documentId: string, categoryPath: string, tags?: readonly string[]): boolean {
    const meta = this.store.getDocument(documentId)
    if (meta === undefined) return false
    const normalized = isFlatWikiSpace(meta.spaceId) ? '' : categoryPath
    if (!this.store.updateDocumentMetadata(documentId, normalized, tags)) return false
    this.repository.updateDocumentMetadata(documentId, normalized, tags)
    return true
  }

  /**
   * Remove a document and its indexed chunks.
   * @param documentId - document to remove.
   * @returns whether the document existed.
   */
  deleteDocument(documentId: string): boolean {
    const removed = this.store.deleteDocument(documentId)
    this.repository.deleteDocument(documentId)
    return removed
  }

  /**
   * Search the readable spaces.
   * @param query - user query.
   * @param allowedSpaces - spaces the caller may read.
   * @param limit - optional result cap.
   * @returns ranked hits.
   */
  search(query: string, allowedSpaces: readonly SpaceId[], limit?: number): SearchHit[] {
    return this.store.search(query, allowedSpaces, limit)
  }

  /**
   * Chunks of one document's current version, ordered by ordinal.
   * @param documentId - the document whose current version is read.
   * @returns the chunks of that version, ordered by ordinal.
   */
  chunksOf(documentId: string): Chunk[] {
    return this.store.listChunks()
      .filter(chunk => chunk.documentId === documentId)
      .sort((left, right) => left.ordinal - right.ordinal)
  }

  /**
   * Resolve a citation to the chunk it names.
   * @param citation - citation produced by an answer.
   * @returns the chunk, or undefined when the document or version is gone.
   */
  resolveCitation(citation: Citation): Chunk | undefined {
    return this.store.resolveCitation(citation)
  }

  /**
   * List the persisted documents.
   * @returns the document metadata, newest first.
   */
  listDocuments(): DocumentMeta[] {
    return this.repository.listDocuments()
  }

  /**
   * List the registered spaces.
   * @returns the spaces.
   */
  listSpaces(): KnowledgeSpace[] {
    return this.store.listSpaces()
  }

  /**
   * Expand configured grants with spaces whose visibility is shared.
   * An empty configured list keeps search closed for this deployment.
   * @param configured - spaces granted by deployment configuration.
   * @returns the unique readable space ids.
   */
  readableSpaces(configured: readonly SpaceId[]): SpaceId[] {
    if (configured.length === 0) return []
    const ids = new Set(configured)
    for (const space of this.listSpaces()) {
      if (space.visibility === 'shared') ids.add(space.id)
    }
    return [...ids]
  }

  /**
   * Existing content hashes, used to mark duplicates during import planning.
   * @returns the content hash of every persisted document.
   */
  existingHashes(): string[] {
    return this.repository.listDocuments().map(doc => doc.contentHash)
  }
}

function sameSpace(left: KnowledgeSpace, right: KnowledgeSpace): boolean {
  return left.name === right.name
    && left.description === right.description
    && left.visibility === right.visibility
    && left.readers.length === right.readers.length
    && left.readers.every((reader, index) => reader === right.readers[index])
}
