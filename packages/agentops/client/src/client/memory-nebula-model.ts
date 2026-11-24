/**
 * Pure model for the remembered AgentOps star map.
 *
 * The nebula combines admitted tasks, durable Decision memories and searchable
 * knowledge pages. Layout is deterministic so visual position never changes
 * between refreshes for the same data.
 *
 * @module @agentops/dsh-client/memory-nebula-model
 */

import type { TaskCenterTask } from './task-center-model.ts'
import type { KnowledgeMemoryNode } from './knowledge-wiki-api.ts'

/** Kinds of records the nebula can show as nodes. */
export type MemoryKind = 'task' | 'memory' | 'knowledge' | 'domain' | 'subdomain' | 'tag'
/** Display modes that select which node kinds are visible. */
export type MemoryMode = 'overview' | 'tasks' | 'memories'

/** Chinese labels for each memory kind. */
export const MEMORY_KIND_LABELS: Readonly<Record<MemoryKind, string>> = {
  task: '任务',
  memory: '决策记忆',
  knowledge: '知识文档',
  domain: '知识域',
  subdomain: '细分领域',
  tag: '知识标签',
}

/** One durable decision memory record. */
export interface DecisionMemory {
  decisionId: string
  projectId: string
  decisionKey: string
  title: string
  status: string
  subjectType: string
  subjectId: string
  authorityScope: string
  authorityLevel: string
  problem: string
  proposal: string
  rationale: string
  alternatives: string
  acceptanceCriteria: string
  sourceTaskId: string | null
  noteClass: string
  version: number
  createdAt: string
  updatedAt: string
}

/** One record placed in the nebula, with its world position. */
export interface NebulaNode {
  id: string
  kind: MemoryKind
  title: string
  summary: string
  tags: readonly string[]
  status: string
  category: string
  risk: string
  timestamp: number
  importance: number
  lastViewedAt: number
  cluster: string
  domainId?: string
  subdomain?: string
  sourceRef?: string
  taskId?: string
  x: number
  y: number
  z: number
}

/** One directed relation between two nebula nodes. */
export interface NebulaLink {
  id: string
  source: string
  target: string
  kind: string
}

/** The nodes and links that make up one nebula. */
export interface MemoryNebula {
  nodes: readonly NebulaNode[]
  links: readonly NebulaLink[]
}

/** One canonical relation edge between two tasks. */
export interface MemoryGraphEdge {
  relation_type: string
  source_task_id: string
  target_task_id: string
}

/** Categories a decision memory can be sorted into. */
export const MEMORY_CATEGORIES = ['decision', 'constraint', 'convention', 'lesson', 'proposal'] as const

/** Chinese labels for each decision category. */
export const MEMORY_CATEGORY_LABELS: Record<string, string> = {
  decision: '决策',
  constraint: '约束',
  convention: '约定',
  lesson: '经验',
  proposal: '提议',
}

/** Chinese labels for each decision status. */
export const MEMORY_STATUS_LABELS: Record<string, string> = {
  proposed: '候选',
  implemented: '已上线',
  rejected: '已否决',
  archived: '已归档',
  active: '当前有效',
  superseded: '被取代',
  obsolete: '已过时',
}

const CATEGORY_COLORS: Record<string, string> = {
  decision: '#5EEAD4',
  constraint: '#60A5FA',
  convention: '#A78BFA',
  lesson: '#F59E0B',
  proposal: '#F472B6',
  task: '#F59E0B',
  knowledge: '#60A5FA',
  domain: '#22D3EE',
  subdomain: '#A78BFA',
  tag: '#FBBF24',
}

/**
 * Resolve the display color of one node.
 * @param node - the node whose kind and category select the color.
 * @returns the hex color for the node.
 */
export function nodeColor(node: Pick<NebulaNode, 'kind' | 'category'>): string {
  if (node.kind === 'memory') return CATEGORY_COLORS[node.category] ?? '#5EEAD4'
  return CATEGORY_COLORS[node.kind] ?? '#94A3B8'
}

