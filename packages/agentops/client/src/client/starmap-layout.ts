/**
 * Deterministic layout for the task star map.
 *
 * A project is the cluster centre. Task depth follows the canonical `parent`
 * relation (falling back to the task cache only when the graph has no relation
 * row), and the same input always produces the same coordinates. Nothing here
 * reads React or the DOM, so the layout is unit tested on its own.
 *
 * @module @agentops/dsh-client/starmap-layout
 */

/** One graph node as the `/graph` route returns it. */
export interface GraphNode {
  task_id: string
  title: string
  status: string
  risk_level: string
  parent_task_id: string | null
  project_id?: string | null
  project_name?: string | null
}

/** One graph edge as the `/graph` route returns it. */
export interface GraphEdge {
  relation_type: string
  source_task_id: string
  target_task_id: string
}

/** A project or explicit unowned-task cluster. */
export interface StarCluster {
  readonly id: string
  readonly projectId: string | null
  readonly name: string
  readonly nodeCount: number
  readonly x: number
  readonly y: number
  readonly radius: number
  readonly rings: readonly number[]
}

/** A placed star. */
export interface StarPoint {
  readonly id: string
  readonly title: string
  readonly status: string
  readonly statusGroup: 'active' | 'attention' | 'done' | 'waiting'
  readonly riskLevel: string
  readonly clusterId: string
  readonly projectId: string | null
  readonly projectName: string
  readonly x: number
  readonly y: number
  readonly radius: number
  readonly depth: number
  readonly degree: number
  readonly labelX: number
  readonly labelY: number
  readonly labelWidth: number
}

/** A drawn link between two stars. */
export interface StarLink {
  readonly from: string
  readonly to: string
  readonly relation: string
  readonly midX: number
  readonly midY: number
}

/** The whole map. */
export interface StarMap {
  readonly points: readonly StarPoint[]
  readonly links: readonly StarLink[]
  readonly clusters: readonly StarCluster[]
  readonly width: number
  readonly height: number
  readonly dense: boolean
}

const MIN_WIDTH = 980
const MIN_HEIGHT = 680
const VIEWPORT_PADDING = 36
const CLUSTER_GAP = 46
const ROW_GAP = 48
const MIN_CLUSTER_RADIUS = 112
const RADIUS_PER_DEGREE = 2.2
const MIN_NODE_RADIUS = 7
const MAX_NODE_RADIUS = 17
const MAX_DEPTH = 24

function isPresent(value: string | null | undefined): value is string {
  return value !== undefined && value !== null && value !== ''
}

function statusGroup(status: string): StarPoint['statusGroup'] {
  if (status === 'closed') return 'done'
  if (status === 'blocked' || status === 'failed' || status === 'paused') return 'attention'
  if (status === 'canceled' || status === 'abandoned' || status === 'idea' || status === 'backlog') return 'waiting'
  return 'active'
}

function visualLength(text: string): number {
  let width = 0
  for (const character of text) width += /[\u0000-\u007f]/.test(character) ? 1 : 2
  return width
}

function ringRadius(depth: number, count: number): number {
  const base = depth === 0 ? 36 : 76 + (depth - 1) * 56
  const density = (Math.max(count, 1) * 34) / (Math.PI * 2)
  return Math.max(base, density, depth === 0 ? 36 : 0)
}

/**
 * Place every task on concentric orbits around its project cluster.
 * @param nodes - task nodes from `/graph`.
 * @param edges - relation edges from `/graph`.
 * @returns placed stars, links, clusters and the viewport size.
 */
