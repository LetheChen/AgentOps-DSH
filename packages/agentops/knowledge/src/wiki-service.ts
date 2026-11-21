/**
 * LLM Wiki workflow over the searchable knowledge service.
 *
 * Drafts are durable raw sources. Publication adds a generated Wiki page as a
 * versioned searchable document, so the same page is available to model tools,
 * the knowledge workbench, and the memory nebula without a second index.
 *
 * @module @agentops/dsh-knowledge/wiki-service
 */

import type { KnowledgeService } from './service.js'
import type { SqliteKnowledgeRepository } from './sqlite.js'
import {
  DEFAULT_WIKI_CATEGORY,
  WIKI_SCHEMA_MARKDOWN,
  analyzeWikiDraft,
  createWikiDraftRecord,
  isFlatWikiSpace,
  normalizeWikiCategoryPath,
  renderWikiMarkdown,
  wikiStatusFor,
  type CreateWikiDraftInput,
  type KnowledgeMemoryNode,
  type WikiCategory,
  type WikiCheckDocument,
  type WikiConflict,
  type WikiDraft,
  type WikiOperation,
  type WikiPage,
  type WikiRelatedDocument,
} from './wiki.js'

/** A stable, typed failure produced by the wiki workflow. */
export class WikiServiceError extends Error {
  /** Machine-readable failure code. */
  readonly code: string
  /** HTTP status the route should return. */
  readonly status: number

  constructor(code: string, message: string, status = 400) {
    super(message)
    this.name = 'WikiServiceError'
    this.code = code
    this.status = status
  }
}

/** The data the Wiki workbench renders in one request. */
export interface WikiSnapshot {
  readonly drafts: readonly WikiDraft[]
  readonly pages: readonly WikiPage[]
  readonly operations: readonly WikiOperation[]
  readonly spaces: readonly { readonly id: string; readonly name: string; readonly visibility: 'shared' | 'restricted' }[]
  readonly categories: readonly WikiCategory[]
  readonly schema: string
  readonly stats: {
    readonly drafts: number
    readonly ready: number
    readonly conflicted: number
    readonly published: number
  }
}

/**
 * Coordinates draft checks, publication, and knowledge projection.
 */
export class WikiService {
  constructor(
    private readonly knowledge: KnowledgeService,
    private readonly repository: SqliteKnowledgeRepository,
  ) {}

  /**
   * Create or return the draft for one source, then run its first check.
   * @param input - raw source content and identity.
   * @param readableSpaces - spaces available to relation checks.
   * @returns the checked draft.
   */
  createDraft(input: CreateWikiDraftInput, readableSpaces: readonly string[] = []): WikiDraft {
    const draft = createWikiDraftRecord(input)
    const existing = this.repository.getWikiDraft(draft.id)
    if (existing !== undefined) return existing
    this.repository.saveWikiDraft(draft)
    this.append('draft.create', draft.id, null, { sourceKind: draft.sourceKind, sourceRef: draft.sourceRef, categoryPath: draft.categoryPath }, draft.createdAt)
    if (draft.targetSpaceId !== null) this.ensureCategory(draft.targetSpaceId, draft.categoryPath, draft.createdAt)
    return this.checkDraft(draft.id, readableSpaces)
  }

  /**
   * Run deterministic checks and update the draft status.
   * @param draftId - draft identity.
   * @param readableSpaces - spaces available to relation checks.
   * @returns the checked draft.
   */
  checkDraft(draftId: string, readableSpaces: readonly string[] = []): WikiDraft {
    const draft = this.requireDraft(draftId)
    if (draft.status === 'published') return draft
    const visible = draft.targetSpaceId === null ? this.knowledge.readableSpaces(readableSpaces) : [draft.targetSpaceId]
    const documents: WikiCheckDocument[] = this.knowledge.listDocuments()
      .filter(document => visible.includes(document.spaceId))
      .map(document => ({
        documentId: document.id,
        title: document.title,
        spaceId: document.spaceId,
        contentHash: document.contentHash,
      }))
    const titles = new Map(this.knowledge.listDocuments().map(document => [document.id, document.title]))
    const related: WikiRelatedDocument[] = this.knowledge.search(draft.title, visible, 6)
      .filter(hit => hit.chunk.documentId !== draft.publishedDocumentId)
      .map(hit => ({
        documentId: hit.chunk.documentId,
        title: titles.get(hit.chunk.documentId) ?? hit.chunk.documentId,
        spaceId: hit.chunk.spaceId,
        section: hit.chunk.locator.section ?? null,
      }))
    const conflicts = analyzeWikiDraft(draft, documents, related)
    const checked: WikiDraft = {
      ...draft,
      status: draft.status === 'archived' ? 'archived' : wikiStatusFor(conflicts),
      conflicts,
      updatedAt: new Date().toISOString(),
    }
    this.repository.saveWikiDraft(checked)
    this.append('draft.check', checked.id, null, { conflicts: checked.conflicts }, checked.updatedAt)
    return checked
  }

