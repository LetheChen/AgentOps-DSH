/**
 * Aggregate persisted DSH runs for the workflows that reference one Agent.
 *
 * Workflow nodes are the only persisted Agent association: DSH run rows do not
 * carry an Agent identity. Each workflow therefore counts once even when several
 * of its nodes reference the same Agent.
 *
 * @module @agentops/dsh-client/agent-run-stats
 */

import {
  loadRunHistory,
  type RunStatus,
  type RunSummary,
} from './run-history-api.js'

/** Run counts for the verified workflows that reference an Agent. */
export interface AgentRunStats {
  /** Number of distinct verified workflows that reference the Agent. */
  readonly workflowCount: number
  /** Total persisted runs across those workflows. */
  readonly total: number
  /** Runs currently executing across those workflows. */
  readonly running: number
  /** Completed runs across those workflows. */
  readonly completed: number
  /** Failed runs across those workflows. */
  readonly failed: number
  /** Cancelled runs across those workflows. */
  readonly cancelled: number
  /** Most recently started run among those workflows. */
  readonly latest?: RunSummary
}

const STATUSES: readonly RunStatus[] = ['running', 'completed', 'failed', 'cancelled']

function newerRun(candidate: RunSummary, current: RunSummary | undefined): boolean {
  if (current === undefined) return true
  if (candidate.startedAt !== current.startedAt) return candidate.startedAt > current.startedAt
  return candidate.runId > current.runId
}

/**
 * Load aggregate run statistics for an Agent's workflow bindings.
 * @param workflowIds - workflow identities; duplicates are counted once.
 * @param fetchImpl - fetch implementation, injectable for tests.
 * @returns exact run totals and the latest run across the distinct workflows.
 */
export async function loadAgentRunStats(
  workflowIds: readonly string[],
  fetchImpl: typeof fetch = fetch,
): Promise<AgentRunStats> {
  const uniqueWorkflowIds = [...new Set(workflowIds)]
  if (uniqueWorkflowIds.length === 0) {
    return {
      workflowCount: 0,
      total: 0,
      running: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
    }
  }

  const perWorkflow = await Promise.all(uniqueWorkflowIds.map(async (workflowId) => {
    const [all, ...byStatus] = await Promise.all([
      loadRunHistory({ workflowId, limit: 1 }, fetchImpl),
      ...STATUSES.map(status => loadRunHistory({ workflowId, status, limit: 1 }, fetchImpl)),
    ])
    return { all, byStatus }
  }))

  let latest: RunSummary | undefined
  let total = 0
  let running = 0
  let completed = 0
  let failed = 0
  let cancelled = 0
  for (const { all, byStatus } of perWorkflow) {
    total += all.total
    running += byStatus[0]?.total ?? 0
    completed += byStatus[1]?.total ?? 0
    failed += byStatus[2]?.total ?? 0
    cancelled += byStatus[3]?.total ?? 0
    const candidate = all.runs[0]
    if (candidate !== undefined && newerRun(candidate, latest)) latest = candidate
  }

  return {
    workflowCount: uniqueWorkflowIds.length,
    total,
    running,
    completed,
    failed,
    cancelled,
    ...(latest === undefined ? {} : { latest }),
  }
}
