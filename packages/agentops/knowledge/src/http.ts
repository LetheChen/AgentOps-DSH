/**
 * Read-only JSON surface for the knowledge page.
 *
 * The original page reads domains with page counts; this route maps the new
 * space/document model onto that shape so the ported components stay
 * unchanged. Only owner Peers reach an exact route.
 *
 * @module @agentops/dsh-knowledge/http
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'

import type { KnowledgeService } from './service.ts'
import { WikiService, WikiServiceError } from './wiki-service.ts'
import type { CreateWikiDraftInput, WikiPageType } from './wiki.ts'

/** One domain card, matching the legacy `DomainSummary` fields the card reads. */
export interface DomainSummary {
  id: string
  name: string
  display_name: string
  description: string
  page_count: number
  last_ingest_at: string | null
  supports_lint: boolean
  lint_summary: { critical: number; warning: number; info: number; total: number }
}

/**
 * Map spaces and documents onto legacy domain summaries.
 * @param service - knowledge service.
 * @returns one summary per space, shaped like the legacy domain list.
 */
export function domainSummaries(service: KnowledgeService): DomainSummary[] {
  const documents = service.listDocuments()
  return service.listSpaces().map((space) => {
    const owned = documents.filter(document => document.spaceId === space.id)
    const latest = owned.reduce<string | null>((current, document) => {
      const stamp = document.updatedAt || null
      if (stamp === null) return current
      return current === null || stamp > current ? stamp : current
    }, null)
    return {
      id: space.id,
      name: space.name,
      display_name: space.name,
      description: '',
      page_count: owned.length,
      last_ingest_at: latest,
      supports_lint: false,
      lint_summary: { critical: 0, warning: 0, info: 0, total: 0 },
    }
  })
}

/**
 * Register `GET /api/agentops/knowledge`.
 * @param ctx - context carrying the Connection service.
 * @param service - knowledge service.
 * @param readableSpaces - spaces this deployment may read; an empty list returns no hits.
 */
export function registerKnowledgeRoute(
  ctx: Context,
  service: KnowledgeService,
  readableSpaces: readonly string[] = [],
): void {
  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/agentops/knowledge',
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: () => Promise.resolve(new Response(JSON.stringify({ domains: domainSummaries(service) }), {
      headers: { 'content-type': 'application/json; charset=utf-8' },
    })),
  }), 'agentops-knowledge: /api/agentops/knowledge')

  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/agentops/knowledge/spaces',
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      try {
        const body = await requestObject(request)
        const id = stringField(body, 'id')
        if (!/^[a-z0-9][a-z0-9_-]*$/.test(id)) {
          throw new WikiServiceError('invalid_space_id', '知识域 ID 只能包含小写字母、数字、下划线或短横线')
        }
        const visibility = body.visibility === 'restricted' ? 'restricted' : 'shared'
        const readers = visibility === 'restricted' ? stringArray(body, 'readers') : []
        const space = { id, name: stringField(body, 'name'), visibility, readers } as const
        service.addSpace(space)
        return json({ space }, 201)
      } catch (error) {
        if (error instanceof WikiServiceError) return json({ error: { code: error.code, message: error.message } }, error.status)
        if (error instanceof Error) return json({ error: { code: 'space_create_failed', message: error.message } }, 409)
        throw error
      }
    },
  }), 'agentops-knowledge: /api/agentops/knowledge/spaces')

  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/agentops/knowledge/search',
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: (request) => {
      const url = new URL(request.url)
      const query = (url.searchParams.get('q') ?? '').trim()
      if (query.length === 0) {
        return Promise.resolve(json({ total: 0, matches: [] }))
      }
      const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? '50') || 50, 1), 100)
      // Visibility is closed by configuration: no granted space, no hit.
      const hits = service.search(query, service.readableSpaces(readableSpaces), limit)
      return Promise.resolve(json({
        total: hits.length,
        matches: hits.map(hit => ({
          path: `${hit.chunk.spaceId}/${hit.chunk.documentId}`,
          line: hit.chunk.locator.section ?? undefined,
          context: hit.chunk.text.slice(0, 240),
          score: Number(hit.score.toFixed(3)),
        })),
      }))
    },
  }), 'agentops-knowledge: /api/agentops/knowledge/search')
}