  /**
   * Publish a checked draft as a searchable Wiki document.
   * @param draftId - draft identity.
   * @param targetSpaceId - destination space.
   * @param readableSpaces - spaces available to the final check.
   * @param categoryPath - optional category override; the draft category is used otherwise.
   * @returns the published draft and page.
   */
  publishDraft(
    draftId: string,
    targetSpaceId: string,
    readableSpaces: readonly string[] = [],
    categoryPath?: string,
  ): { draft: WikiDraft; page: WikiPage } {
    const existingPage = this.repository.listWikiPages().find(page => page.draftId === draftId && page.status === 'published')
    const existingDraft = this.requireDraft(draftId)
    if (existingPage !== undefined) return { draft: existingDraft, page: existingPage }
    if (!this.knowledge.listSpaces().some(space => space.id === targetSpaceId)) {
      throw new WikiServiceError('space_not_found', `知识空间不存在：${targetSpaceId}`, 404)
    }
    const now = new Date().toISOString()
    this.repository.saveWikiDraft({ ...existingDraft, targetSpaceId, updatedAt: now })
    const draft = this.checkDraft(draftId, readableSpaces)
    if (draft.status !== 'ready') {
      throw new WikiServiceError('draft_conflicted', '草稿仍有阻断项，不能发布 Wiki', 409)
    }
    const requestedCategory = isFlatWikiSpace(targetSpaceId) ? '' : (categoryPath ?? draft.categoryPath)
    const category = normalizeWikiCategoryPath(requestedCategory) ?? DEFAULT_WIKI_CATEGORY
    this.ensureCategory(targetSpaceId, category, now)
    const markdown = renderWikiMarkdown({ ...draft, categoryPath: category })
    const documentId = `wiki_${draft.id}`
    this.knowledge.addDocument({
      id: documentId,
      spaceId: targetSpaceId,
      categoryPath: category,
      title: draft.title,
      mime: 'text/markdown',
      text: markdown,
      contentHash: draft.contentHash,
      parser: 'llm-wiki@1',
      now,
    })
    const page: WikiPage = {
      id: `wp_${draft.id}`,
      draftId: draft.id,
      documentId,
      spaceId: targetSpaceId,
      categoryPath: category,
      title: draft.title,
      pageType: draft.pageType,
      summary: draft.content.slice(0, 240),
      sourceRefs: draft.sourceRef === null ? [] : [draft.sourceRef],
      status: 'published',
      version: 1,
      createdAt: now,
      updatedAt: now,
    }
    this.repository.saveWikiPage(page)
    const published: WikiDraft = {
      ...draft,
      status: 'published',
      targetSpaceId,
      categoryPath: category,
      publishedDocumentId: documentId,
      updatedAt: now,
    }
    this.repository.saveWikiDraft(published)
    this.append('wiki.publish', published.id, page.id, { spaceId: targetSpaceId, categoryPath: category, documentId }, now)
    return { draft: published, page }
  }

  /**
   * Archive a draft without publishing it.
   * @param draftId - draft identity.
   * @returns the archived draft.
   */
  archiveDraft(draftId: string): WikiDraft {
    const draft = this.requireDraft(draftId)
    if (draft.status === 'published') {
      throw new WikiServiceError('draft_published', '已发布草稿不能直接归档', 409)
    }
    const archived: WikiDraft = { ...draft, status: 'archived', updatedAt: new Date().toISOString() }
    this.repository.saveWikiDraft(archived)
    this.append('draft.archive', archived.id, null, {}, archived.updatedAt)
    return archived
  }

  /**
   * Return the workbench snapshot.
   * @returns drafts, pages, operation log, spaces, schema, and counts.
   */
  snapshot(): WikiSnapshot {
    const drafts = this.repository.listWikiDrafts()
    const pages = this.repository.listWikiPages()
    const categories = this.categorySnapshot(drafts, pages)
    return {
      drafts,
      pages,
      operations: this.repository.listWikiOperations(),
      spaces: this.knowledge.listSpaces().map(space => ({ id: space.id, name: space.name, visibility: space.visibility })),
      categories,
      schema: WIKI_SCHEMA_MARKDOWN,
      stats: {
        drafts: drafts.filter(draft => draft.status !== 'archived').length,
        ready: drafts.filter(draft => draft.status === 'ready').length,
        conflicted: drafts.filter(draft => draft.status === 'conflicted').length,
        published: pages.filter(page => page.status === 'published').length,
      },
    }
  }

