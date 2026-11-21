/**
 * Knowledge-domain vocabulary.
 *
 * The original file is immutable; a document's searchable form is derived from
 * a version, and citations point back at that version plus a locator. Indexes
 * are rebuildable, so nothing here treats them as the source of truth.
 */

export type SpaceId = string
/** Identity of one document. */
export type DocumentId = string
/** Identity of one chunk, derived from its document, version and ordinal. */
export type ChunkId = string

/** One knowledge space and who may read it. */
export interface KnowledgeSpace {
  id: SpaceId
  name: string
  /** What business field the space covers and which work it supports. */
  description: string
  /** Who may read the space; `user:<id>` entries scope it to one person. */
  visibility: 'shared' | 'restricted'
  /** Principals allowed to read a restricted space. Empty for shared. */
  readers: readonly string[]
}

/** The current state of one document. */
export interface DocumentMeta {
  id: DocumentId
  spaceId: SpaceId
  /** Slash-separated category path inside the space; empty means the root. */
  categoryPath: string
  /** Cross-cutting content tags used by retrieval and the memory graph. */
  tags: readonly string[]
  title: string
  mime: string
  /** Content hash of the current version; duplicate detection uses this. */
  contentHash: string
  currentVersion: number
  status: 'indexed' | 'pending' | 'failed'
  /** ISO timestamp of the last accepted version. */
  updatedAt: string
}

/** One stored version of a document. */
export interface DocumentVersion {
  documentId: DocumentId
  version: number
  checksum: string
  /** Parser identity, so a re-parse can be traced to its implementation. */
  parser: string
  chunkCount: number
}

/** Where a chunk sits inside the normalized text of one version. */
export interface Locator {
  /** 1-based page for paginated sources; absent for plain text. */
  page?: number
  /** Section heading path when the parser recovered one. */
  section?: string
  /** Character offsets inside the normalized text of this version. */
  start: number
  end: number
}

/** One searchable passage of a document version. */
export interface Chunk {
  id: ChunkId
  documentId: DocumentId
  version: number
  spaceId: SpaceId
  ordinal: number
  text: string
  locator: Locator
}

/** A reference from an answer to the chunk it came from. */
export interface Citation {
  chunkId: ChunkId
  documentId: DocumentId
  version: number
  spaceId: SpaceId
  /** Position inside the answer, so the UI can render inline references. */
  marker: number
}

/** One scored search result. */
export interface SearchHit {
  chunk: Chunk
  score: number
}

/** A search request with the spaces the caller may read. */
export interface SearchRequest {
  query: string
  /** Spaces the caller may read; empty means no results. */
  allowedSpaces: readonly SpaceId[]
  limit?: number
  documentId?: DocumentId
}
