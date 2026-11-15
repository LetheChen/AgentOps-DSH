/**
 * Root log collection plugin.
 * @module @agentops/dsh-log-collection/dsh
 */

import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { Service, type Context } from '@deepseek-ai/cordis'
import { CapabilityStore } from '@agentops/dsh-capability'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'

import { LogCollectionStore } from './store.ts'
import { LogCollectionHttpApi } from './http.ts'
import { registerLogCollectionRpc } from './mount-rpc.ts'
import { CapabilitySshResolver } from './capability-resolver.ts'
import { PullLogsService } from './pull.ts'
import { Ssh2LogTransport } from './transport.ts'

export const name = 'agentops-log-collection'

export const inject: string[] = []

/** Root plugin configuration. */
export interface LogCollectionPluginConfig {
  readonly dbPath?: string
  readonly capabilityDbPath?: string
  readonly localRoot?: string
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    logCollection: LogCollectionRuntime
  }
}

/** Root-owned log collection service consumed by Agent-scoped tools. */
export class LogCollectionRuntime extends Service {
  readonly store: LogCollectionStore
  readonly capabilityStore: CapabilityStore

  /**
   * @param ctx - root context.
   * @param store - task registry.
   * @param capabilityStore - capability center repository.
   */
  constructor(ctx: Context, store: LogCollectionStore, capabilityStore: CapabilityStore) {
    super(ctx, 'logCollection')
    this.store = store
    this.capabilityStore = capabilityStore
  }
}

/**
 * Resolve the log collection database path.
 * @param config - plugin config.
 * @returns SQLite path.
 */
export function resolveLogCollectionDbPath(config: LogCollectionPluginConfig = {}): string {
  return config.dbPath?.trim() || process.env.AGENTOPS_LOG_COLLECTION_DB?.trim()
    || dshHomePath('agentops', 'log-collection.db')
}

/**
 * Resolve the local task root.
 * @param config - plugin config.
 * @returns absolute local root.
 */
export function resolveLogCollectionRoot(config: LogCollectionPluginConfig = {}): string {
  return config.localRoot?.trim() || process.env.AGENTOPS_LOG_COLLECTION_ROOT?.trim()
    || dshHomePath('agentops', 'log-collections')
}

/**
 * Mount the root plugin and publish `ctx.logCollection`.
 * @param ctx - root context.
 * @param config - database and local-root overrides.
 */
export function apply(ctx: Context, config: LogCollectionPluginConfig = {}): void {
  const dbPath = resolveLogCollectionDbPath(config)
  mkdirSync(dirname(dbPath), { recursive: true })
  const db = new DatabaseSync(dbPath)
  const store = new LogCollectionStore(db, { localRoot: resolveLogCollectionRoot(config) })
  const capabilityStore = new CapabilityStore(
    config.capabilityDbPath?.trim() || dshHomePath('agentops', 'capabilities.db'),
  )
  new LogCollectionRuntime(ctx, store, capabilityStore)

  // The control plane needs a pull service for its "run now" action. That action
  // runs as the owner, so it resolves SSH config through the same capability store
  // without pretending to be a preset.
  const ownerPull = new PullLogsService(store, new CapabilitySshResolver(capabilityStore, null), new Ssh2LogTransport())
  const api = new LogCollectionHttpApi(store, capabilityStore, ownerPull)
  ctx.inject(['connection'], (connectionCtx) => {
    registerLogCollectionRpc(connectionCtx, api)
  })

  ctx.effect(() => () => {
    db.close()
    capabilityStore.close()
  })
}
