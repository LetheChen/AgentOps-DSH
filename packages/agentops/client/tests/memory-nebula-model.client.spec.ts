import { describe, expect, it } from 'vitest'

import {
  buildMemoryNebula,
  memoryCategory,
  modeVisible,
  nodeColor,
  precheckTask,
  type DecisionMemory,
} from '../src/client/memory-nebula-model.js'
import type { TaskCenterTask } from '../src/client/task-center-model.js'
import type { KnowledgeMemoryNode } from '../src/client/knowledge-wiki-api.js'

const task = (id: string, status = 'in_progress', riskLevel = 'medium'): TaskCenterTask => ({
  taskId: id,
  projectId: 'p1',
  identifier: `AO-${id}`,
  title: `Task ${id}`,
  description: `Description ${id}`,
  status,
  taskType: 'code',
  riskLevel,
  version: 0,
  assigneeName: null,
  createdAt: '2026-11-01T00:00:00Z',
  updatedAt: '2026-11-10T00:00:00Z',
  closedAt: null,
})

const decision = (id: string, authorityLevel = 'policy', noteClass = 'architecture'): DecisionMemory => ({
  decisionId: id,
  projectId: 'p1',
  decisionKey: id,
  title: `Decision ${id}`,
  status: 'implemented',
  subjectType: 'project',
  subjectId: '',
  authorityScope: 'project',
  authorityLevel,
  problem: 'Problem',
  proposal: 'Proposal',
  rationale: 'Rationale',
  alternatives: '',
  acceptanceCriteria: '',
  sourceTaskId: 't1',
  noteClass,
  version: 0,
  createdAt: '2026-11-01T00:00:00Z',
  updatedAt: '2026-11-10T00:00:00Z',
})

const knowledge = (id: string, sourceTaskId: string | null = 't1'): KnowledgeMemoryNode => ({
  documentId: id,
  spaceId: 'finance',
  spaceName: '财务制度',
  title: `Knowledge ${id}`,
  summary: 'Searchable knowledge summary',
  tags: ['知识库'],
  updatedAt: '2026-11-12T00:00:00Z',
  version: 1,
  categoryPath: '技术分析/本地部署',
  pageType: 'source',
  sourceTaskId,
  wikiPageId: `wp_${id}`,
  status: 'published',
})

describe('memory nebula model', () => {
  it('builds deterministic task and memory positions', () => {
    const first = buildMemoryNebula([task('t1')], [], [decision('d1')], [knowledge('k1')])
    const second = buildMemoryNebula([task('t1')], [], [decision('d1')], [knowledge('k1')])
    expect(first.nodes).toEqual(second.nodes)
    expect(first.nodes.map(node => node.kind)).toEqual(['domain', 'subdomain', 'task', 'memory', 'knowledge'])
  })

  it('links memory to its source task', () => {
    const graph = buildMemoryNebula([task('t1')], [], [decision('d1')], [knowledge('k1')])
    expect(graph.links).toContainEqual(expect.objectContaining({
      source: 'memory:d1',
      target: 'task:t1',
      kind: 'originated_from',
    }))
    expect(graph.links).toContainEqual(expect.objectContaining({
      source: 'knowledge:k1',
      target: 'task:t1',
      kind: 'originated_from',
    }))
  })

  it('filters task and memory modes independently', () => {
    const graph = buildMemoryNebula([task('t1')], [], [decision('d1')], [knowledge('k1')])
    expect(graph.nodes.filter(node => modeVisible(node, 'tasks')).map(node => node.kind)).toEqual(['task'])
    expect(graph.nodes.filter(node => modeVisible(node, 'memories')).map(node => node.kind)).toEqual(['domain', 'subdomain', 'memory', 'knowledge'])
  })

  it('bridges documents from different domains through shared tags', () => {
    const graph = buildMemoryNebula([], [], [], [
      knowledge('k1'),
      { ...knowledge('k2'), spaceId: 'learning', spaceName: '学习资料' },
    ])
    const tag = graph.nodes.find(node => node.id === 'tag:知识库')
    expect(tag?.kind).toBe('tag')
    expect(tag?.status).toBe('cross_domain')
    expect(graph.links.filter(link => link.kind === 'tagged')).toHaveLength(2)
  })

  it('maps decision authority and note class to memory categories', () => {
    expect(memoryCategory(decision('d1', 'hard_constraint', 'architecture'))).toBe('constraint')
    expect(memoryCategory(decision('d2', 'policy', 'process'))).toBe('convention')
    expect(memoryCategory(decision('d3', 'policy', 'testing'))).toBe('lesson')
    expect(nodeColor({ kind: 'memory', category: 'constraint' })).toBe('#60A5FA')
  })

  it('blocks precheck when a blocking dependency is unfinished', () => {
    const graph = buildMemoryNebula([task('t1'), task('t2')], [{
      relation_type: 'blocks', source_task_id: 't1', target_task_id: 't2',
    }], [])
    const checks = precheckTask(graph.nodes.find(node => node.id === 'task:t2')!, graph)
    expect(checks).toContainEqual(expect.objectContaining({ level: 'block' }))
  })
})
