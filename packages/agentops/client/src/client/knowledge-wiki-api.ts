/**
 * Browser client for the LLM Wiki workbench and knowledge-memory projection.
 *
 * Task reports enter the draft box through this module; the knowledge panel and
 * memory nebula read the same persisted records from the same routes.
 *
 * @module @agentops/dsh-client/knowledge-wiki-api
 */

/** Page kinds accepted by the LLM Wiki schema. */
export type WikiPageType = 'source' | 'entity' | 'concept' | 'comparison' | 'overview'
/** Review lifecycle of one wiki draft. */
export type WikiDraftStatus = 'inbox' | 'ready' | 'conflicted' | 'published' | 'archived'

/** One structural, safety or related-page finding. */
export interface WikiConflict {
  readonly code: string
  readonly severity: 'block' | 'warn' | 'info'
  readonly message: string
  readonly relatedDocumentId?: string
}

/** One raw source waiting for review or publication. */
export interface WikiDraft {
  readonly id: string
  readonly title: string
  readonly content: string
  readonly sourceKind: 'task_report' | 'manual' | 'archive'
  readonly sourceRef: string | null
  readonly sourceTaskId: string | null
  readonly sourceReportId: string | null
  readonly pageType: WikiPageType
  readonly status: WikiDraftStatus
  readonly targetSpaceId: string | null
  readonly categoryPath: string
  readonly conflicts: readonly WikiConflict[]
  readonly contentHash: string
  readonly publishedDocumentId: string | null
  readonly createdAt: string
  readonly updatedAt: string
}

/** One published wiki page backed by a searchable document. */
export interface WikiPage {
  readonly id: string
  readonly draftId: string
  readonly documentId: string
  readonly spaceId: string
  readonly categoryPath: string
  readonly title: string
  readonly pageType: WikiPageType
  readonly summary: string
  readonly sourceRefs: readonly string[]
  readonly status: 'published' | 'archived'
  readonly version: number
  readonly createdAt: string
  readonly updatedAt: string
}

/** One append-only wiki maintenance event. */
export interface WikiOperation {
  readonly id: number
  readonly action: 'draft.create' | 'draft.check' | 'wiki.publish' | 'draft.archive' | 'category.create' | 'category.review'
  readonly draftId: string | null
  readonly pageId: string | null
  readonly detail: Readonly<Record<string, unknown>>
  readonly createdAt: string
}

/** One Agent-maintained category directory. */
export interface WikiCategory {
  readonly spaceId: string
  readonly path: string
  readonly reviewStatus: 'auto' | 'reviewed'
  readonly documentCount: number
  readonly draftCount: number
  readonly createdAt: string
  readonly updatedAt: string
}

/** Workbench data returned by the wiki route. */
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

/** A searchable document projected into the memory nebula. */
export interface KnowledgeMemoryNode {
  readonly documentId: string
  readonly spaceId: string
  readonly spaceName: string
  readonly title: string
  readonly summary: string
  readonly tags: readonly string[]
  readonly updatedAt: string
  readonly version: number
  readonly pageType: WikiPageType | 'document'
  readonly categoryPath: string
  readonly sourceTaskId: string | null
  readonly wikiPageId: string | null
  readonly status: string
}

/** Input for adding a task report or other source to the draft box. */
export interface CreateWikiDraftRequest {
  readonly title: string
  readonly content: string
  readonly sourceKind: 'task_report' | 'manual' | 'archive'
  readonly sourceRef?: string
  readonly sourceTaskId?: string
  readonly sourceReportId?: string
  readonly pageType?: WikiPageType
  readonly targetSpaceId?: string
  readonly categoryPath?: string
}