/**
 * Register the Vault routes: the document tree and one document's text.
 * @param ctx - context carrying Connection.
 * @param service - knowledge service.
 * @param readableSpaces - granted spaces; others are invisible.
 */
export function registerVaultRoutes(
  ctx: Context,
  service: KnowledgeService,
  readableSpaces: readonly string[] = [],
): void {
  const readable = service.readableSpaces(readableSpaces)
  const visible = (spaceId: string): boolean => readable.includes(spaceId)

  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/agentops/knowledge/documents',
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: () => {
      const documents = service.listDocuments().filter(doc => visible(doc.spaceId))
      const spaces = service.listSpaces().filter(space => visible(space.id))
      return Promise.resolve(json({
        spaces: spaces.map(space => ({
          id: space.id,
          name: space.name,
          documents: documents
            .filter(doc => doc.spaceId === space.id)
            .map(doc => ({
              id: doc.id,
              title: doc.title,
              version: doc.currentVersion,
              updatedAt: doc.updatedAt,
            })),
        })),
      }))
    },
  }), 'agentops-knowledge: /api/agentops/knowledge/documents')

  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/agentops/knowledge/document',
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: (request) => {
      const id = new URL(request.url).searchParams.get('id') ?? ''
      const meta = service.listDocuments().find(doc => doc.id === id)
      if (meta === undefined || !visible(meta.spaceId)) {
        return Promise.resolve(new Response('not found', { status: 404 }))
      }
      const chunks = service.chunksOf(id)
      return Promise.resolve(json({
        id: meta.id,
        spaceId: meta.spaceId,
        title: meta.title,
        version: meta.currentVersion,
        updatedAt: meta.updatedAt,
        chunks: chunks.map(chunk => ({
          ordinal: chunk.ordinal,
          section: chunk.locator.section ?? null,
          text: chunk.text,
        })),
      }))
    },
  }), 'agentops-knowledge: /api/agentops/knowledge/document')
}

/** One retrieved passage with the marker that references it. */
export interface AskCitation {
  marker: number
  text: string
  score: number
  citation: {
    chunkId: string
    documentId: string
    spaceId: string
    version: number
    title: string
    section: string | null
  }
}

/**
 * Retrieval-only "answer": top chunks with stable citation markers.
 *
 * No model is called. The page says so; shipping a generated answer here would
 * imply a capability this port does not have yet.
 * @param service - knowledge service.
 * @param query - question text.
 * @param readableSpaces - granted spaces.
 * @param limit - maximum citations.
 * @returns the retrieved passages and their markers; no answer is composed.
 */
export function askKnowledge(
  service: KnowledgeService,
  query: string,
  readableSpaces: readonly string[] = [],
  limit = 4,
): { composed: false; citations: AskCitation[] } {
  const hits = service.search(query, service.readableSpaces(readableSpaces), limit)
  const titles = new Map(service.listDocuments().map(doc => [doc.id, doc.title]))
  return {
    composed: false,
    citations: hits.map((hit, index) => ({
      marker: index + 1,
      text: hit.chunk.text,
      score: Number(hit.score.toFixed(3)),
      citation: {
        chunkId: hit.chunk.id,
        documentId: hit.chunk.documentId,
        spaceId: hit.chunk.spaceId,
        version: hit.chunk.version,
        title: titles.get(hit.chunk.documentId) ?? hit.chunk.documentId,
        section: hit.chunk.locator.section ?? null,
      },
    })),
  }
}

/** One lint issue, shaped like the legacy `LintIssue` the page renders. */
export interface LintIssue {
  id: string
  domain: string
  type: 'contradictions' | 'orphans' | 'missing_pages' | 'stale' | 'index_sync' | 'dead_links'
  severity: 'critical' | 'warning' | 'info'
  title: string
  description: string
  page: string
  auto_fixable: boolean
}