  /**
   * Project readable documents into memory-nebula nodes.
   * @param readableSpaces - spaces the caller may read.
   * @returns searchable knowledge nodes with Wiki metadata when available.
   */
  memoryNodes(readableSpaces: readonly string[]): KnowledgeMemoryNode[] {
    const visible = this.knowledge.readableSpaces(readableSpaces)
    const spaces = new Map(this.knowledge.listSpaces().map(space => [space.id, space.name]))
    const pages = new Map(this.repository.listWikiPages().map(page => [page.documentId, page]))
    const drafts = new Map(this.repository.listWikiDrafts().map(draft => [draft.id, draft]))
    return this.knowledge.listDocuments()
      .filter(document => visible.includes(document.spaceId))
      .map((document) => {
        const page = pages.get(document.id)
        const draft = page === undefined ? undefined : drafts.get(page.draftId)
        return {
          documentId: document.id,
          spaceId: document.spaceId,
          spaceName: spaces.get(document.spaceId) ?? document.spaceId,
          title: document.title,
          summary: this.knowledge.chunksOf(document.id)[0]?.text.slice(0, 240) ?? document.title,
          tags: document.tags,
          updatedAt: document.updatedAt,
          version: document.currentVersion,
          pageType: page?.pageType ?? 'document',
          categoryPath: page?.categoryPath ?? document.categoryPath,
          sourceTaskId: draft?.sourceTaskId ?? null,
          wikiPageId: page?.id ?? null,
          status: page?.status ?? document.status,
        }
      })
  }

  /**
   * Expand configured grants for category and memory reads.
   * @param configured - deployment-readable space ids.
   * @returns the effective readable space ids.
   */
  readableSpaces(configured: readonly string[]): string[] {
    return this.knowledge.readableSpaces(configured)
  }

  /**
   * Confirm an automatically created category after human review.
   * @param spaceId - owning knowledge space.
   * @param path - category path to confirm.
   * @returns the reviewed category.
   */
  reviewCategory(spaceId: string, path: string): WikiCategory {
    const normalized = normalizeWikiCategoryPath(path)
    if (normalized === null || normalized === '') throw new WikiServiceError('invalid_category', '分类路径无效', 400)
    const current = this.repository.getWikiCategory(spaceId, normalized)
    if (current === undefined) throw new WikiServiceError('category_not_found', `分类不存在：${normalized}`, 404)
    const now = new Date().toISOString()
    const reviewed: WikiCategory = { ...current, reviewStatus: 'reviewed', updatedAt: now }
    this.repository.saveWikiCategory(reviewed)
    this.append('category.review', null, null, { spaceId, categoryPath: normalized }, now)
    return reviewed
  }

  private ensureCategory(spaceId: string, path: string, now: string): void {
    if (!this.knowledge.listSpaces().some(space => space.id === spaceId)) {
      throw new WikiServiceError('space_not_found', `知识空间不存在：${spaceId}`, 404)
    }
    const normalized = normalizeWikiCategoryPath(path) ?? DEFAULT_WIKI_CATEGORY
    if (normalized === '') return
    if (this.repository.getWikiCategory(spaceId, normalized) !== undefined) return
    this.repository.saveWikiCategory({
      spaceId,
      path: normalized,
      reviewStatus: 'auto',
      documentCount: 0,
      draftCount: 0,
      createdAt: now,
      updatedAt: now,
    })
    this.append('category.create', null, null, { spaceId, categoryPath: normalized, source: 'agent' }, now)
  }

  private categorySnapshot(drafts: readonly WikiDraft[], pages: readonly WikiPage[]): WikiCategory[] {
    const categories = new Map(this.repository.listWikiCategories().map(item => [`${item.spaceId}
${item.path}`, item]))
    const ensure = (spaceId: string, path: string): void => {
      const key = `${spaceId}
${path}`
      if (categories.has(key)) return
      const now = new Date().toISOString()
      categories.set(key, {
        spaceId, path, reviewStatus: 'auto', documentCount: 0, draftCount: 0, createdAt: now, updatedAt: now,
      })
    }
    const documents = this.knowledge.listDocuments()
    for (const document of documents) if (document.categoryPath !== '') ensure(document.spaceId, document.categoryPath)
    for (const draft of drafts) if (draft.targetSpaceId !== null && draft.categoryPath !== '') ensure(draft.targetSpaceId, draft.categoryPath)
    for (const page of pages) if (page.categoryPath !== '') ensure(page.spaceId, page.categoryPath)
    return [...categories.values()].map(category => ({
      ...category,
      documentCount: documents.filter(document => document.spaceId === category.spaceId && document.categoryPath === category.path).length,
      draftCount: drafts.filter(draft => draft.targetSpaceId === category.spaceId && draft.categoryPath === category.path).length,
    })).sort((left, right) => left.spaceId.localeCompare(right.spaceId) || left.path.localeCompare(right.path))
  }

  private requireDraft(draftId: string): WikiDraft {
    const draft = this.repository.getWikiDraft(draftId)
    if (draft === undefined) throw new WikiServiceError('draft_not_found', `草稿不存在：${draftId}`, 404)
    return draft
  }

  private append(
    action: WikiOperation['action'],
    draftId: string | null,
    pageId: string | null,
    detail: Readonly<Record<string, unknown>>,
    createdAt: string,
  ): void {
    this.repository.appendWikiOperation({ action, draftId, pageId, detail, createdAt })
  }
}

/**
 * Report whether any draft finding blocks publication.
 * @param conflicts - draft findings.
 * @returns true when at least one finding has block severity.
 */
export function hasBlockingConflict(conflicts: readonly WikiConflict[]): boolean {
  return conflicts.some(conflict => conflict.severity === 'block')
}