/** Input for creating one runtime knowledge domain. */
export interface CreateKnowledgeSpaceRequest {
  readonly id: string
  readonly name: string
  readonly visibility: 'shared' | 'restricted'
  readonly readers?: readonly string[]
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { credentials: 'include', ...init })
  const text = await response.text()
  let body: unknown
  try {
    const value: unknown = text === '' ? null : JSON.parse(text)
    body = value
  } catch {
    if (!response.ok && response.status === 404) {
      throw new Error('知识库 Wiki 服务尚未加载，请重启 dsh web 后重试')
    }
    throw new Error(response.ok ? '知识库服务返回了非 JSON 响应' : `知识库服务请求失败（HTTP ${response.status}）`)
  }
  if (!response.ok) {
    const message = errorMessage(body) ?? `HTTP ${response.status}`
    throw new Error(message)
  }
  return body as T
}

function errorMessage(body: unknown): string | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null
  const error = (body as Record<string, unknown>).error
  if (typeof error !== 'object' || error === null || Array.isArray(error)) return null
  const message = (error as Record<string, unknown>).message
  return typeof message === 'string' ? message : null
}

/**
 * Read the draft box, published pages, schema, spaces and operation log.
 * @returns the workbench snapshot.
 */
export function fetchWikiSnapshot(): Promise<WikiSnapshot> {
  return request('/api/agentops/knowledge/wiki')
}

/**
 * Create one runtime knowledge space.
 * @param input - stable id, display name and visibility.
 * @returns the created space.
 */
export async function createKnowledgeSpace(input: CreateKnowledgeSpaceRequest): Promise<{ id: string; name: string; visibility: 'shared' | 'restricted' }> {
  const result = await request<{ space: { id: string; name: string; visibility: 'shared' | 'restricted' } }>('/api/agentops/knowledge/spaces', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  })
  return result.space
}

/**
 * Put one task report or source into the wiki draft box and run its first check.
 * @param input - source content and identity.
 * @returns the checked draft.
 */
export async function createWikiDraft(input: CreateWikiDraftRequest): Promise<WikiDraft> {
  const result = await request<{ draft: WikiDraft }>('/api/agentops/knowledge/wiki/draft', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  })
  return result.draft
}

/**
 * Re-run the structural and safety checks for one draft.
 * @param draftId - draft identity.
 * @returns the checked draft.
 */
export async function checkWikiDraft(draftId: string): Promise<WikiDraft> {
  const result = await request<{ draft: WikiDraft }>('/api/agentops/knowledge/wiki/check', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ draftId }),
  })
  return result.draft
}

/**
 * Publish a ready draft as a searchable Wiki page.
 * @param draftId - draft identity.
 * @param targetSpaceId - destination knowledge space.
 * @param categoryPath - category path to file the page under.
 * @returns the published draft and page.
 */
export function publishWikiDraft(
  draftId: string,
  targetSpaceId: string,
  categoryPath?: string,
): Promise<{ draft: WikiDraft; page: WikiPage }> {
  return request('/api/agentops/knowledge/wiki/publish', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ draftId, targetSpaceId, ...(categoryPath === undefined ? {} : { categoryPath }) }),
  })
}

/**
 * Confirm an automatically created category after review.
 * @param spaceId - owning knowledge space.
 * @param categoryPath - category path to confirm.
 * @returns the reviewed category.
 */
export async function reviewWikiCategory(spaceId: string, categoryPath: string): Promise<WikiCategory> {
  const result = await request<{ category: WikiCategory }>('/api/agentops/knowledge/wiki/category/review', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ spaceId, categoryPath }),
  })
  return result.category
}

/**
 * Archive a draft without publishing it.
 * @param draftId - draft identity.
 * @returns the archived draft.
 */
export async function archiveWikiDraft(draftId: string): Promise<WikiDraft> {
  const result = await request<{ draft: WikiDraft }>('/api/agentops/knowledge/wiki/archive', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ draftId }),
  })
  return result.draft
}

/**
 * Read knowledge documents projected for the memory nebula.
 * @returns knowledge nodes from readable spaces.
 */
export async function fetchKnowledgeMemory(): Promise<readonly KnowledgeMemoryNode[]> {
  const result = await request<{ nodes: readonly KnowledgeMemoryNode[] }>('/api/agentops/knowledge/memory')
  return result.nodes
}
