/**
 * Handoff slot for a run id that the collaboration panel should select when it
 * next mounts.
 *
 * The run history panel and the collaboration panel are two views of the same
 * runs. The run history panel parks the chosen run id here and the layout
 * switches to the collaboration panel; the collaboration panel claims the id
 * on mount, so the selection survives the panel swap.
 *
 * @module @agentops/dsh-client/client
 */

let parkedRunId: string | null = null

/** Park a run id for the next collaboration panel mount.
 * @param runId - run the collaboration panel should select.
 */
export function requestCollaborationRun(runId: string): void {
  parkedRunId = runId
}

/**
 * Claim the parked run id, leaving none behind.
 * @returns the parked run id, or null when none was parked.
 */
export function takeCollaborationRun(): string | null {
  const runId = parkedRunId
  parkedRunId = null
  return runId
}
