/**
 * Deterministic scheduling layout for one persisted collaboration run.
 *
 * Levels come only from `after` dependency edges. Data-flow edges are rendered
 * separately and must never delay a node.
 *
 * @module @agentops/dsh-client/collaboration-layout
 */

/** Minimal node identity accepted by the scheduling layout. */
export interface ScheduleLayoutNode {
  readonly id: string
}

/** One scheduling dependency (`after`) between two nodes. */
export interface ScheduleLayoutEdge {
  readonly from: string
  readonly to: string
}

/**
 * Compute longest-path execution levels from scheduling edges.
 *
 * Unknown endpoints, duplicate edges, and self edges are ignored. A dependency
 * cycle is made finite and deterministic by ignoring the edge that closes the
 * cycle during a declaration-order depth-first traversal. Input order is the
 * stable tie-break for independent nodes.
 * @param nodes - workflow nodes in declaration order.
 * @param edges - scheduling dependencies only.
 * @returns each known node id mapped to its zero-based execution level.
 */
export function scheduleLevels(
  nodes: readonly ScheduleLayoutNode[],
  edges: readonly ScheduleLayoutEdge[],
): ReadonlyMap<string, number> {
  const nodeIndex = new Map(nodes.map((node, index) => [node.id, index]))
  const outgoing = new Map<string, ScheduleLayoutEdge[]>(nodes.map(node => [node.id, []]))
  const seen = new Set<string>()

  for (const edge of edges) {
    if (!nodeIndex.has(edge.from) || !nodeIndex.has(edge.to) || edge.from === edge.to) continue
    const key = `${edge.from}\u0000${edge.to}`
    if (seen.has(key)) continue
    seen.add(key)
    outgoing.get(edge.from)?.push(edge)
  }

  const nodeOrder = (id: string): number => nodeIndex.get(id) ?? Number.MAX_SAFE_INTEGER
  for (const targets of outgoing.values()) {
    targets.sort((left, right) => nodeOrder(left.to) - nodeOrder(right.to))
  }

  const visited = new Set<string>()
  const active = new Set<string>()
  const ignored = new Set<string>()
  const postorder: string[] = []

  const visit = (id: string): void => {
    if (visited.has(id)) return
    active.add(id)
    for (const edge of outgoing.get(id) ?? []) {
      if (active.has(edge.to)) {
        ignored.add(`${edge.from}\u0000${edge.to}`)
        continue
      }
      visit(edge.to)
    }
    active.delete(id)
    visited.add(id)
    postorder.push(id)
  }

  for (const node of nodes) visit(node.id)

  const levels = new Map(nodes.map(node => [node.id, 0]))
  for (const id of [...postorder].reverse()) {
    const level = levels.get(id) ?? 0
    for (const edge of outgoing.get(id) ?? []) {
      if (ignored.has(`${edge.from}\u0000${edge.to}`)) continue
      const next = level + 1
      if (next > (levels.get(edge.to) ?? 0)) levels.set(edge.to, next)
    }
  }
  return levels
}
