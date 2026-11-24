/**
 * LLM Wiki vocabulary and deterministic maintenance rules.
 *
 * Raw material enters as an immutable draft source. Checks classify page type,
 * detect duplicate or sensitive content, and surface related pages before a
 * draft can become a searchable wiki page.
 *
 * @module @agentops/dsh-knowledge/wiki
 */

import { createHash } from 'node:crypto'

/** The page kinds the wiki schema permits. */
export type WikiPageType = 'source' | 'entity' | 'concept' | 'comparison' | 'overview'

/** Lifecycle of a draft in the review inbox. */
export type WikiDraftStatus = 'inbox' | 'ready' | 'conflicted' | 'published' | 'archived'

/** How a draft entered the wiki pipeline. */
export type WikiSourceKind = 'task_report' | 'manual' | 'archive'

/** Whether a category was created automatically or confirmed by a reviewer. */
export type WikiCategoryReviewStatus = 'auto' | 'reviewed'

/** One Agent-maintained directory inside a knowledge space. */
export interface WikiCategory {
  readonly spaceId: string
  readonly path: string
  readonly reviewStatus: WikiCategoryReviewStatus
  readonly documentCount: number
  readonly draftCount: number
  readonly createdAt: string
  readonly updatedAt: string
}

/** One finding produced by the draft checks. */
export interface WikiConflict {
  readonly code: string
  readonly severity: 'block' | 'warn' | 'info'
  readonly message: string
  readonly relatedDocumentId?: string
}

/** One draft source waiting for review or publication. */
export interface WikiDraft {
  readonly id: string
  readonly title: string
  readonly content: string
  readonly sourceKind: WikiSourceKind
  readonly sourceRef: string | null
  readonly sourceTaskId: string | null
  readonly sourceReportId: string | null
  readonly pageType: WikiPageType
  readonly status: WikiDraftStatus
  readonly targetSpaceId: string | null
  /** Category inside the space; empty means the space root. */
  readonly categoryPath: string
  readonly conflicts: readonly WikiConflict[]
  readonly contentHash: string
  readonly publishedDocumentId: string | null
  readonly createdAt: string
  readonly updatedAt: string
}

