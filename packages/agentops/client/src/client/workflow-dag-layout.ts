/**
 * Deterministic layered layout for the workflow canvas.
 *
 * Pure geometry: same input, same coordinates. Keeping it out of the component
 * lets geometry tests run without a DOM and keeps component tests focused on
 * rendering and interaction.
 *
 * @module @agentops/dsh-client/workflow-dag-layout
 */

import type { WorkflowNodeType } from './workflow-editor-api.js'

/** One node as the workflows API reports it. */
export interface DagInputNode {
  readonly id: string
  /** Execution level; `-1` means the workflow did not validate. */
  readonly level: number
  /** Workflow node kind shown on the card. */
  readonly type?: WorkflowNodeType
  /** Human-readable node name. */
  readonly displayName?: string
  /** Business role shown on the card and in the inspector. */
  readonly businessRole?: string
  /** Agent definition used by the node. */
  readonly agentRef?: string
  /** Input names consumed by the node. */
  readonly inputs?: readonly string[]
  /** Declared output ports and their targets. */
  readonly outputs?: Readonly<Record<string, readonly string[]>>
}

/** One dependency edge, already normalized to `from → to`. */
export interface DagInputEdge {
  readonly from: string
  readonly to: string
  /** Scheduler dependency or non-ordering data flow. Defaults to `schedule`. */
  readonly domain?: 'schedule' | 'data'
  /** Output port for a data edge. */
  readonly port?: string
}

/** Tunables for the layout; the defaults fit the panel width. */
export interface DagLayoutOptions {
  readonly nodeWidth?: number
  readonly nodeHeight?: number
  readonly columnGap?: number
  readonly rowGap?: number
  readonly padding?: number
}

/** A node placed on the canvas. */
export interface DagPlacedNode extends DagInputNode {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/** An edge routed between two placed nodes. */
export interface DagPlacedEdge {
  readonly from: string
  readonly to: string
  readonly domain: 'schedule' | 'data'
  readonly port?: string
  readonly path: string
  /** Label anchor for a data edge's output port. */
  readonly label?: { readonly x: number; readonly y: number }
}

/** The whole canvas: size, placed nodes, routed edges. */
export interface DagLayout {
  readonly width: number
  readonly height: number
  readonly nodes: readonly DagPlacedNode[]
  readonly edges: readonly DagPlacedEdge[]
}

const DEFAULTS = {
  nodeWidth: 220,
  nodeHeight: 96,
  columnGap: 72,
  rowGap: 20,
  padding: 16,
} as const

function centerY(node: DagPlacedNode): number {
  return node.y + node.height / 2
}

/**
 * Build a stable React key that distinguishes edge domain and data port.
 * @param edge - normalized workflow edge.
 * @returns a key unique among schedule edges and per-port data edges.
 */
export function dagEdgeKey(edge: Pick<DagInputEdge, 'from' | 'to' | 'domain' | 'port'>): string {
  const domain = edge.domain ?? 'schedule'
  return domain === 'data'
    ? `data:${edge.from}->${edge.to}:${edge.port ?? ''}`
    : `schedule:${edge.from}->${edge.to}`
}

/**
 * Place nodes in columns by level and route every edge as a cubic curve.
 *
 * Columns follow ascending level order; `-1` (invalid workflows) sorts first so
 * a broken definition still renders instead of disappearing. Nodes within one
 * column are centred vertically against the tallest column.
 *
 * @param nodes - nodes with their execution level.
 * @param edges - dependency edges.
 * @param options - geometry overrides.
 * @returns the canvas size, placed nodes, and routed edges.
 */
export function layoutDag(
  nodes: readonly DagInputNode[],
  edges: readonly DagInputEdge[],
  options: DagLayoutOptions = {},
): DagLayout {
  const nodeWidth = options.nodeWidth ?? DEFAULTS.nodeWidth
  const nodeHeight = options.nodeHeight ?? DEFAULTS.nodeHeight
  const columnGap = options.columnGap ?? DEFAULTS.columnGap
  const rowGap = options.rowGap ?? DEFAULTS.rowGap
  const padding = options.padding ?? DEFAULTS.padding

  const levels = [...new Set(nodes.map(node => node.level))].sort((left, right) => left - right)
  const columns = new Map<number, DagInputNode[]>(levels.map(level => [level, []]))
  for (const node of nodes) columns.get(node.level)?.push(node)

  const tallest = Math.max(0, ...levels.map(level => columns.get(level)?.length ?? 0))
  const contentHeight = tallest * nodeHeight + Math.max(0, tallest - 1) * rowGap
  const width = padding * 2 + levels.length * nodeWidth + Math.max(0, levels.length - 1) * columnGap
  const height = padding * 2 + contentHeight

  const placed: DagPlacedNode[] = []
  for (const [column, level] of levels.entries()) {
    const columnNodes = columns.get(level) ?? []
    const columnHeight = columnNodes.length * nodeHeight + Math.max(0, columnNodes.length - 1) * rowGap
    const top = padding + (contentHeight - columnHeight) / 2
    for (const [row, node] of columnNodes.entries()) {
      placed.push({
        ...node,
        x: padding + column * (nodeWidth + columnGap),
        y: top + row * (nodeHeight + rowGap),
        width: nodeWidth,
        height: nodeHeight,
      })
    }
  }

  const byId = new Map(placed.map(node => [node.id, node]))
  const routed: DagPlacedEdge[] = []
  for (const edge of edges) {
    const from = byId.get(edge.from)
    const to = byId.get(edge.to)
    // An edge that names an unknown node is dropped rather than drawn from 0,0.
    if (from === undefined || to === undefined) continue
    const startX = from.x + from.width
    const startY = centerY(from)
    const endX = to.x
    const endY = centerY(to)
    const bend = Math.max(24, (endX - startX) / 2)
    // Control points stay inside the viewBox: a backwards edge bows below the
    // nodes, and both handles are clamped rather than left outside the canvas.
    const clampX = (value: number): number => Math.min(Math.max(value, 0), width)
    const clampY = (value: number): number => Math.min(Math.max(value, 0), height)
    const bow = clampY(Math.min(startY, endY) + 48)
    const path = endX <= startX
      ? `M ${startX} ${startY} C ${clampX(startX + bend)} ${bow}, ${clampX(endX - bend)} ${bow}, ${endX} ${endY}`
      : `M ${startX} ${startY} C ${clampX(startX + bend)} ${startY}, ${clampX(endX - bend)} ${endY}, ${endX} ${endY}`
    const domain = edge.domain ?? 'schedule'
    const port = domain === 'data' ? edge.port : undefined
    const label = domain === 'data'
      ? {
        x: clampX((from.x + from.width / 2 + to.x + to.width / 2) / 2),
        y: clampY((startY + endY) / 2),
      }
      : undefined
    routed.push({
      from: edge.from,
      to: edge.to,
      domain,
      path,
      ...(port === undefined ? {} : { port }),
      ...(label === undefined ? {} : { label }),
    })
  }

  return { width, height, nodes: placed, edges: routed }
}
