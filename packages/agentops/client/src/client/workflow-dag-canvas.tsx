/**
 * DAG canvas for one workflow definition.
 *
 * Renders the layered layout the workflows route already reports. Edit mode
 * exposes node and edge selection; all mutations are applied by the panel
 * through the source-edit API so YAML remains authoritative.
 *
 * @module @agentops/dsh-client/workflow-dag-canvas
 */

import { type ReactElement, useId, useMemo, useRef, useState } from 'react'

import {
  dagEdgeKey,
  layoutDag,
  type DagInputEdge,
  type DagInputNode,
  type DagPlacedEdge,
} from './workflow-dag-layout.js'
import type { WorkflowNodeType } from './workflow-editor-api.js'

/** Upper bound so a pathological definition cannot stall the panel. */
const MAX_NODES = 200
const MIN_ZOOM = 25
const MAX_ZOOM = 200
const ZOOM_STEP = 25

/** Localized controls and accessible names for DAG zoom. */
export interface WorkflowDagZoomLabels {
  readonly controlsAria: string
  readonly zoomIn: string
  readonly zoomOut: string
  readonly fit: string
  readonly reset: string
  readonly value: (percent: number) => string
}

/** One edge selected in the inspector. */
export type WorkflowDagEdgeSelection =
  | { readonly domain: 'schedule'; readonly from: string; readonly to: string }
  | { readonly domain: 'data'; readonly from: string; readonly to: string; readonly port: string }

export interface WorkflowDagCanvasProps {
  readonly workflowId: string
  readonly nodes: readonly DagInputNode[]
  readonly edges: readonly DagInputEdge[]
  /** Rendered above the canvas; the panel puts the file name there. */
  readonly caption?: string
  /** Nodes a selected validation issue refers to. */
  readonly highlightedNodeIds?: ReadonlySet<string>
  /** Shown when validation succeeded without any nodes. */
  readonly emptyText: string
  /** Shown when the caller's node limit would be exceeded. */
  readonly tooManyText: string
  /** Localized accessible name for the dependency graph. */
  readonly ariaLabel: string
  /** Format one execution level for the node badge. */
  readonly layerLabel: (level: number) => string
  /** Localized workflow node type. */
  readonly nodeTypeLabel?: (type: WorkflowNodeType) => string
  /** Localized count of node inputs. */
  readonly nodeInputsLabel?: (count: number) => string
  /** Localized output port summary. */
  readonly nodeOutputsLabel?: (ports: readonly string[]) => string
  /** Shown when a node declares no output ports. */
  readonly nodeNoOutputsLabel?: string
  /** Enable node selection for graph editing. */
  readonly editable?: boolean
  /** Enable node and edge inspection without implying editability. */
  readonly selectable?: boolean
  /** Node selected in the inspector. */
  readonly selectedNodeId?: string
  /** Edge selected in the inspector. */
  readonly selectedEdge?: WorkflowDagEdgeSelection
  /** Called when an editable node is activated by pointer or keyboard. */
  readonly onNodeSelect?: (id: string) => void
  /** Called when an editable edge is activated by pointer or keyboard. */
  readonly onEdgeSelect?: (edge: WorkflowDagEdgeSelection) => void
  /** Localized accessible name for an editable node. */
  readonly nodeAriaLabel?: (id: string) => string
  /** Localized accessible name for an editable edge. */
  readonly edgeAriaLabel?: (edge: WorkflowDagEdgeSelection) => string
  /** Localized zoom controls. Omit to render the graph without zoom controls. */
  readonly zoomLabels?: WorkflowDagZoomLabels
}

function edgeSelection(edge: DagPlacedEdge): WorkflowDagEdgeSelection {
  return edge.domain === 'data'
    ? { domain: 'data', from: edge.from, to: edge.to, port: edge.port ?? '' }
    : { domain: 'schedule', from: edge.from, to: edge.to }
}

function sameEdge(left: WorkflowDagEdgeSelection, right: WorkflowDagEdgeSelection): boolean {
  if (left.domain !== right.domain || left.from !== right.from || left.to !== right.to) return false
  if (left.domain === 'schedule') return true
  return right.domain === 'data' && left.port === right.port
}