/**
 * Node radius in world units, shared by force collision and rendering.
 * @param node - the node whose kind and importance set the radius.
 * @returns the node radius in world units.
 */
export function nodeRadius(node: Pick<NebulaNode, 'kind' | 'importance'>): number {
  if (node.kind === 'domain') return 32
  if (node.kind === 'subdomain') return 20
  if (node.kind === 'tag') return 10 + node.importance * 5
  if (node.kind === 'task') return 13 + node.importance * 7
  return 8 + node.importance * 8
}

/**
 * Classify one decision memory into its display category.
 * @param decision - the decision memory to classify.
 * @returns the category key.
 */
export function memoryCategory(decision: DecisionMemory): string {
  if (decision.authorityLevel === 'hard_constraint') return 'constraint'
  if (decision.noteClass === 'process') return 'convention'
  if (decision.noteClass === 'testing' || decision.noteClass === 'bug-fix') return 'lesson'
  if (decision.status === 'proposed') return 'proposal'
  return 'decision'
}

/**
 * Score how strongly one decision memory weighs in the nebula.
 * @param decision - the decision memory to score.
 * @returns the importance weight between 0 and 1.
 */
export function memoryImportance(decision: DecisionMemory): number {
  if (decision.authorityLevel === 'hard_constraint') return 1
  if (decision.authorityLevel === 'policy') return 0.82
  if (decision.authorityLevel === 'implementation') return 0.68
  return 0.52
}

/**
 * Read the most recent timestamp of one decision memory.
 * @param decision - the decision memory whose update and creation times are read.
 * @returns the epoch milliseconds of the newer timestamp, or the current time when neither parses.
 */
export function memoryTimestamp(decision: Pick<DecisionMemory, 'updatedAt' | 'createdAt'>): number {
  const value = Date.parse(decision.updatedAt || decision.createdAt)
  return Number.isFinite(value) ? value : Date.now()
}

function hash(text: string): number {
  let value = 2166136261
  for (let index = 0; index < text.length; index++) {
    value ^= text.charCodeAt(index)
    value = Math.imul(value, 16777619)
  }
  return Math.abs(value)
}

function position(id: string, kind: MemoryKind, category: string, timestamp: number): { x: number; y: number; z: number } {
  const seed = hash(`${kind}:${category}:${id}`)
  const angle = ((seed % 360) / 180) * Math.PI
  const ageDays = Math.max(0, (Date.now() - timestamp) / 86_400_000)
  const ageBand = Math.min(3, Math.floor(ageDays / 30))
  const base = kind === 'task' ? 120 : 230
  const radius = base + ageBand * 92 + (seed % 70)
  const height = ((Math.floor(seed / 7) % 160) - 80) * 0.8
  return {
    x: Math.cos(angle) * radius,
    y: Math.sin(angle) * radius * 0.52 + height,
    z: Math.sin(angle) * radius * 0.38,
  }
}

/**
 * Build the combined task/decision nebula.
 * @param tasks - admitted tasks in the selected project.
 * @param edges - canonical task relation edges.
 * @param decisions - decision memories in the selected project.
 * @param knowledge - readable knowledge and Wiki pages.
 * @returns deterministic nebula nodes and links.
 */
