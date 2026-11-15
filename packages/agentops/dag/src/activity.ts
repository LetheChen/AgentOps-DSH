/**
 * Collaboration projection for one persisted run.
 *
 * The projection combines the current workflow definition with the run store.
 * It never invents timestamps, conversation messages, or handoff events that
 * the store does not contain.
 */

import { dataEdges, scheduleDependencies } from '@agentops/dsh-contracts'

import type { RunRecord } from './run-store.js'
import type { NodeStatus, NodeType, RunState, WorkflowDefinition } from './types.js'

/** One business role lane in the collaboration view. */
export interface AgentActivityLane {
  /** Stable grouping key: business role, then agent reference, then node id. */
  id: string
  /** Display label derived from {@link id}. */
  label: string
  /** Node ids in workflow declaration order. */
  nodeIds: readonly string[]
}

/** One workflow node enriched with its persisted run state. */
export interface AgentActivityNode {
  id: string
  /** YAML display name, falling back to the node id. */
  displayName: string
  type: NodeType
  laneId: string
  status: NodeStatus
  attempts: number
  agentRef?: string
  businessRole?: string
  harness?: string
  model?: string
  startedAt?: string
  finishedAt?: string
  /** Non-negative elapsed time when both real timestamps are valid. */
  durationMs?: number
  error?: string
  chosenPort?: string
  outputs?: Readonly<Record<string, unknown>>
}

/** A scheduling dependency from `after`; the only edge that delays a node. */
export interface AgentActivityScheduleEdge {
  from: string
  to: string
}

/** A declared output dependency from `outputs`; it never delays a node. */
export interface AgentActivityDataEdge {
  from: string
  to: string
  port: string
}

/** Reconstructed collaboration event kinds supported by persisted run state. */
export type AgentActivityTimelineType =
  | 'run.started'
  | 'node.started'
  | 'node.completed'
  | 'node.failed'
  | 'node.skipped'
  | 'run.completed'
  | 'run.failed'
  | 'run.cancelled'

/** One chronologically ordered collaboration event. */
export interface AgentActivityTimelineEntry {
  id: string
  type: AgentActivityTimelineType
  occurredAt: string
  nodeId?: string
  /** Persisted failure text from the run or node state. */
  error?: string
}

/**
 * A handoff event for future event-store support.
 *
 * DSH run storage has no handoff event yet, so {@link projectAgentActivity}
 * always returns an empty array.
 */
export interface AgentActivityHandoff {
  id: string
  fromNodeId: string
  fromRole: string
  toNodeId: string
  toRole: string
  port: string
  payloadSize: number
  summary: string
  occurredAt?: string
}

/** Complete data consumed by the business-lane, DAG, and timeline views. */
export interface AgentActivity {
  runId: string
  workflowId: string
  status: RunState['status']
  /** Persisted top-level inputs; legacy runs use an empty object. */
  inputs: Readonly<Record<string, unknown>>
  startedAt: string
  finishedAt?: string
  lanes: readonly AgentActivityLane[]
  nodes: readonly AgentActivityNode[]
  scheduleEdges: readonly AgentActivityScheduleEdge[]
  dataEdges: readonly AgentActivityDataEdge[]
  timeline: readonly AgentActivityTimelineEntry[]
  handoffs: readonly AgentActivityHandoff[]
}

/** Inputs required to project one persisted run into the collaboration views. */
export interface ProjectAgentActivityInput {
  record: RunRecord
  workflow: WorkflowDefinition
}

interface PendingTimelineEntry {
  entry: AgentActivityTimelineEntry
  priority: number
  order: number
}

/**
 * Project a run into deterministic lanes, nodes, edges, and real-time events.
 *
 * Nodes absent from the persisted run state appear as `pending`. Timeline
 * entries are emitted only from persisted run and node timestamps.
 * @param input - persisted run record and its workflow definition.
 * @returns collaboration data for all three views.
 */
