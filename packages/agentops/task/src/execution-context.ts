/**
 * Per-session execution context injected by the task dispatch bridge.
 *
 * The model never owns project identity. Tools read this registry using the
 * current Agent Session id and fail closed on a context mismatch.
 *
 * @module @agentops/dsh-task/execution-context
 */

/** Server-injected context for task tools running inside one Session. */
export interface TaskToolExecutionContext {
  readonly sessionId: string
  readonly taskId: string
  readonly projectId: string
  readonly workspaceId: string
  readonly workspaceSource: 'workspace_id' | 'local_path'
  readonly scopeId: string
  readonly leaseId: string
  readonly leaseToken: string
  readonly agentPreset: string
}

const contexts = new Map<string, TaskToolExecutionContext>()

/**
 * Bind one newly created Session to its task execution context.
 * @param context - server-derived context.
 */
export function setTaskToolExecutionContext(context: TaskToolExecutionContext): void {
  contexts.set(context.sessionId, context)
}

/**
 * Read the context bound to a Session.
 * @param sessionId - current Agent Session id.
 * @returns the context, or undefined outside a dispatched task.
 */
export function getTaskToolExecutionContext(sessionId: string | undefined): TaskToolExecutionContext | undefined {
  return sessionId === undefined ? undefined : contexts.get(sessionId)
}

/**
 * Remove a terminal or failed Session binding to avoid registry growth.
 * @param sessionId - current Agent Session id.
 */
export function clearTaskToolExecutionContext(sessionId: string | undefined): void {
  if (sessionId !== undefined) contexts.delete(sessionId)
}
