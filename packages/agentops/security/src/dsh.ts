/**
 * Root plugin for the security domain: opens the new database and serves the
 * read-only routes. No model tools yet — access changes must be deliberate.
 *
 * @module @agentops/dsh-security/dsh
 */

import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'

import { createUsageTap } from './collector.ts'
import { registerSecurityRoutes } from './http.ts'
import { SecurityStore } from './store.ts'

export const name = 'agentops-security'

/** Root scope: no model registry here. */
export const inject: string[] = []

/** Configuration of the security plugin: the security database location. */
export interface SecurityPluginConfig {
  /** SQLite file for the security domain. */
  dbPath?: string
}

/** Default security configuration, overridable from `cordis.yml`. */
export const DEFAULT_CONFIG: SecurityPluginConfig = {}

/**
 * Resolve the database path: config, then `AGENTOPS_SECURITY_DB`, then
 * `$DSH_HOME/agentops/security.db`.
 * @param config - plugin configuration.
 * @param env - process environment.
 * @param home - home directory fallback.
 * @returns the resolved security database path.
 */
export function resolveSecurityDbPath(
  config: SecurityPluginConfig = DEFAULT_CONFIG,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  const explicit = config.dbPath?.trim()
  if (explicit !== undefined && explicit.length > 0) return explicit
  const fromEnv = env.AGENTOPS_SECURITY_DB?.trim()
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv
  return join(env.DSH_HOME?.trim() ?? join(home, '.dsh'), 'agentops', 'security.db')
}

/**
 * Mount the security capability.
 * @param ctx - Cordis context.
 * @param config - database location.
 */
export function apply(ctx: Context, config: SecurityPluginConfig = DEFAULT_CONFIG): void {
  const path = resolveSecurityDbPath(config)
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
  const store = new SecurityStore(path)
  ctx.inject(['connection'], (connectionCtx) => {
    registerSecurityRoutes(connectionCtx, store)
  })

  // Usage telemetry: observe every model call without touching the stream.
  // `llm/stream` is a waterfall, so the listener receives (options, next).
  ctx.inject(['llm'], (llmCtx) => {
    const tap = createUsageTap(store)
    const events = llmCtx as {
      on(name: string, listener: (...args: never[]) => unknown): () => void
      effect(factory: () => () => void): void
    }
    events.effect(() => events.on('llm/stream', ((request: unknown, next: () => AsyncIterable<unknown>) =>
      tap(request as never, next as never)) as never))
  })
}
