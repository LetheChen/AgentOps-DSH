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

export type MemoryKind = 'task' | 'memory' | 'knowledge'
export type MemoryMode = 'overview' | 'tasks' | 'memories'

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

export interface NebulaNode {
  id: string
  kind: MemoryKind
  title: string
  summary: string
  status: string
  category: string
  risk: string
  timestamp: number
  importance: number
  lastViewedAt: number
  cluster: string
  sourceRef?: string
  taskId?: string
  x: number
  y: number
  z: number
}

export interface NebulaLink {
  id: string
  source: string
  target: string
  kind: string
}

export interface MemoryNebula {
  nodes: readonly NebulaNode[]
  links: readonly NebulaLink[]
}

export interface MemoryGraphEdge {
  relation_type: string
  source_task_id: string
  target_task_id: string
}

export const MEMORY_CATEGORIES = ['decision', 'constraint', 'convention', 'lesson', 'proposal'] as const

export const MEMORY_CATEGORY_LABELS: Record<string, string> = {
  decision: '决策',
  constraint: '约束',
  convention: '约定',
  lesson: '经验',
  proposal: '提议',
}

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
}

export function nodeColor(node: Pick<NebulaNode, 'kind' | 'category'>): string {
  if (node.kind === 'memory') return CATEGORY_COLORS[node.category] ?? '#5EEAD4'
  return CATEGORY_COLORS[node.kind] ?? '#94A3B8'
}

export function memoryCategory(decision: DecisionMemory): string {
  if (decision.authorityLevel === 'hard_constraint') return 'constraint'
  if (decision.noteClass === 'process') return 'convention'
  if (decision.noteClass === 'testing' || decision.noteClass === 'bug-fix') return 'lesson'
  if (decision.status === 'proposed') return 'proposal'
  return 'decision'
}

export function memoryImportance(decision: DecisionMemory): number {
  if (decision.authorityLevel === 'hard_constraint') return 1
  if (decision.authorityLevel === 'policy') return 0.82
  if (decision.authorityLevel === 'implementation') return 0.68
  return 0.52
}

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
        status: document.status,
        category: document.pageType,
        risk: 'low',
        timestamp: safeTimestamp,
        importance,
        lastViewedAt: safeTimestamp,
        cluster: document.spaceName,
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

  const knowledgeBySpace = new Map<string, string[]>()
  for (const document of knowledge) {
    const source = `knowledge:${document.documentId}`
    if (document.sourceTaskId !== null) {
      const task = taskIds.get(document.sourceTaskId)
      if (task !== undefined) links.push({ id: `knowledge-task:${document.documentId}`, source, target: task, kind: 'originated_from' })
    }
    const group = knowledgeBySpace.get(document.spaceId) ?? []
    group.push(source)
    knowledgeBySpace.set(document.spaceId, group)
  }
  for (const [spaceId, nodes] of knowledgeBySpace) {
    for (let index = 1; index < nodes.length; index += 1) {
      const source = nodes[index - 1]
      const target = nodes[index]
      if (source === undefined || target === undefined) continue
      links.push({ id: `knowledge-space:${spaceId}:${index}`, source, target, kind: 'same_space' })
    }
  }

  return { nodes: [...taskNodes, ...memoryNodes, ...knowledgeNodes], links }
}

export function modeVisible(node: NebulaNode, mode: MemoryMode): boolean {
  if (mode === 'tasks') return node.kind === 'task'
  if (mode === 'memories') return node.kind === 'memory' || node.kind === 'knowledge'
  return true
}

export function decayFactor(node: Pick<NebulaNode, 'timestamp' | 'importance'>): number {
  const days = Math.max(0, (Date.now() - node.timestamp) / 86_400_000)
  const recency = Math.max(0.18, 1 - days / 365)
  return Math.min(1, recency * 0.72 + node.importance * 0.28)
}

export function alphaFor(node: NebulaNode): number {
  return Math.max(0.16, 0.34 + decayFactor(node) * 0.66)
}

export function nodeMatches(node: NebulaNode, query: string): boolean {
  const q = query.trim().toLocaleLowerCase()
  if (q === '') return true
  return `${node.title} ${node.summary} ${node.category} ${node.status} ${node.cluster}`.toLocaleLowerCase().includes(q)
}

export function relationSummary(links: readonly NebulaLink[], focusId: string): NebulaLink[] {
  return links.filter(link => link.source === focusId || link.target === focusId).map(link => ({ ...link }))
}

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
