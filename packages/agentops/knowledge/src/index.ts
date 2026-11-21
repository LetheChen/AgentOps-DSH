export type {
  Chunk,
  Citation,
  DocumentId,
  DocumentMeta,
  DocumentVersion,
  KnowledgeSpace,
  Locator,
  SearchHit,
  SearchRequest,
  SpaceId,
} from './types.ts'
export { chunkText, normalizeText, toChunks } from './chunk.ts'
export type { ChunkDraft, ChunkOptions } from './chunk.ts'
export { searchChunks, tokenize } from './search.ts'
export type { ImportAction, ImportCandidate, ImportOptions, ImportPlanEntry } from './import-plan.ts'
export { planImport, summarizePlan } from './import-plan.ts'
export { KnowledgeStore } from './store.ts'
export type { AddDocumentInput, AddDocumentResult } from './store.ts'
export { SqliteKnowledgeRepository } from './sqlite.ts'
export { KnowledgeService } from './service.ts'
export { ImportRunner } from './import-runner.ts'
export type { ImportReader, ImportReadResult, RunImportOptions } from './import-runner.ts'
export {
  CORPUS_PARSER,
  DOCUMENT_EXTENSION,
  SPACE_MANIFEST,
  documentIdsOf,
  loadCorpus,
  relativeToCorpus,
  syncCorpus,
} from './corpus.ts'
export type {
  Corpus,
  CorpusDocument,
  CorpusProblem,
  CorpusSpace,
  CorpusSyncReport,
  CorpusSyncTarget,
  SpaceWrite,
} from './corpus.ts'
export type { IngestionDocumentRecord, IngestionJobRecord } from './sqlite.ts'
export {
  name,
  inject,
  apply,
  createSearchTool,
  createImportPlanTool,
  createWikiDraftTool,
  createWikiCheckTool,
  createWikiPublishTool,
  DEFAULT_CONFIG,
  resolveKnowledgeDbPath,
} from './dsh.ts'
export type { KnowledgeConfig } from './dsh.ts'
export {
  FLAT_WIKI_SPACES,
  WIKI_PAGE_TYPE_LABELS,
  WIKI_SCHEMA_MARKDOWN,
  analyzeWikiDraft,
  classifyWikiPage,
  createWikiDraftRecord,
  isFlatWikiSpace,
  renderWikiMarkdown,
  suggestWikiSpace,
  wikiContentHash,
  wikiStatusFor,
} from './wiki.ts'
export type {
  CreateWikiDraftInput,
  KnowledgeMemoryNode,
  WikiCheckDocument,
  WikiConflict,
  WikiDraft,
  WikiDraftStatus,
  WikiOperation,
  WikiPage,
  WikiPageType,
  WikiRelatedDocument,
  WikiSourceKind,
} from './wiki.ts'
export { WikiService, WikiServiceError } from './wiki-service.ts'
export type { WikiSnapshot } from './wiki-service.ts'
