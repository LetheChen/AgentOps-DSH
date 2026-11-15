/**
 * Root plugin entry for the capability control plane.
 *
 * The plugin owns one capability database and one store. Page routes mount
 * only after Connection is ready; the runtime resolver reads the same store.
 *
 * @module @agentops/dsh-capability/dsh
 */

import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'

import { CapabilityHttpApi } from './http.ts'
import { registerCapabilityRpc } from './mount-rpc.ts'
import { CapabilityRuntimeService } from './runtime.ts'
import { CapabilityStore } from './store.ts'
import { ConnectionStore } from '@agentops/dsh-vault/src/store.ts'

export const name = 'agentops-capability'

/** Root mounts no model tools; tool registration belongs to preset scope. */
export const inject: string[] = []

/** Plugin configuration. */
export interface CapabilityPluginConfig {
  /** Capability SQLite file; defaults to `$DSH_HOME/agentops/capabilities.db`. */
  dbPath?: string
}

/**
 * Resolve the capability database path.
 * @param config - plugin configuration.
 * @param env - process environment.
 * @param home - home directory.
 * @returns the resolved path.
 */
export function resolveCapabilityDbPath(
  config: CapabilityPluginConfig = {},
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  const explicit = config.dbPath?.trim()
  if (explicit !== undefined && explicit.length > 0) return explicit
  const fromEnv = env.AGENTOPS_CAPABILITY_DB?.trim()
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv
  return join(env.DSH_HOME?.trim() ?? join(home, '.dsh'), 'agentops', 'capabilities.db')
}

/**
 * Resolve the legacy credential database path.
 * @returns the vault path used before credentials moved into connector instances.
 */
export function resolveLegacyVaultPath(): string {
  return process.env.AGENTOPS_CRED_DB?.trim() || dshHomePath('agentops', 'credentials.db')
}

/**
 * Import the legacy vault exactly once. The source database stays untouched.
 * @param store - capability store receiving connector instances.
 * @param vaultPath - legacy credential database path.
 * @returns reported import count, including zero for an already-migrated vault.
 */
export function migrateLegacyVault(store: CapabilityStore, vaultPath = resolveLegacyVaultPath()): number {
  const marker = 'legacy_vault_migration_v1'
  if (store.readMeta(marker) !== null || !existsSync(vaultPath)) return 0
  const legacy = new ConnectionStore(vaultPath)
  try {
    const connections = legacy.list().map(connection => ({
      id: connection.id,
      kind: connection.kind,
      name: connection.name,
      driver: connection.driver,
      host: connection.host,
      port: connection.port,
      username: connection.username,
      defaultDatabase: connection.defaultDatabase,
      enabled: connection.enabled,
      secret: legacy.readSecret(connection.id),
    }))
    const imported = store.importLegacyConnections(connections)
    store.writeMeta(marker, JSON.stringify({ source: vaultPath, imported, at: new Date().toISOString() }))
    return imported
  } finally {
    legacy.close()
  }
}

/**
 * Mount the capability root.
 * @param ctx - Cordis context.
 * @param config - database location.
 */
export function apply(ctx: Context, config: CapabilityPluginConfig = {}): void {
  const path = config.dbPath?.trim() || process.env.AGENTOPS_CAPABILITY_DB?.trim() || dshHomePath('agentops', 'capabilities.db')
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
  const store = new CapabilityStore(path)
  migrateLegacyVault(store)
  new CapabilityRuntimeService(ctx, store)
  ctx.effect(() => () => { store.close() }, 'agentops-capability: close store')
  const api = new CapabilityHttpApi(store)
  ctx.inject(['connection'], (connectionCtx) => {
    registerCapabilityRpc(connectionCtx, api)
  })
}
