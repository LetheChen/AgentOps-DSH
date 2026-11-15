/**
 * Host half of the AgentOps client package.
 *
 * @module @agentops/dsh-client
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { Config } from './config.ts'

export { Config } from './config.ts'

/**
 * Embed validated AgentOps browser settings in product pages.
 * @param ctx - Host context serving browser pages.
 * @param config - settings adopted when a browser page loads.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.on('webserver/index-inject', (table) => {
    table.push({
      kind: 'global',
      name: '__DSH_AGENTOPS_CLIENT_CONFIG__',
      value: config,
    })
  })
}
