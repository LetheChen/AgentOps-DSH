/**
 * Agent-scoped pull_logs tool plugin.
 * @module @agentops/dsh-log-collection/tools
 */

import type { Context } from '@deepseek-ai/cordis'

import { CapabilitySshResolver } from './capability-resolver.ts'
import { PullLogsService } from './pull.ts'
import { mountLogListTasksTool, mountLogReadDeltaTool, mountPullLogsTool } from './tools.ts'
import { LogDeltaReader } from './delta.ts'
import { Ssh2LogTransport } from './transport.ts'

export const name = 'agentops-log-collection-tools'

export const inject = ['tools', 'logCollection']

/** Tool names registered by this plugin. */
export const TOOL_NAMES = ['pull_logs', 'log_read_delta', 'log_list_tasks'] as const

/** Agent-scoped tool configuration. */
export interface LogCollectionToolsConfig {
  readonly tenantKey: string
  readonly agentPreset: string
  readonly only?: readonly string[]
}

/**
 * Register pull_logs for one Agent preset.
 * @param ctx - Agent-scoped context.
 * @param config - authenticated tenant and preset id.
 */
export function apply(ctx: Context, config: LogCollectionToolsConfig): void {
  const tenantKey = config.tenantKey?.trim() ?? ''
  const agentPreset = config.agentPreset?.trim() ?? ''
  if (tenantKey === '' || agentPreset === '') {
    throw new Error('@agentops/dsh-log-collection/tools requires config.tenantKey and config.agentPreset')
  }
  const allow = config.only === undefined ? undefined : new Set(config.only)
  const auth = { tenantKey, agentPreset }
  if (allow === undefined || allow.has('pull_logs')) {
    const resolver = new CapabilitySshResolver(ctx.logCollection.capabilityStore, agentPreset)
    const service = new PullLogsService(ctx.logCollection.store, resolver, new Ssh2LogTransport())
    mountPullLogsTool(ctx, service, auth)
  }
  if (allow === undefined || allow.has('log_list_tasks')) {
    mountLogListTasksTool(ctx, ctx.logCollection.store, auth)
  }
  if (allow === undefined || allow.has('log_read_delta')) {
    mountLogReadDeltaTool(ctx, new LogDeltaReader(ctx.logCollection.store), auth)
  }
}
