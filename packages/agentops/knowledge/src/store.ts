import { chunkText, normalizeText, toChunks } from './chunk.js'
import { searchChunks } from './search.js'
import type {
  Chunk,
  Citation,
  DocumentId,
  DocumentMeta,
  DocumentVersion,
  KnowledgeSpace,
  SearchHit,
  SpaceId,
} from './types.js'

/** One document version submitted for indexing. */
export interface AddDocumentInput {
  id: DocumentId
  spaceId: SpaceId
  /** Optional category path inside the space; an empty value means the root. */
  categoryPath?: string
  /** Cross-cutting content tags; structure remains in spaceId and categoryPath. */
  tags?: readonly string[]
  title: string
  mime: string
  /** Raw extracted text; normalized before chunking. */
  text: string
  contentHash: string
  parser: string
  now: string
}

/** The accepted metadata, version and chunks of one indexed document. */
export interface AddDocumentResult {
  meta: DocumentMeta
  version: DocumentVersion
  chunks: readonly Chunk[]
}

interface StoredDocument {
  meta: DocumentMeta
  versions: Map<number, { version: DocumentVersion; chunks: Chunk[] }>
}

/**
 * Normalize operator-provided document tags without changing their display text.
 * @param tags - tags from corpus front matter or API input.
 * @returns unique non-empty tags in input order.
 */
export function normalizeDocumentTags(tags: readonly string[] | undefined): string[] {
  if (tags === undefined) return []
  return [...new Set(tags.map(tag => tag.trim()).filter(tag => tag.length > 0))]
}

/**
 * In-memory knowledge store.
 *
 * The shape mirrors the persistent model so a SQLite adapter can be dropped in
 * later without changing callers: spaces and documents are authoritative, and
 * chunks are always derived from one immutable version.
 */
export class KnowledgeStore {
  readonly #spaces = new Map<SpaceId, KnowledgeSpace>()
  readonly #documents = new Map<DocumentId, StoredDocument>()

  /**
   * Register a knowledge space.
   * @param space - the space to register.
   */
  addSpace(space: KnowledgeSpace): void {
    if (this.#spaces.has(space.id)) throw new Error(`space already exists: ${space.id}`)
    this.#spaces.set(space.id, {
      ...space,
      description: space.description,
      readers: [...space.readers],
    })
  }

  /**
   * Register or replace a knowledge space.
   * @param space - the space to store, replacing any existing definition.
   */
  upsertSpace(space: KnowledgeSpace): void {
    this.#spaces.set(space.id, {
      ...space,
      description: space.description,
      readers: [...space.readers],
    })
  }

  /**
   * List the registered spaces.
   * @returns copies of the registered spaces.
   */
  listSpaces(): KnowledgeSpace[] {
    return [...this.#spaces.values()].map(space => ({ ...space, readers: [...space.readers] }))
  }

  /**
   * Add a document version and index its chunks.
   * @param input - extracted text plus document identity, parser name, and content hash.
   * @returns the accepted metadata, version and chunks.
   */
  addDocument(input: AddDocumentInput): AddDocumentResult {
    if (!this.#spaces.has(input.spaceId)) throw new Error(`unknown space: ${input.spaceId}`)

    const normalized = normalizeText(input.text)
    if (normalized.length === 0) throw new Error('document text is empty after normalization')

    const existing = this.#documents.get(input.id)
    const version = (existing?.meta.currentVersion ?? 0) + 1
    const drafts = chunkText(normalized)
    const chunks = toChunks(drafts, {
      documentId: input.id,
      version,
      spaceId: input.spaceId,
    })

    const meta: DocumentMeta = {
      id: input.id,
      spaceId: input.spaceId,
      categoryPath: input.categoryPath ?? '',
      tags: normalizeDocumentTags(input.tags),
      title: input.title,
      mime: input.mime,
      contentHash: input.contentHash,
      currentVersion: version,
      status: 'indexed',
      updatedAt: input.now,
    }
    const record: DocumentVersion = {
      documentId: input.id,
      version,
      checksum: input.contentHash,
      parser: input.parser,
      chunkCount: chunks.length,
    }

    if (existing === undefined) {
      this.#documents.set(input.id, { meta, versions: new Map([[version, { version: record, chunks }]]) })
    } else {
      existing.meta = meta
      existing.versions.set(version, { version: record, chunks })
    }
    return { meta, version: record, chunks }
  }

  /**
   * Change the category metadata without creating a content version.
   * @param documentId - document to move.
   * @param categoryPath - normalized category path; empty means the root.
   * @param tags - replacement tag list; omitted leaves the stored tags unchanged.
   * @returns whether the document exists.
   */
  updateDocumentMetadata(documentId: DocumentId, categoryPath: string, tags?: readonly string[]): boolean {
    const stored = this.#documents.get(documentId)
    if (stored === undefined) return false
    stored.meta = {
      ...stored.meta,
      categoryPath,
      ...(tags === undefined ? {} : { tags: normalizeDocumentTags(tags) }),
    }
    return true
  }

  /**
   * Remove a document and every version's chunks.
   * @param documentId - document to remove.
   * @returns whether the document existed.
   */
  deleteDocument(documentId: DocumentId): boolean {
    return this.#documents.delete(documentId)
  }

  /**
   * Read one document's metadata.
   * @param documentId - the document id.
   * @returns the metadata, or undefined when the document is unknown.
   */
  getDocument(documentId: DocumentId): DocumentMeta | undefined {
    const meta = this.#documents.get(documentId)?.meta
    return meta === undefined ? undefined : { ...meta }
  }

  /**
   * Insert an already-persisted document (used when loading a repository).
   * Bypasses chunking because the persisted chunks are the derived truth.
   * @param input - metadata, version records and chunks grouped by version.
   */
  hydrate(input: {
    meta: DocumentMeta
    versions: readonly DocumentVersion[]
    chunksByVersion: ReadonlyMap<number, readonly Chunk[]>
  }): void {
    if (this.#documents.has(input.meta.id)) throw new Error(`document already exists: ${input.meta.id}`)
    const versions = new Map<number, { version: DocumentVersion; chunks: Chunk[] }>()
    for (const version of input.versions) {
      const chunks = [...(input.chunksByVersion.get(version.version) ?? [])]
      versions.set(version.version, { version: { ...version }, chunks })
    }
    this.#documents.set(input.meta.id, { meta: { ...input.meta }, versions })
  }

  /**
   * Chunks of the current version only; superseded versions are not searchable.
   * @returns the chunks of every current version.
   */
  listChunks(): Chunk[] {
    const chunks: Chunk[] = []
    for (const stored of this.#documents.values()) {
      const current = stored.versions.get(stored.meta.currentVersion)
      if (current !== undefined) chunks.push(...current.chunks)
    }
    return chunks
  }

  /**
   * Search with visibility enforcement.
   * @param query - user query.
   * @param allowedSpaces - spaces the caller may read.
   * @param limit - optional result cap.
   * @returns ranked hits.
   */
  search(query: string, allowedSpaces: readonly SpaceId[], limit?: number): SearchHit[] {
    return searchChunks(this.listChunks(), {
      query,
      allowedSpaces,
      ...(limit === undefined ? {} : { limit }),
    })
  }

  /**
   * Resolve a citation to the exact version and chunk it names.
   * @param citation - citation produced by an answer.
   * @returns the chunk, or undefined when the document/version is gone.
   */
  resolveCitation(citation: Citation): Chunk | undefined {
    const stored = this.#documents.get(citation.documentId)
    const current = stored?.versions.get(citation.version)
    return current?.chunks.find(chunk => chunk.id === citation.chunkId)
  }
}
