import { describe, expect, it } from 'vitest'

import { buildStarMap, type GraphEdge, type GraphNode } from '../src/client/starmap-layout.js'

const NODES: GraphNode[] = [
  {
    task_id: 't1',
    title: '导出按钮',
    status: 'backlog',
    risk_level: 'medium',
    parent_task_id: null,
    project_id: 'p1',
    project_name: '订单后台',
  },
  {
    task_id: 't2',
    title: '失败重试',
    status: 'in_progress',
    risk_level: 'low',
    parent_task_id: 't1',
    project_id: 'p1',
    project_name: '订单后台',
  },
  {
    task_id: 't3',
    title: '埋点',
    status: 'idea',
    risk_level: 'high',
    parent_task_id: 't1',
    project_id: 'p1',
    project_name: '订单后台',
  },
  {
    task_id: 't4',
    title: '文档',
    status: 'closed',
    risk_level: 'low',
    parent_task_id: null,
    project_id: 'p2',
    project_name: '知识库',
  },
  {
    task_id: 't5',
    title: '未归属事项',
    status: 'blocked',
    risk_level: 'medium',
    parent_task_id: null,
    project_id: null,
    project_name: null,
  },
]

const EDGES: GraphEdge[] = [
  { relation_type: 'parent', source_task_id: 't2', target_task_id: 't1' },
  { relation_type: 'parent', source_task_id: 't3', target_task_id: 't1' },
  { relation_type: 'blocks', source_task_id: 't2', target_task_id: 't3' },
  { relation_type: 'related', source_task_id: 't4', target_task_id: 't1' },
]

describe('star map layout', () => {
  it('is deterministic for the same input', () => {
    expect(buildStarMap(NODES, EDGES)).toEqual(buildStarMap(NODES, EDGES))
  })

  it('uses projects as cluster centres and keeps unowned tasks explicit', () => {
    const map = buildStarMap(NODES, EDGES)
    expect(map.clusters.map(cluster => cluster.name)).toEqual(['订单后台', '知识库', '未归属任务'])
    expect(new Set(map.clusters.map(cluster => `${cluster.x}:${cluster.y}`)).size).toBe(map.clusters.length)

    const order = new Map(map.points.map(point => [point.id, point]))
    expect(order.get('t1')!.projectId).toBe('p1')
    expect(order.get('t4')!.projectName).toBe('知识库')
    expect(order.get('t5')!.projectName).toBe('未归属任务')
  })

  it('places children further from their project centre and sizes hubs by degree', () => {
    const map = buildStarMap(NODES, EDGES)
    const byId = new Map(map.points.map(point => [point.id, point]))
    const cluster = map.clusters.find(item => item.id === 'project:p1')!
    const distance = (point: { x: number; y: number }): number =>
      Math.hypot(point.x - cluster.x, point.y - cluster.y)

    expect(distance(byId.get('t2')!)).toBeGreaterThan(distance(byId.get('t1')!))
    expect(byId.get('t1')!.radius).toBeGreaterThan(byId.get('t5')!.radius)
    expect(byId.get('t1')!.degree).toBe(3)
  })

  it('drops edges that point outside the node set', () => {
    const map = buildStarMap(NODES, [
      ...EDGES,
      { relation_type: 'related', source_task_id: 't1', target_task_id: 'missing' },
    ])
    expect(map.links).toHaveLength(4)
  })

  it('keeps every point inside the viewport', () => {
    const map = buildStarMap(NODES, EDGES)
    for (const point of map.points) {
      expect(point.x).toBeGreaterThanOrEqual(0)
      expect(point.x).toBeLessThanOrEqual(map.width)
      expect(point.y).toBeGreaterThanOrEqual(0)
      expect(point.y).toBeLessThanOrEqual(map.height)
    }
  })

  it('places trees deeper than three levels instead of stacking them at the centre', () => {
    const nodes: GraphNode[] = Array.from({ length: 7 }, (_, index) => ({
      task_id: `deep-${index}`,
      title: `deep ${index}`,
      status: 'in_progress',
      risk_level: 'low',
      parent_task_id: index === 0 ? null : `deep-${index - 1}`,
      project_id: 'deep-project',
      project_name: '深层项目',
    }))
    const edges: GraphEdge[] = nodes.slice(1).map((node, index) => ({
      relation_type: 'parent',
      source_task_id: node.task_id,
      target_task_id: `deep-${index}`,
    }))

    const map = buildStarMap(nodes, edges)
    const depths = new Map(map.points.map(point => [point.id, point.depth]))
    expect(depths.get('deep-0')).toBe(0)
    expect(depths.get('deep-6')).toBe(6)
    expect(new Set(map.points.map(point => `${point.x}:${point.y}`)).size).toBe(nodes.length)
  })

  it('marks very large maps as dense', () => {
    const nodes: GraphNode[] = Array.from({ length: 201 }, (_, index) => ({
      task_id: `dense-${index.toString().padStart(3, '0')}`,
      title: `dense ${index}`,
      status: 'backlog',
      risk_level: 'low',
      parent_task_id: null,
      project_id: 'dense-project',
      project_name: '高密度项目',
    }))
    expect(buildStarMap(nodes, []).dense).toBe(true)
  })
})