function truncateSvgText(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`
}

function clampZoom(value: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(value)))
}

/**
 * Render one workflow as a layered SVG canvas.
 * @param props - workflow identity, nodes, edges, labels, and selection state.
 * @returns the canvas, or a notice when the definition is empty or too large.
 */
export function WorkflowDagCanvas({
  workflowId,
  nodes,
  edges,
  caption,
  highlightedNodeIds,
  emptyText,
  tooManyText,
  ariaLabel,
  layerLabel,
  nodeTypeLabel,
  nodeInputsLabel,
  nodeOutputsLabel,
  nodeNoOutputsLabel,
  editable = false,
  selectable = false,
  selectedNodeId,
  selectedEdge,
  onNodeSelect,
  onEdgeSelect,
  nodeAriaLabel,
  edgeAriaLabel,
  zoomLabels,
}: WorkflowDagCanvasProps): ReactElement {
  const actionable = editable || selectable
  const layout = useMemo(() => layoutDag(nodes, edges), [nodes, edges])
  const arrowMarkerId = `dag-arrow-${useId().replaceAll(':', '')}`
  const viewportRef = useRef<HTMLDivElement>(null)
  const [zoom, setZoom] = useState(100)

  const fitZoom = (): void => {
    const viewport = viewportRef.current
    if (viewport === null || viewport.clientWidth <= 0 || viewport.clientHeight <= 0) return
    const horizontal = viewport.clientWidth / layout.width
    const vertical = viewport.clientHeight / layout.height
    setZoom(clampZoom(Math.min(horizontal, vertical) * 100))
  }

  const resetZoom = (): void => {
    setZoom(100)
    viewportRef.current?.scrollTo({ top: 0, left: 0 })
  }

  if (nodes.length === 0) {
    return <p className="dag-canvas-empty">{emptyText}</p>
  }
  if (nodes.length > MAX_NODES) {
    return <p className="dag-canvas-empty">{tooManyText}</p>
  }

  return (
    <figure className="dag-canvas" data-workflow-id={workflowId}>
      {caption === undefined ? null : <figcaption className="dag-canvas-caption">{caption}</figcaption>}
      {zoomLabels === undefined ? null : (
        <div className="dag-canvas-toolbar" role="group" aria-label={zoomLabels.controlsAria}>
          <button
            type="button"
            aria-label={zoomLabels.zoomOut}
            title={zoomLabels.zoomOut}
            disabled={zoom <= MIN_ZOOM}
            onClick={() => { setZoom(current => clampZoom(current - ZOOM_STEP)) }}
          >
            −
          </button>
          <output aria-label={zoomLabels.value(zoom)}>{zoom}%</output>
          <button
            type="button"
            aria-label={zoomLabels.zoomIn}
            title={zoomLabels.zoomIn}
            disabled={zoom >= MAX_ZOOM}
            onClick={() => { setZoom(current => clampZoom(current + ZOOM_STEP)) }}
          >
            +
          </button>
          <button type="button" title={zoomLabels.fit} onClick={fitZoom}>
            {zoomLabels.fit}
          </button>
          <button type="button" title={zoomLabels.reset} onClick={resetZoom}>
            {zoomLabels.reset}
          </button>
        </div>
      )}
      <div ref={viewportRef} className="dag-canvas-scroll" data-zoom={zoom}>
        <svg
          role={actionable ? 'group' : 'img'}
          aria-label={ariaLabel}
          width={layout.width * zoom / 100}
          height={layout.height * zoom / 100}
          viewBox={`0 0 ${layout.width} ${layout.height}`}
        >
          <defs>
            <marker id={arrowMarkerId} viewBox="0 0 8 8" refX={7} refY={4} markerWidth={6} markerHeight={6} orient="auto">
              <path d="M 0 0 L 8 4 L 0 8 z" fill="currentColor" opacity={0.6} />
            </marker>
          </defs>
          <g className="dag-canvas-edges" fill="none" stroke="currentColor" strokeWidth={1.2}>
            {layout.edges.map((edge) => {
              const domain = edge.domain
              const selection = edgeSelection(edge)
              const selected = selectedEdge !== undefined && sameEdge(selection, selectedEdge)
              return (
                <g
                  key={dagEdgeKey(edge)}
                  className={`dag-canvas-edge-group${selected ? ' is-selected' : ''}`}
                  role={actionable ? 'button' : undefined}
                  tabIndex={actionable ? 0 : undefined}
                  aria-label={actionable ? (edgeAriaLabel?.(selection) ?? dagEdgeKey(edge)) : undefined}
                  aria-pressed={actionable ? selected : undefined}
                  onClick={actionable ? () => { onEdgeSelect?.(selection) } : undefined}
                  onKeyDown={actionable
                    ? (event) => {
                      if (event.key !== 'Enter' && event.key !== ' ') return
                      event.preventDefault()
                      onEdgeSelect?.(selection)
                    }
                    : undefined}
                >
                  <path className="dag-canvas-edge-hit" d={edge.path} />
                  <path
                    className={`dag-canvas-edge dag-canvas-edge-${domain}`}
                    d={edge.path}
                    markerEnd={`url(#${arrowMarkerId})`}
                    strokeDasharray={domain === 'data' ? '5 4' : undefined}
                  />
                  {domain === 'data' && edge.port !== undefined && edge.label !== undefined ? (
                    <text
                      className="dag-canvas-edge-port"
                      x={edge.label.x}
                      y={edge.label.y}
                      textAnchor="middle"
                      fontSize={9}
                      fill="currentColor"
                      stroke="none"
                      pointerEvents="none"
                    >
                      {edge.port}
                    </text>
                  ) : null}
                </g>
              )
            })}
          </g>
          <g className="dag-canvas-nodes">
            {layout.nodes.map((node) => {
              const highlighted = highlightedNodeIds?.has(node.id) ?? false
              const selected = selectedNodeId === node.id
              const outputPorts = Object.keys(node.outputs ?? {})
              const className = [
                'dag-canvas-node',
                highlighted ? 'dag-canvas-node-highlighted' : '',
                selected ? 'dag-canvas-node-selected' : '',
              ].filter(Boolean).join(' ')
              return (
                <g
                  key={node.id}
                  className={className}
                  transform={`translate(${node.x}, ${node.y})`}
                  role={actionable ? 'button' : undefined}
                  tabIndex={actionable ? 0 : undefined}
                  aria-label={actionable ? (nodeAriaLabel?.(node.id) ?? node.id) : undefined}
                  aria-pressed={actionable ? selected : undefined}
                  onClick={actionable ? () => onNodeSelect?.(node.id) : undefined}
                  onKeyDown={actionable
                    ? (event) => {
                      if (event.key !== 'Enter' && event.key !== ' ') return
                      event.preventDefault()
                      onNodeSelect?.(node.id)
                    }
                    : undefined}
                >
                  <title>{[
                    node.displayName ?? node.id,
                    node.id,
                    node.type === undefined ? undefined : (nodeTypeLabel?.(node.type) ?? node.type),
                    node.agentRef,
                    node.businessRole,
                    node.inputs === undefined
                      ? undefined
                      : nodeInputsLabel?.(node.inputs.length),
                    outputPorts.length === 0
                      ? nodeNoOutputsLabel
                      : (nodeOutputsLabel?.(outputPorts) ?? outputPorts.join(', ')),
                  ].filter((line): line is string => line !== undefined && line !== '').join('\n')}</title>
                  <rect
                    width={node.width}
                    height={node.height}
                    rx={8}
                    ry={8}
                    fill={highlighted
                      ? 'var(--state-error-tint)'
                      : selected
                        ? 'var(--color-primary-tint)'
                        : 'var(--color-bg-elevated)'}
                    stroke={highlighted
                      ? 'var(--state-error)'
                      : selected
                        ? 'var(--color-primary)'
                        : 'currentColor'}
                    strokeWidth={highlighted ? 2.5 : selected ? 2 : 1}
                    opacity={0.94}
                  />
                  <text className="dag-canvas-node-title" x={12} y={22} fontSize={12} fontWeight={500} fill="currentColor">
                    {truncateSvgText(node.displayName ?? node.id, 28)}
                  </text>
                  <text className="dag-canvas-node-id" x={12} y={39} fontFamily="var(--font-mono)" fontSize={9} fill="currentColor" opacity={0.7}>
                    {truncateSvgText(node.id, 32)}
                  </text>
                  <text className="dag-canvas-node-meta" x={12} y={57} fontSize={9.5} fill="currentColor" opacity={0.82}>
                    {truncateSvgText([
                      node.type === undefined ? undefined : (nodeTypeLabel?.(node.type) ?? node.type),
                      node.agentRef,
                    ].filter((part): part is string => part !== undefined).join(' · '), 34)}
                  </text>
                  <text className="dag-canvas-node-role" x={12} y={73} fontSize={9.5} fill="currentColor" opacity={0.72}>
                    {truncateSvgText(node.businessRole ?? '', 34)}
                  </text>
                  {node.inputs === undefined ? null : (
                    <text className="dag-canvas-node-inputs" x={12} y={90} fontSize={9} fill="currentColor" opacity={0.68}>
                      {truncateSvgText(
                        nodeInputsLabel?.(node.inputs.length) ?? String(node.inputs.length),
                        14,
                      )}
                    </text>
                  )}
                  <text className="dag-canvas-node-outputs" x={node.width - 12} y={90} textAnchor="end" fontSize={9} fill="currentColor" opacity={0.68}>
                    {truncateSvgText(outputPorts.length === 0
                      ? (nodeNoOutputsLabel ?? '')
                      : (nodeOutputsLabel?.(outputPorts) ?? outputPorts.join(', ')), 22)}
                  </text>
                  <text className="dag-canvas-node-layer" x={node.width - 12} y={39} textAnchor="end" fontSize={8.5} fill="currentColor" opacity={0.55}>
                    {layerLabel(node.level)}
                  </text>
                </g>
              )
            })}
          </g>
        </svg>
      </div>
    </figure>
  )
}