/**
 * Local, deterministic checks. Semantic checks the old platform ran through a
 * model (`contradictions`, `missing_pages`, `dead_links`) are not guessed here:
 * the list simply omits them rather than inventing findings.
 * @param service - knowledge service.
 * @param readableSpaces - granted spaces.
 * @returns the issues the local checks found, in the order they were detected.
 */
export function lintIssues(service: KnowledgeService, readableSpaces: readonly string[] = []): LintIssue[] {
  const readable = service.readableSpaces(readableSpaces)
  const documents = service.listDocuments().filter(doc => readable.includes(doc.spaceId))
  const issues: LintIssue[] = []
  const byHash = new Map<string, typeof documents>()

  for (const doc of documents) {
    const bucket = byHash.get(doc.contentHash) ?? []
    bucket.push(doc)
    byHash.set(doc.contentHash, bucket)

    const chunks = service.chunksOf(doc.id)
    if (chunks.length === 0) {
      issues.push({
        id: `orphan:${doc.id}`,
        domain: doc.spaceId,
        type: 'orphans',
        severity: 'critical',
        title: '文档没有可检索切片',
        description: `${doc.title} 当前版本没有任何切片，检索与引用都无法命中。`,
        page: doc.id,
        auto_fixable: false,
      })
    }
  }

  for (const [, group] of byHash) {
    if (group.length < 2) continue
    for (const doc of group.slice(1)) {
      const first = group[0]
      if (first === undefined) continue
      issues.push({
        id: `duplicate:${doc.id}`,
        domain: doc.spaceId,
        type: 'index_sync',
        severity: 'warning',
        title: '内容哈希重复',
        description: `${doc.title} 与 ${first.title} 内容相同（hash ${doc.contentHash.slice(0, 12)}…），建议合并或删除其一。`,
        page: doc.id,
        auto_fixable: false,
      })
    }
  }

  return issues
}

/**
 * Register `GET /api/agentops/knowledge/lint`.
 * @param ctx - context carrying Connection.
 * @param service - knowledge service.
 * @param readableSpaces - granted spaces.
 */
export function registerLintRoute(
  ctx: Context,
  service: KnowledgeService,
  readableSpaces: readonly string[] = [],
): void {
  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/agentops/knowledge/ask',
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: (request) => {
      const query = (new URL(request.url).searchParams.get('q') ?? '').trim()
      if (query.length === 0) return Promise.resolve(json({ composed: false, citations: [] }))
      return Promise.resolve(json(askKnowledge(service, query, readableSpaces)))
    },
  }), 'agentops-knowledge: /api/agentops/knowledge/ask')

  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/agentops/knowledge/lint',
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: () => Promise.resolve(json({ issues: lintIssues(service, readableSpaces) })),
  }), 'agentops-knowledge: /api/agentops/knowledge/lint')
}

/**
 * Register the LLM Wiki workbench and memory projection routes.
 * @param ctx - context carrying Connection.
 * @param wiki - wiki workflow service.
 * @param readableSpaces - spaces available to relation checks and memory.
 */