export function buildStarMap(nodes: readonly GraphNode[], edges: readonly GraphEdge[]): StarMap {
  const sortedNodes = [...nodes].sort((left, right) => left.task_id.localeCompare(right.task_id))
  const known = new Set(sortedNodes.map(node => node.task_id))
  const degree = new Map<string, number>()
  const parentByNode = new Map<string, string>()

  for (const edge of edges) {
    if (!known.has(edge.source_task_id) || !known.has(edge.target_task_id)) continue
    degree.set(edge.source_task_id, (degree.get(edge.source_task_id) ?? 0) + 1)
    degree.set(edge.target_task_id, (degree.get(edge.target_task_id) ?? 0) + 1)
    if (
      edge.relation_type === 'parent'
      && edge.source_task_id !== edge.target_task_id
      && !parentByNode.has(edge.source_task_id)
    ) {
      parentByNode.set(edge.source_task_id, edge.target_task_id)
    }
  }

  // The relation row wins; the cache only fills a genuine gap.
  for (const node of sortedNodes) {
    if (
      !parentByNode.has(node.task_id)
      && isPresent(node.parent_task_id)
      && known.has(node.parent_task_id)
      && node.parent_task_id !== node.task_id
    ) {
      parentByNode.set(node.task_id, node.parent_task_id)
    }
  }

  // A malformed cycle is not allowed to produce an unstable or endless walk.
  for (const node of sortedNodes) {
    const seen = new Set([node.task_id])
    let cursor = parentByNode.get(node.task_id)
    while (cursor !== undefined) {
      if (seen.has(cursor)) {
        parentByNode.delete(node.task_id)
        break
      }
      seen.add(cursor)
      cursor = parentByNode.get(cursor)
    }
  }

  const rootOf = (taskId: string): string => {
    const seen = new Set<string>()
    let cursor = taskId
    while (true) {
      const parent = parentByNode.get(cursor)
      if (parent === undefined || !known.has(parent) || seen.has(parent)) return cursor
      seen.add(cursor)
      cursor = parent
    }
  }

  interface ClusterInput {
    readonly id: string
    readonly projectId: string | null
    readonly name: string
    readonly nodes: GraphNode[]
  }

  const clusterInputs = new Map<string, ClusterInput>()
  for (const node of sortedNodes) {
    const projectId = isPresent(node.project_id) ? node.project_id : null
    const rootId = rootOf(node.task_id)
    const id = projectId === null ? `unowned:${rootId}` : `project:${projectId}`
    const existing = clusterInputs.get(id)
    if (existing !== undefined) {
      existing.nodes.push(node)
      continue
    }
    const fallbackName = projectId === null ? '未归属任务' : projectId
    clusterInputs.set(id, {
      id,
      projectId,
      name: isPresent(node.project_name) ? node.project_name : fallbackName,
      nodes: [node],
    })
  }

  const orderedClusters = [...clusterInputs.values()].sort((left, right) => left.id.localeCompare(right.id))
  const clusterSizes = orderedClusters.map((cluster) => {
    const localKnown = new Set(cluster.nodes.map(node => node.task_id))
    const depths = new Map<string, number>()
    const depthOf = (taskId: string): number => {
      const cached = depths.get(taskId)
      if (cached !== undefined) return cached
      const parent = parentByNode.get(taskId)
      const depth = parent === undefined || !localKnown.has(parent)
        ? 0
        : Math.min(MAX_DEPTH, depthOf(parent) + 1)
      depths.set(taskId, depth)
      return depth
    }
    const groups = new Map<number, string[]>()
    for (const node of cluster.nodes) {
      const depth = depthOf(node.task_id)
      const bucket = groups.get(depth) ?? []
      bucket.push(node.task_id)
      groups.set(depth, bucket)
    }
    const rings = [...groups.keys()].sort((left, right) => left - right).map((depth) => {
      const ids = (groups.get(depth) ?? []).sort((left, right) => left.localeCompare(right))
      return { depth, count: ids.length, radius: ringRadius(depth, ids.length) }
    })
    let previous = 0
    for (const ring of rings) {
      ring.radius = Math.max(ring.radius, previous === 0 ? ring.radius : previous + 58)
      previous = ring.radius
    }
    const maxNodeRadius = Math.max(
      MIN_NODE_RADIUS,
      Math.min(MAX_NODE_RADIUS, MIN_NODE_RADIUS + Math.max(0, cluster.nodes.length - 1) * RADIUS_PER_DEGREE),
    )
    const radius = Math.max(MIN_CLUSTER_RADIUS, (rings.at(-1)?.radius ?? 36) + maxNodeRadius + 22)
    return { groups, rings, radius }
  })

  // Pack each row from the real cluster radii instead of a uniform max-sized
  // cell. A single deep chain used to widen the whole map and shrink every
  // project label, even when the other clusters were small.
  const columns = orderedClusters.length <= 2
    ? Math.max(1, orderedClusters.length)
    : orderedClusters.length === 3
      ? 3
      : Math.max(2, Math.ceil(Math.sqrt(orderedClusters.length * 1.3)))
  const rows = Math.max(1, Math.ceil(orderedClusters.length / columns))
  const rowIndexes: number[][] = Array.from({ length: rows }, () => [])
  orderedClusters.forEach((_, index) => {
    const row = Math.floor(index / columns)
    rowIndexes[row]?.push(index)
  })
  const radiusOf = (index: number): number => clusterSizes[index]?.radius ?? MIN_CLUSTER_RADIUS
  const rowWidths = rowIndexes.map(indexes =>
    indexes.reduce((total, index) => total + radiusOf(index) * 2, 0)
      + Math.max(0, indexes.length - 1) * CLUSTER_GAP,
  )
  const rowHeights = rowIndexes.map(indexes =>
    Math.max(MIN_CLUSTER_RADIUS, ...indexes.map(index => radiusOf(index))) * 2,
  )
  const contentWidth = Math.max(0, ...rowWidths)
  const contentHeight = rowHeights.reduce((total, height) => total + height, 0)
    + Math.max(0, rows - 1) * ROW_GAP
  const width = Math.max(MIN_WIDTH, contentWidth + VIEWPORT_PADDING * 2)
  const height = Math.max(MIN_HEIGHT, contentHeight + VIEWPORT_PADDING * 2)
  const contentTop = (height - contentHeight) / 2
  const centres: { x: number; y: number }[] = []
  let rowTop = contentTop
  rowIndexes.forEach((indexes, row) => {
    const rowWidth = rowWidths[row] ?? 0
    const rowHeight = rowHeights[row] ?? 0
    let cursorX = (width - rowWidth) / 2
    for (const index of indexes) {
      const radius = radiusOf(index)
      centres[index] = { x: cursorX + radius, y: rowTop + rowHeight / 2 }
      cursorX += radius * 2 + CLUSTER_GAP
    }
    rowTop += rowHeight + ROW_GAP
  })

  const clusters: StarCluster[] = []
  const placed = new Map<string, { x: number; y: number; depth: number }>()
  const pointMeta = new Map<string, { clusterId: string; projectId: string | null; projectName: string }>()

  orderedClusters.forEach((cluster, clusterIndex) => {
    const centre = centres[clusterIndex] ?? { x: width / 2, y: height / 2 }
    const centerX = centre.x
    const centerY = centre.y
    const size = clusterSizes[clusterIndex]
    if (size === undefined) return
    for (const ring of size.rings) {
      const ids = (size.groups.get(ring.depth) ?? []).sort((left, right) => left.localeCompare(right))
      ids.forEach((taskId, index) => {
        const angle = ids.length === 1
          ? -Math.PI / 2 + ring.depth * 0.43
          : -Math.PI / 2 + ring.depth * 0.17 + (Math.PI * 2 * index) / ids.length
        placed.set(taskId, {
          x: centerX + Math.cos(angle) * ring.radius,
          y: centerY + Math.sin(angle) * ring.radius,
          depth: ring.depth,
        })
        pointMeta.set(taskId, {
          clusterId: cluster.id,
          projectId: cluster.projectId,
          projectName: cluster.name,
        })
      })
    }
    clusters.push({
      id: cluster.id,
      projectId: cluster.projectId,
      name: cluster.name,
      nodeCount: cluster.nodes.length,
      x: centerX,
      y: centerY,
      radius: size.radius,
      rings: [...new Set(size.rings.map(ring => Math.round(ring.radius)))],
    })
  })

  const points: StarPoint[] = sortedNodes.map((node) => {
    const spot = placed.get(node.task_id) ?? { x: 0, y: 0, depth: 0 }
    const links = degree.get(node.task_id) ?? 0
    const radius = Math.min(MAX_NODE_RADIUS, MIN_NODE_RADIUS + links * RADIUS_PER_DEGREE)
    const labelWidth = Math.max(104, Math.min(214, 30 + visualLength(node.title) * 7))
    const meta = pointMeta.get(node.task_id) ?? {
      clusterId: `unowned:${node.task_id}`,
      projectId: null,
      projectName: '未归属任务',
    }
    return {
      id: node.task_id,
      title: node.title,
      status: node.status,
      statusGroup: statusGroup(node.status),
      riskLevel: node.risk_level,
      clusterId: meta.clusterId,
      projectId: meta.projectId,
      projectName: meta.projectName,
      x: spot.x,
      y: spot.y,
      radius,
      depth: spot.depth,
      degree: links,
      labelX: spot.x - labelWidth / 2,
      labelY: spot.y + radius + 10,
      labelWidth,
    }
  })

  const byId = new Map(points.map(point => [point.id, point]))
  const links: StarLink[] = []
  for (const edge of edges) {
    const from = byId.get(edge.source_task_id)
    const to = byId.get(edge.target_task_id)
    if (from === undefined || to === undefined) continue
    links.push({
      from: from.id,
      to: to.id,
      relation: edge.relation_type,
      midX: (from.x + to.x) / 2 + (to.y - from.y) * 0.08,
      midY: (from.y + to.y) / 2 - (to.x - from.x) * 0.08,
    })
  }

  return {
    points,
    links,
    clusters,
    width,
    height,
    dense: points.length > 200,
  }
}
