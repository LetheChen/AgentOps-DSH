/**
 * DAG tools, mounted inside an Agent preset.
 *
 * @module @agentops/dsh-dag/tools
 */

import type { Context } from '@deepseek-ai/cordis'

import { applyDagTools, DEFAULT_CONFIG } from './dsh.ts'
export { TOOL_NAMES } from './dsh.ts'
import type { DagPluginConfig } from './dsh.ts'

export const name = 'agentops-dag-tools'

export const inject = ['tools']

/**
 * Register `dag_validate`, `dag_run`, and `dag_rerun`.
 * @param ctx - Agent-scoped context carrying the tool registry.
 * @param config - subagent provider and concurrency.
 */
export function apply(ctx: Context, config: DagPluginConfig = DEFAULT_CONFIG): void {
  applyDagTools(ctx, config)
}