export function registerWikiRoutes(
  ctx: Context,
  wiki: WikiService,
  readableSpaces: readonly string[] = [],
): void {
  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/agentops/knowledge/wiki',
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: () => Promise.resolve(json(wiki.snapshot())),
  }), 'agentops-knowledge: /api/agentops/knowledge/wiki')

  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/agentops/knowledge/wiki/draft',
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: request => wikiJson(async () => {
      const body = await requestObject(request)
      const sourceKind = stringField(body, 'sourceKind')
      if (sourceKind !== 'task_report' && sourceKind !== 'manual' && sourceKind !== 'archive') {
        throw new WikiServiceError('invalid_source_kind', 'sourceKind must be task_report, manual or archive')
      }
      const targetSpaceId = optionalString(body, 'targetSpaceId')
      if (targetSpaceId !== null && !wiki.snapshot().spaces.some(space => space.id === targetSpaceId)) {
        throw new WikiServiceError('space_not_found', `知识空间不存在：${targetSpaceId}`, 404)
      }
      const pageType = optionalPageType(body)
      const input: CreateWikiDraftInput = {
        title: stringField(body, 'title'),
        content: stringField(body, 'content'),
        sourceKind,
        sourceRef: optionalString(body, 'sourceRef'),
        sourceTaskId: optionalString(body, 'sourceTaskId'),
        sourceReportId: optionalString(body, 'sourceReportId'),
        targetSpaceId,
        categoryPath: optionalString(body, 'categoryPath'),
        ...(pageType === undefined ? {} : { pageType }),
      }
      return { draft: wiki.createDraft(input, readableSpaces) }
    }),
  }), 'agentops-knowledge: /api/agentops/knowledge/wiki/draft')

  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/agentops/knowledge/wiki/check',
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: request => wikiJson(async () => {
      const body = await requestObject(request)
      return { draft: wiki.checkDraft(stringField(body, 'draftId'), readableSpaces) }
    }),
  }), 'agentops-knowledge: /api/agentops/knowledge/wiki/check')

  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/agentops/knowledge/wiki/publish',
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: request => wikiJson(async () => {
      const body = await requestObject(request)
      return wiki.publishDraft(
        stringField(body, 'draftId'),
        stringField(body, 'targetSpaceId'),
        readableSpaces,
        optionalString(body, 'categoryPath') ?? undefined,
      )
    }),
  }), 'agentops-knowledge: /api/agentops/knowledge/wiki/publish')

  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/agentops/knowledge/wiki/archive',
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: request => wikiJson(async () => {
      const body = await requestObject(request)
      return { draft: wiki.archiveDraft(stringField(body, 'draftId')) }
    }),
  }), 'agentops-knowledge: /api/agentops/knowledge/wiki/archive')

  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/agentops/knowledge/wiki/category/review',
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: request => wikiJson(async () => {
      const body = await requestObject(request)
      return { category: wiki.reviewCategory(stringField(body, 'spaceId'), stringField(body, 'categoryPath')) }
    }),
  }), 'agentops-knowledge: /api/agentops/knowledge/wiki/category/review')

  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/agentops/knowledge/memory',
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: () => Promise.resolve(json({ nodes: wiki.memoryNodes(readableSpaces) })),
  }), 'agentops-knowledge: /api/agentops/knowledge/memory')
}

async function wikiJson(run: () => Promise<unknown>): Promise<Response> {
  try {
    return json(await run())
  } catch (error) {
    if (error instanceof WikiServiceError) {
      return json({ error: { code: error.code, message: error.message } }, error.status)
    }
    throw error
  }
}

async function requestObject(request: Request): Promise<Readonly<Record<string, unknown>>> {
  const value: unknown = await request.json()
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new WikiServiceError('invalid_body', 'request body must be a JSON object')
  }
  return value as Record<string, unknown>
}

function stringField(body: Readonly<Record<string, unknown>>, key: string): string {
  const value = body[key]
  if (typeof value !== 'string' || value.trim() === '') {
    throw new WikiServiceError('invalid_body', `${key} must be a non-empty string`)
  }
  return value.trim()
}

function optionalString(body: Readonly<Record<string, unknown>>, key: string): string | null {
  const value = body[key]
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') throw new WikiServiceError('invalid_body', `${key} must be a string`)
  return value.trim() || null
}

function stringArray(body: Readonly<Record<string, unknown>>, key: string): string[] {
  const value = body[key]
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw new WikiServiceError('invalid_body', `${key} must be an array of strings`)
  return value.filter((item): item is string => typeof item === 'string').map(item => item.trim()).filter(item => item !== '')
}

function optionalPageType(body: Readonly<Record<string, unknown>>): WikiPageType | undefined {
  const value = body.pageType
  if (value === undefined || value === null) return undefined
  if (value === 'source' || value === 'entity' || value === 'concept' || value === 'comparison' || value === 'overview') return value
  throw new WikiServiceError('invalid_body', 'pageType is invalid')
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}