export function buildMemoryNebula(
  tasks: readonly TaskCenterTask[],
  edges: readonly MemoryGraphEdge[],
  decisions: readonly DecisionMemory[],
  knowledge: readonly KnowledgeMemoryNode[] = [],
): MemoryNebula {
  const taskNodes: NebulaNode[] = [...tasks]
    .sort((left, right) => left.taskId.localeCompare(right.taskId))
    .map((task) => {
      const timestamp = Date.parse(task.updatedAt || task.createdAt)
      return {
        id: `task:${task.taskId}`,
        kind: 'task',
        title: task.title,
        summary: task.description,
        tags: [],
        status: task.status,
        category: 'task',
        risk: task.riskLevel,
        timestamp: Number.isFinite(timestamp) ? timestamp : Date.now(),
        importance: task.riskLevel === 'high' ? 1 : task.riskLevel === 'medium' ? 0.72 : 0.45,
        lastViewedAt: Number.isFinite(Date.parse(task.updatedAt)) ? Date.parse(task.updatedAt) : Date.now(),
        cluster: '任务执行',
        sourceRef: task.taskId,
        taskId: task.taskId,
        ...position(task.taskId, 'task', task.status, Number.isFinite(timestamp) ? timestamp : Date.now()),
      }
    })

  const memoryNodes: NebulaNode[] = [...decisions]
    .sort((left, right) => left.decisionId.localeCompare(right.decisionId))
    .map((decision) => {
      const timestamp = memoryTimestamp(decision)
      const category = memoryCategory(decision)
      return {
        id: `memory:${decision.decisionId}`,
        kind: 'memory',
        title: decision.title,
        summary: decision.proposal || decision.problem || decision.rationale,
        tags: [],
        status: decision.status,
        category,
        risk: decision.authorityLevel === 'hard_constraint' ? 'high' : 'medium',
        timestamp,
        importance: memoryImportance(decision),
        lastViewedAt: timestamp,
        cluster: MEMORY_CATEGORY_LABELS[category] ?? category,
        sourceRef: decision.decisionId,
        ...position(decision.decisionId, 'memory', category, timestamp),
      }
    })

  const domainGroups = new Map<string, KnowledgeMemoryNode[]>()
  for (const document of knowledge) {
    const group = domainGroups.get(document.spaceId) ?? []
    group.push(document)
    domainGroups.set(document.spaceId, group)
  }

  const domainNodes: NebulaNode[] = [...domainGroups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([spaceId, documents]) => {
      const timestamp = Math.max(...documents.map(document => Date.parse(document.updatedAt) || 0))
      const spaceName = documents[0]?.spaceName ?? spaceId
      return {
        id: `domain:${spaceId}`,
        kind: 'domain',
        title: spaceName,
        summary: `${documents.length} 个知识节点`,
        tags: [],
        status: 'active',
        category: 'domain',
        risk: 'low',
        timestamp,
        importance: 1,
        lastViewedAt: timestamp,
        cluster: spaceName,
        domainId: spaceId,
        sourceRef: spaceId,
        x: 0,
        y: 0,
        z: 0,
      }
    })

  const subdomainGroups = new Map<string, KnowledgeMemoryNode[]>()
  for (const document of knowledge) {
    if (document.categoryPath === '') continue
    const key = `${document.spaceId}\u001f${document.categoryPath}`
    const group = subdomainGroups.get(key) ?? []
    group.push(document)
    subdomainGroups.set(key, group)
  }

  const subdomainNodes: NebulaNode[] = [...subdomainGroups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, documents]) => {
      const [spaceId = '', categoryPath = ''] = key.split('\u001f')
      const timestamp = Math.max(...documents.map(document => Date.parse(document.updatedAt) || 0))
      return {
        id: `subdomain:${spaceId}:${categoryPath}`,
        kind: 'subdomain',
        title: categoryPath,
        summary: documents[0]?.spaceName ?? spaceId,
        tags: [],
        status: 'active',
        category: 'subdomain',
        risk: 'low',
        timestamp,
        importance: 0.88,
        lastViewedAt: timestamp,
        cluster: documents[0]?.spaceName ?? spaceId,
        domainId: spaceId,
        subdomain: categoryPath,
        sourceRef: `${spaceId}/${categoryPath}`,
        x: 0,
        y: 0,
        z: 0,
      }
    })

  const tagGroups = new Map<string, { label: string; documents: KnowledgeMemoryNode[] }>()
  for (const document of knowledge) {
    for (const rawTag of document.tags) {
      const label = rawTag.trim()
      if (label === '') continue
      const key = label.toLocaleLowerCase()
      const group = tagGroups.get(key) ?? { label, documents: [] }
      group.documents.push(document)
      tagGroups.set(key, group)
    }
  }
  const tagNodes: NebulaNode[] = [...tagGroups.entries()]
    .filter(([, group]) => group.documents.length >= 2)
    .sort(([left], [right]) => left.localeCompare(right))
    .slice(0, 120)
    .map(([key, group]) => {
      const spaces = new Set(group.documents.map(document => document.spaceId))
      const timestamp = Math.max(...group.documents.map(document => Date.parse(document.updatedAt) || 0))
      const crossDomain = spaces.size > 1
      return {
        id: `tag:${key}`,
        kind: 'tag',
        title: group.label,
        summary: `${group.documents.length} 个文档 · ${spaces.size} 个知识域${crossDomain ? ' · 跨域关联' : ''}`,
        tags: [group.label],
        status: crossDomain ? 'cross_domain' : 'active',
        category: 'tag',
        risk: 'low',
        timestamp,
        importance: crossDomain ? 0.95 : 0.58,
        lastViewedAt: timestamp,
        cluster: crossDomain ? '跨域标签' : group.documents[0]?.spaceName ?? '标签',
        sourceRef: group.label,
        x: 0,
        y: 0,
        z: 0,
      }
    })

  const knowledgeNodes: NebulaNode[] = [...knowledge]
    .sort((left, right) => left.documentId.localeCompare(right.documentId))
    .map((document) => {
      const timestamp = Date.parse(document.updatedAt)
      const safeTimestamp = Number.isFinite(timestamp) ? timestamp : Date.now()
      const importance = document.pageType === 'overview'
        ? 1
        : document.pageType === 'concept' || document.pageType === 'comparison'
          ? 0.82
          : document.pageType === 'source' || document.pageType === 'entity'
            ? 0.68
            : 0.5
      return {
        id: `knowledge:${document.documentId}`,
        kind: 'knowledge',
        title: document.title,
        summary: document.summary,
        tags: document.tags,
        status: document.status,
        category: document.pageType,
        risk: 'low',
        timestamp: safeTimestamp,
        importance,
        lastViewedAt: safeTimestamp,
        cluster: document.spaceName,
        domainId: document.spaceId,
        subdomain: document.categoryPath,
        sourceRef: document.documentId,
        ...position(document.documentId, 'knowledge', document.pageType, safeTimestamp),
      }
    })

  const taskIds = new Map(tasks.map(task => [task.taskId, `task:${task.taskId}`]))
  const links: NebulaLink[] = []
  for (const edge of edges) {
    const source = taskIds.get(edge.source_task_id)
    const target = taskIds.get(edge.target_task_id)
    if (source === undefined || target === undefined) continue
    links.push({
      id: `task-link:${edge.relation_type}:${edge.source_task_id}:${edge.target_task_id}`,
      source,
      target,
      kind: edge.relation_type,
    })
  }
  for (const decision of decisions) {
    if (decision.sourceTaskId === null) continue
    const target = taskIds.get(decision.sourceTaskId)
    if (target === undefined) continue
    links.push({
      id: `memory-link:${decision.decisionId}:${decision.sourceTaskId}`,
      source: `memory:${decision.decisionId}`,
      target,
      kind: 'originated_from',
    })
  }

  const domainIdBySpace = new Map(knowledge.map(document => [document.spaceId, `domain:${document.spaceId}`]))
  const subdomainId = (document: KnowledgeMemoryNode): string => `subdomain:${document.spaceId}:${document.categoryPath}`
  const linkedSubdomains = new Set<string>()
  for (const document of knowledge) {
    const source = `knowledge:${document.documentId}`
    const domainId = domainIdBySpace.get(document.spaceId)
    if (domainId !== undefined) {
      const parentId = document.categoryPath === '' ? domainId : subdomainId(document)
      if (parentId !== domainId && !linkedSubdomains.has(parentId)) {
        linkedSubdomains.add(parentId)
        links.push({ id: `contain:${domainId}:${parentId}`, source: domainId, target: parentId, kind: 'contains' })
      }
      links.push({ id: `contain:${parentId}:${source}`, source: parentId, target: source, kind: 'contains' })
    }
    if (document.sourceTaskId !== null) {
      const task = taskIds.get(document.sourceTaskId)
      if (task !== undefined) links.push({ id: `knowledge-task:${document.documentId}`, source, target: task, kind: 'originated_from' })
    }
    for (const rawTag of document.tags) {
      const tagId = `tag:${rawTag.trim().toLocaleLowerCase()}`
      if (tagNodes.some(node => node.id === tagId)) {
        links.push({ id: `tagged:${document.documentId}:${tagId}`, source, target: tagId, kind: 'tagged' })
      }
    }
  }

  return { nodes: [...domainNodes, ...subdomainNodes, ...tagNodes, ...taskNodes, ...memoryNodes, ...knowledgeNodes], links }
}

