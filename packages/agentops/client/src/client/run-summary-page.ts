/** Helpers shared by paged run-list views. */

import type { RunSummary } from './run-history-api.js'

/**
 * Append unseen runs while preserving the server-provided order.
 *
 * @param current - summaries already rendered.
 * @param incoming - the next page returned by the run API.
 * @returns the existing summaries followed by newly seen summaries.
 */
export function appendRunSummaries(
  current: readonly RunSummary[],
  incoming: readonly RunSummary[],
): readonly RunSummary[] {
  const seen = new Set(current.map(run => run.runId))
  return [...current, ...incoming.filter((run) => {
    if (seen.has(run.runId)) return false
    seen.add(run.runId)
    return true
  })]
}