export function projectAgentActivity(input: ProjectAgentActivityInput): AgentActivity {
  const { record, workflow } = input
  const state = record.state
  const lanes = new Map<string, { id: string; label: string; nodeIds: string[] }>()
  const nodes: AgentActivityNode[] = []

  for (const node of workflow.nodes) {
    const nodeState = state.nodes[node.id]
    const laneId = node.businessRole ?? node.agentRef ?? node.id
    const lane = lanes.get(laneId)
    if (lane === undefined) lanes.set(laneId, { id: laneId, label: laneId, nodeIds: [node.id] })
    else lane.nodeIds.push(node.id)

    const projected: AgentActivityNode = {
      id: node.id,
      displayName: node.displayName ?? node.id,
      type: node.type,
      laneId,
      status: nodeState?.status ?? 'pending',
      attempts: nodeState?.attempts ?? 0,
    }
    if (node.agentRef !== undefined) projected.agentRef = node.agentRef
    if (node.businessRole !== undefined) projected.businessRole = node.businessRole
    if (node.harness !== undefined) projected.harness = node.harness
    if (node.model !== undefined) projected.model = node.model
    if (nodeState?.startedAt !== undefined) projected.startedAt = nodeState.startedAt
    if (nodeState?.finishedAt !== undefined) projected.finishedAt = nodeState.finishedAt
    const durationMs = calculateDuration(nodeState?.startedAt, nodeState?.finishedAt)
    if (durationMs !== undefined) projected.durationMs = durationMs
    if (nodeState?.error !== undefined) projected.error = nodeState.error
    if (nodeState?.chosenPort !== undefined) projected.chosenPort = nodeState.chosenPort
    if (nodeState?.outputs !== undefined) projected.outputs = nodeState.outputs
    nodes.push(projected)
  }

  const scheduleEdges: AgentActivityScheduleEdge[] = []
  for (const node of workflow.nodes) {
    for (const from of scheduleDependencies(node)) scheduleEdges.push({ from, to: node.id })
  }

  const activityDataEdges: AgentActivityDataEdge[] = []
  for (const edge of dataEdges(workflow.nodes)) {
    if (edge.to.trim().length === 0) continue
    activityDataEdges.push({ from: edge.from, to: edge.to, port: edge.port })
  }

  return {
    runId: state.runId,
    workflowId: record.workflowId,
    status: state.status,
    inputs: state.inputs ?? {},
    startedAt: state.startedAt,
    ...(state.finishedAt === undefined ? {} : { finishedAt: state.finishedAt }),
    lanes: [...lanes.values()],
    nodes,
    scheduleEdges,
    dataEdges: activityDataEdges,
    timeline: projectTimeline(state, workflow),
    handoffs: [],
  }
}

function projectTimeline(
  state: RunState,
  workflow: WorkflowDefinition,
): AgentActivityTimelineEntry[] {
  const entries: PendingTimelineEntry[] = []
  let order = 0

  const add = (
    type: AgentActivityTimelineType,
    occurredAt: string,
    priority: number,
    nodeId?: string,
    error?: string,
  ): void => {
    const entry: AgentActivityTimelineEntry = {
      id: nodeId === undefined ? type : `${type}:${nodeId}`,
      type,
      occurredAt,
      ...(nodeId === undefined ? {} : { nodeId }),
      ...(error === undefined ? {} : { error }),
    }
    entries.push({ entry, priority, order: order++ })
  }

  add('run.started', state.startedAt, 0)
  for (const node of workflow.nodes) {
    const nodeState = state.nodes[node.id]
    if (nodeState?.startedAt !== undefined) add('node.started', nodeState.startedAt, 10, node.id)
    if (nodeState?.finishedAt === undefined) continue

    switch (nodeState.status) {
      case 'completed':
        add('node.completed', nodeState.finishedAt, 20, node.id)
        break
      case 'failed':
        add('node.failed', nodeState.finishedAt, 20, node.id, nodeState.error)
        break
      case 'skipped':
        add('node.skipped', nodeState.finishedAt, 20, node.id)
        break
      case 'pending':
      case 'ready':
      case 'running':
        break
    }
  }

  if (state.finishedAt !== undefined) {
    switch (state.status) {
      case 'completed':
        add('run.completed', state.finishedAt, 30)
        break
      case 'failed':
        add('run.failed', state.finishedAt, 30, undefined, state.error)
        break
      case 'cancelled':
        add('run.cancelled', state.finishedAt, 30)
        break
      case 'running':
        break
    }
  }

  entries.sort((left, right) => {
    const timeDifference = timeOf(left.entry.occurredAt) - timeOf(right.entry.occurredAt)
    if (timeDifference !== 0) return timeDifference
    const priorityDifference = left.priority - right.priority
    return priorityDifference === 0 ? left.order - right.order : priorityDifference
  })
  return entries.map(item => item.entry)
}

function calculateDuration(startedAt: string | undefined, finishedAt: string | undefined): number | undefined {
  if (startedAt === undefined || finishedAt === undefined) return undefined
  const start = Date.parse(startedAt)
  const finish = Date.parse(finishedAt)
  if (!Number.isFinite(start) || !Number.isFinite(finish) || finish < start) return undefined
  return finish - start
}

function timeOf(value: string): number {
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY
}