/**
 * Test whether one node is shown in the given display mode.
 * @param node - the node to test.
 * @param mode - the active display mode.
 * @returns true when the node belongs to the mode.
 */
export function modeVisible(node: NebulaNode, mode: MemoryMode): boolean {
  if (mode === 'tasks') return node.kind === 'task'
  if (mode === 'memories') return node.kind === 'memory' || node.kind === 'knowledge' || node.kind === 'domain' || node.kind === 'subdomain' || node.kind === 'tag'
  return true
}

/**
 * Compute how strongly one node decays with age.
 * @param node - the node whose age and importance set the factor.
 * @returns the decay factor between 0 and 1.
 */
export function decayFactor(node: Pick<NebulaNode, 'timestamp' | 'importance'>): number {
  const days = Math.max(0, (Date.now() - node.timestamp) / 86_400_000)
  const recency = Math.max(0.18, 1 - days / 365)
  return Math.min(1, recency * 0.72 + node.importance * 0.28)
}

/**
 * Compute the opacity of one node.
 * @param node - the node whose decay and importance set the opacity.
 * @returns the node opacity between 0 and 1.
 */
export function alphaFor(node: NebulaNode): number {
  return Math.max(0.16, 0.34 + decayFactor(node) * 0.66)
}

/**
 * Test whether one node matches a search query.
 * @param node - the node whose text fields are searched.
 * @param query - the case-insensitive search text.
 * @returns true when the node matches or the query is empty.
 */