/** One published wiki page backed by a searchable document version. */
export interface WikiPage {
  readonly id: string
  readonly draftId: string
  readonly documentId: string
  readonly spaceId: string
  /** Category inside the space; empty means the space root. */
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

/** One searchable knowledge document projected into the memory nebula. */
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

/** Input accepted when a task report or manual source enters the draft box. */
export interface CreateWikiDraftInput {
  readonly title: string
  readonly content: string
  readonly sourceKind: WikiSourceKind
  readonly sourceRef?: string | null
  readonly sourceTaskId?: string | null
  readonly sourceReportId?: string | null
  readonly pageType?: WikiPageType
  readonly targetSpaceId?: string | null
  readonly categoryPath?: string | null
  readonly now?: string
}

/** Existing material used by a conflict check. */
export interface WikiCheckDocument {
  readonly documentId: string
  readonly title: string
  readonly spaceId: string
  readonly contentHash: string
}

/** A related passage found by retrieval during a conflict check. */
export interface WikiRelatedDocument {
  readonly documentId: string
  readonly title: string
  readonly spaceId: string
  readonly section: string | null
}

/** Labels used by both the workbench and model tool output. */
export const WIKI_PAGE_TYPE_LABELS: Readonly<Record<WikiPageType, string>> = {
  source: '来源摘要',
  entity: '实体',
  concept: '概念',
  comparison: '对比',
  overview: '综述',
}

/** Fallback category for low-confidence or unreviewed material in categorized spaces. */
export const DEFAULT_WIKI_CATEGORY = '待复核/自动归档'

/** Built-in domains whose documents live directly at the space root. */
export const FLAT_WIKI_SPACES = ['finance', 'hr', 'ops', 'project_analysis', 'review'] as const

/**
 * Whether a built-in space stores documents without second-level categories.
 * @param spaceId - target knowledge space.
 * @returns true for a flat built-in space.
 */
export function isFlatWikiSpace(spaceId: string | null | undefined): boolean {
  return spaceId !== null && spaceId !== undefined && FLAT_WIKI_SPACES.includes(spaceId as typeof FLAT_WIKI_SPACES[number])
}

/** Preferred first-level branches for categorized professional knowledge domains. */
export const WIKI_CATEGORY_BRANCHES: Readonly<Record<string, readonly string[]>> = {
  office_docs: ['周报', '会议记录', '系统规划', '任务总结', '待复核'],
  learning: ['课程', '书籍文章', '学习笔记', '待复核'],
  technical_docs: ['架构设计', '接口说明', '部署实施', '故障排查', '技术规范', '待复核'],
  smart_query: ['智能问数', '智能审批'],
  content_creation: ['视频模板', '动效卡片', '周报模板', '内容规范'],
}

/** The schema layer consumed by the workbench and model-facing tools. */
export const WIKI_SCHEMA_MARKDOWN = `# AgentOps LLM Wiki Schema

## Layers

- Raw sources are immutable inputs and keep their source identity.
- Wiki pages are generated and maintained by agents or reviewers.
- The schema owns page types, promotion rules, categories, indexes, and the append-only log.

## Page types

- source: one page for each ingested report, article, or extracted material.
- entity: a concrete person, system, product, or organization discussed in depth.
- concept: created after at least two sources reference the subject.
- comparison: created when sources disagree or a query produces reusable analysis.
- overview: maintained synthesis across multiple pages.

## Routing and category maintenance

- A top-level knowledge space is deployment-owned; agents must never create one per document.
- Route by ownership first, then long-term use, conclusion type, and document type.
- Finance, HR, operations, project analysis, and review spaces are flat: their documents stay at the space root.
- Office collaboration, learning, technical documentation, data Q&A, and content creation use stable document-type categories.
- Categorized spaces reuse an existing category before creating another and keep paths at two segments or fewer.
- Low-confidence or conflicting classifications go to the 待复核 space; do not force a document into a domain.
- Category names must not contain dates, version numbers, task ids, personal names, or unreviewed product claims.
- Automatic category creation is recorded in the operation log and remains pending until a reviewer confirms it.

## Required behavior

- Every task report enters through the draft box and is checked before publication.
- Never publish sensitive values, duplicate content, or unresolved blocking conflicts.
- Wiki links use [[type/page-title]] syntax and point back to raw source references.
- Update the append-only operation log for every create, check, publish, archive, and category action.
`

const SENSITIVE_PATTERNS: readonly { name: string; pattern: RegExp }[] = [
  { name: 'private-ipv4', pattern: /\b(?:10\.\d{1,3}|192\.168|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\b/ },
  { name: 'credential-assignment', pattern: /\b(?:api[_-]?key|secret|password|passwd|token)\s*[:=]\s*['"]?[A-Z0-9_\-]{8,}/i },
  { name: 'bearer-token', pattern: /\bBearer\s+[A-Za-z0-9._\-]{16,}/ },
]

/**
 * Hash the exact normalized draft content.
 * @param content - draft body.
 * @returns SHA-256 digest.
 */
export function wikiContentHash(content: string): string {
  return createHash('sha256').update(content.trim()).digest('hex')
}

/**
 * Choose a page type from an explicit value or deterministic content cues.
 * @param input - title, content, source kind, and optional explicit type.
 * @returns the page type used by the schema.
 */
export function classifyWikiPage(input: Pick<CreateWikiDraftInput, 'title' | 'content' | 'sourceKind' | 'pageType'>): WikiPageType {
  if (input.pageType !== undefined) return input.pageType
  if (/对比|比较|versus|\bvs\.?\b/i.test(input.title)) return 'comparison'
  if (/综述|概览|overview/i.test(input.title)) return 'overview'
  if (/概念|原则|机制|模式|方法/i.test(input.title)) return 'concept'
  if (input.sourceKind === 'task_report' || input.sourceKind === 'archive') return 'source'
  return 'entity'
}

/**
 * Normalize a category path to at most two safe directory segments.
 * @param value - explicit path supplied by a reviewer or agent.
 * @returns a safe one- or two-segment path, or an empty string for the space root; null when invalid.
 */
export function normalizeWikiCategoryPath(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null
  if (value.trim() === '') return ''
  const parts = value.replaceAll('\\', '/').split('/')
    .map(part => part.replace(/[\u0000-\u001f<>:"|?*]/g, '').replace(/\s+/g, ' ').trim())
    .filter(part => part !== '' && part !== '.' && part !== '..')
    .slice(0, 2)
  if (parts.length === 0) return null
  return parts.map(part => Array.from(part).slice(0, 24).join('')).join('/')
}

/**
 * Choose the primary macro knowledge domain when a draft has no explicit target.
 * @param input - title, content, source kind and source reference.
 * @returns one built-in knowledge-space id; uncertain material goes to review.
 */
export function suggestWikiSpace(input: Pick<CreateWikiDraftInput, 'title' | 'content' | 'sourceKind' | 'sourceRef'>): string {
  const text = `${input.title}
${input.sourceRef ?? ''}
${input.content.slice(0, 2000)}`
  if (/财务|报销|发票|采购|付款|差旅/i.test(text)) return 'finance'
  if (/人事|员工|请假|休假|加班|调休|培训政策/i.test(text)) return 'hr'
  if (/运维|值班|告警|生产发布|备份|恢复|服务器|故障恢复/i.test(text)) return 'ops'
  if (/指标|口径|数据目录|SQL|describe_database|数据源|查询报错/i.test(text)) return 'smart_query'
  if (/视频模板|动效卡片|周报模板|内容规范|分镜模板/i.test(text)) return 'content_creation'
  if (/课程|读书|学习笔记|学习资料|学习材料|论文|书籍|知识卡片/i.test(text)) return 'learning'
  if (/周报|会议记录|会议纪要|系统规划|路线图|实施计划|建设方案|任务总结|复盘|办公文档/i.test(text)) return 'office_docs'
  if (/项目研究|技术选型|竞品|方案评估|项目评估|分析报告/i.test(text)) return 'project_analysis'
  if (/架构设计|接口文档|API|部署|故障排查|技术规范|模块设计|工程约定|技术文档|技术资料/i.test(text)) return 'technical_docs'
  return 'review'
}

/**
 * Classify a source into the Agent-maintained category tree.
 * @param input - title, content, source kind, and optional explicit category.
 * @returns a one- or two-segment category path, or an empty string for a flat space.
 */
export function suggestWikiCategory(input: Pick<CreateWikiDraftInput, 'title' | 'content' | 'sourceKind' | 'categoryPath' | 'targetSpaceId'>): string {
  if (isFlatWikiSpace(input.targetSpaceId)) return ''
  const explicit = normalizeWikiCategoryPath(input.categoryPath)
  const preferred = input.targetSpaceId === null || input.targetSpaceId === undefined
    ? undefined
    : WIKI_CATEGORY_BRANCHES[input.targetSpaceId]
  if (explicit !== null && (preferred === undefined || explicit === '' || preferred.includes(explicit.split('/')[0] ?? ''))) return explicit
  const text = `${input.title}\n${input.content.slice(0, 1200)}`
  if (input.targetSpaceId === 'office_docs') {
    if (/周报|weekly/i.test(text)) return '周报/经营周报'
    if (/会议|纪要|meeting/i.test(text)) return '会议记录/讨论纪要'
    if (/规划|路线图|roadmap|方案|计划/i.test(text)) return '系统规划/建设方案'
    if (/任务|交付|复盘|总结/i.test(text)) return '任务总结/交付复盘'
    return DEFAULT_WIKI_CATEGORY
  }
  if (input.targetSpaceId === 'learning') {
    if (/课程|培训|视频课|教程/i.test(text)) return '课程/学习笔记'
    if (/书|文章|论文|专栏/i.test(text)) return '书籍文章/摘要'
    return '学习笔记/知识整理'
  }
  if (input.targetSpaceId === 'technical_docs') {
    if (/架构|模块|设计|adr|决策/i.test(text)) return '架构设计/系统设计'
    if (/接口|API|协议|schema/i.test(text)) return '接口说明/API 文档'
    if (/部署|安装|发布|配置|运行/i.test(text)) return '部署实施/运行手册'
    if (/故障|排查|告警|恢复|问题/i.test(text)) return '故障排查/问题记录'
    return '技术规范/工程约定'
  }
  if (input.targetSpaceId === 'smart_query') {
    if (/审批|OA|表单|流程|待办|驳回|转人工|审批单|审批状态/i.test(text)) return '智能审批'
    return '智能问数'
  }
  if (input.targetSpaceId === 'content_creation') {
    if (/视频|分镜|旁白|HyperFrames|MP4/i.test(text)) return '视频模板/视频生产'
    if (/动效|卡片|A2UI|动画|交互/i.test(text)) return '动效卡片/交互呈现'
    if (/周报|weekly/i.test(text)) return '周报模板/经营周报'
    return '内容规范/写作与排版'
  }
  return DEFAULT_WIKI_CATEGORY
}

/**
 * Create a deterministic draft that can be retried without duplicates.
 * @param input - source content and identity.
 * @returns the new draft in inbox state.
 */
export function createWikiDraftRecord(input: CreateWikiDraftInput): WikiDraft {
  const now = input.now ?? new Date().toISOString()
  const contentHash = wikiContentHash(input.content)
  const sourceRef = input.sourceRef?.trim() || null
  const targetSpaceId = input.targetSpaceId?.trim() || suggestWikiSpace(input)
  return {
    id: `wd_${createHash('sha256').update(sourceRef ?? contentHash).digest('hex').slice(0, 20)}`,
    title: input.title.trim(),
    content: input.content.trim(),
    sourceKind: input.sourceKind,
    sourceRef,
    sourceTaskId: input.sourceTaskId?.trim() || null,
    sourceReportId: input.sourceReportId?.trim() || null,
    pageType: classifyWikiPage(input),
    status: 'inbox',
    targetSpaceId,
    categoryPath: suggestWikiCategory({ ...input, targetSpaceId }),
    conflicts: [],
    contentHash,
    publishedDocumentId: null,
    createdAt: now,
    updatedAt: now,
  }
}

/**
 * Apply deterministic structural and safety checks.
 * @param draft - draft to inspect.
 * @param documents - existing documents visible to the check.
 * @param related - related passages found by retrieval.
 * @returns all findings; blocking findings prevent publication.
 */
export function analyzeWikiDraft(
  draft: WikiDraft,
  documents: readonly WikiCheckDocument[],
  related: readonly WikiRelatedDocument[] = [],
): WikiConflict[] {
  const conflicts: WikiConflict[] = []
  const title = draft.title.trim()
  const content = draft.content.trim()
  if (title.length < 2) conflicts.push({ code: 'title-required', severity: 'block', message: '标题至少需要两个字符' })
  if (content.length < 80) conflicts.push({ code: 'content-too-short', severity: 'warn', message: '内容较短，可能不足以形成可复用页面' })
  if (draft.sourceRef === null && draft.sourceTaskId === null) {
    conflicts.push({ code: 'source-missing', severity: 'warn', message: '未记录原始来源，后续难以追溯' })
  }
  const duplicate = documents.find(document => document.contentHash === draft.contentHash)
  if (duplicate !== undefined) {
    conflicts.push({
      code: 'duplicate-content', severity: 'block', message: `与已有文档「${duplicate.title}」内容相同`, relatedDocumentId: duplicate.documentId,
    })
  }
  const sameTitle = documents.find(document => document.title.trim().toLocaleLowerCase() === title.toLocaleLowerCase())
  if (sameTitle !== undefined && sameTitle.documentId !== draft.publishedDocumentId) {
    conflicts.push({
      code: 'duplicate-title', severity: 'warn', message: `已存在同名页面「${sameTitle.title}」`, relatedDocumentId: sameTitle.documentId,
    })
  }
  const sensitive = SENSITIVE_PATTERNS.filter(item => item.pattern.test(content)).map(item => item.name)
  if (sensitive.length > 0) {
    conflicts.push({ code: 'sensitive-content', severity: 'block', message: `内容包含敏感信息：${sensitive.join(', ')}` })
  }
  if (draft.pageType === 'concept' && sourceRefCount(draft) < 2) {
    conflicts.push({ code: 'concept-source-count', severity: 'warn', message: '概念页应至少由两个来源共同支撑' })
  }
  const seen = new Set<string>()
  for (const item of related) {
    if (item.documentId === draft.publishedDocumentId || seen.has(item.documentId)) continue
    seen.add(item.documentId)
    conflicts.push({
      code: 'related-page', severity: 'info', message: `相关页面「${item.title}」${item.section === null ? '' : ` · ${item.section}`}`, relatedDocumentId: item.documentId,
    })
  }
  return conflicts
}

/**
 * Derive the next review state from findings.
 * @param conflicts - findings from {@link analyzeWikiDraft}.
 * @returns ready when no blocking finding exists, otherwise conflicted.
 */
export function wikiStatusFor(conflicts: readonly WikiConflict[]): 'ready' | 'conflicted' {
  return conflicts.some(conflict => conflict.severity === 'block') ? 'conflicted' : 'ready'
}

/**
 * Render the stored Markdown page with LLM Wiki frontmatter.
 * @param draft - checked draft.
 * @returns publication Markdown.
 */
export function renderWikiMarkdown(draft: WikiDraft): string {
  const refs = sourceRefs(draft)
  const body = draft.content.startsWith('#') ? draft.content : `# ${draft.title}\n\n${draft.content}`
  return [
    '---',
    `id: wiki-${draft.id}`,
    `title: ${yamlString(draft.title)}`,
    `type: ${draft.pageType}`,
    `category: ${yamlString(draft.categoryPath)}`,
    'status: published',
    `source_kind: ${draft.sourceKind}`,
    ...(draft.sourceRef === null ? [] : [`source_ref: ${yamlString(draft.sourceRef)}`]),
    `source_refs: [${refs.map(yamlString).join(', ')}]`,
    `created: ${draft.createdAt}`,
    `updated: ${draft.updatedAt}`,
    '---',
    '',
    body,
    '',
  ].join('\n')
}

function sourceRefs(draft: WikiDraft): string[] {
  const refs = new Set<string>()
  if (draft.sourceRef !== null) refs.add(draft.sourceRef)
  for (const match of draft.content.matchAll(/\[\[([^\]]+)\]\]/g)) {
    const value = match[1]?.trim()
    if (value !== undefined && value !== '') refs.add(value)
  }
  return [...refs]
}

function sourceRefCount(draft: WikiDraft): number {
  return sourceRefs(draft).length
}

function yamlString(value: string): string {
  return JSON.stringify(value)
}