export function nodeMatches(node: NebulaNode, query: string): boolean {
  const q = query.trim().toLocaleLowerCase()
  if (q === '') return true
  return `${node.title} ${node.summary} ${node.category} ${node.status} ${node.cluster} ${node.tags.join(' ')}`.toLocaleLowerCase().includes(q)
}

/**
 * Collect the links that touch one focused node.
 * @param links - every link in the nebula.
 * @param focusId - the identifier of the focused node.
 * @returns copies of the links incident to the focused node.
 */
export function relationSummary(links: readonly NebulaLink[], focusId: string): NebulaLink[] {
  return links.filter(link => link.source === focusId || link.target === focusId).map(link => ({ ...link }))
}

/**
 * Collect the pre-execution checks that apply to one node.
 * @param node - the node to check.
 * @param graph - the nebula holding the node's links and neighbours.
 * @returns the check findings, ordered by severity.
 */
export function precheckTask(node: NebulaNode, graph: MemoryNebula): Array<{ level: 'block' | 'warn' | 'info'; text: string }> {
  const checks: Array<{ level: 'block' | 'warn' | 'info'; text: string }> = []
  if (node.kind !== 'task') return [{ level: 'info', text: '记忆节点无需执行预检。' }]
  const byId = new Map(graph.nodes.map(item => [item.id, item]))
  for (const link of graph.links) {
    if (link.kind !== 'blocks' || link.target !== node.id) continue
    const source = byId.get(link.source)
    if (source !== undefined && source.status !== 'closed') {
      checks.push({ level: 'block', text: `阻塞前置未完成：${source.title}（${source.status}）` })
    }
  }
  if (node.status === 'closed') checks.push({ level: 'warn', text: '任务已关闭，继续执行需要 retry / continuation。' })
  if (node.risk === 'high') checks.push({ level: 'warn', text: '高风险任务需要人工确认后执行。' })
  if (checks.length === 0) checks.push({ level: 'info', text: '未发现确定性冲突。' })
  return checks
}
