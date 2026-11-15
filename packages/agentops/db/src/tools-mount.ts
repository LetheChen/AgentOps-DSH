/**
 * Agent-scope half: register the read-only data tools.
 *
 * A database resolves through the capability center first: the same store the
 * configuration page writes decides which instance this preset may query.
 * `datasources.yml` remains an explicit legacy branch for presets the capability
 * center has never configured.
 *
 * @module @agentops/dsh-db/tools
 */

import type { Context } from '@deepseek-ai/cordis'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'

import { loadDatasources, resolveDatasourcesPath, type DbPluginConfig } from './dsh.ts'
import type { DatasourceConfig } from './datasources.ts'
import { capabilityStoreOf, createDatabaseResolver } from './instances.ts'
import type { Target } from './query.ts'
import { createDbTools } from './tools.ts'

export const name = 'agentops-db-tools'

export const inject = ['tools']

/** 本插件会注册的工具名（`only` 的合法取值）。 */
export const TOOL_NAMES = ['sql_query', 'describe_database'] as const

/** `only` 过滤器：undefined = 全注册；空数组 = 全禁；未知名字一律抛错（防拼错后静默失效）。 */
function onlyRegistrar(
  ctx: Context,
  only: readonly string[] | undefined,
  known: readonly string[],
): (definition: Parameters<Context['tools']['register']>[0]) => void {
  if (only !== undefined) {
    for (const name of only) {
      if (!known.includes(name)) {
        throw new Error(`only 含本插件不注册的工具 "${name}"；已知：${known.join(', ')}`)
      }
    }
  }
  const allow = only === undefined ? undefined : new Set(only)
  return (definition) => {
    if (allow === undefined || allow.has(definition.name)) ctx.tools.register(definition)
  }
}

/**
 * Build a target resolver over the legacy vault database.
 * @param vaultPath - credentials.db path.
 * @returns a resolver that looks a datasource up in the vault, then in the environment.
 */
export async function createVaultResolver(vaultPath: string): Promise<(datasource: DatasourceConfig) => Promise<Target | null>> {
  const { ConnectionStore } = await import('@agentops/dsh-vault/src/store.ts')
  const store = new ConnectionStore(vaultPath)
  return async (datasource) => {
    const connection = store.get(datasource.key)
    if (connection !== null && connection.kind === 'database') {
      let password: string | null = null
      try {
        password = store.readSecret(connection.id)
      } catch {
        password = null
      }
      return {
        driver: connection.driver === 'sqlite' ? 'sqlite' : connection.driver === 'pg' ? 'postgres' : 'mysql',
        host: connection.host,
        port: connection.port,
        username: connection.username,
        password,
        database: connection.defaultDatabase,
      }
    }
    const env = datasource.dsnEnv === null ? undefined : process.env[datasource.dsnEnv]
    if (env !== undefined && env.trim().length > 0) return parseDsn(datasource, env.trim())
    return null
  }
}

/**
 * Parse `mysql://user:pass@host:port/db`, `postgres://…` or a plain sqlite path.
 * @param datasource - the registry entry that declares the driver.
 * @param dsn - the connection string to parse.
 * @returns the connection target.
 */
export function parseDsn(datasource: DatasourceConfig, dsn: string): Target {
  if (datasource.driver === 'sqlite' || dsn.startsWith('/') || /^[A-Za-z]:[\\/]/.test(dsn)) {
    return { driver: 'sqlite', host: dsn, port: null, username: '', password: null, database: null }
  }
  const url = new URL(dsn)
  return {
    driver: url.protocol === 'postgres:' || url.protocol === 'postgresql:' ? 'postgres' : 'mysql',
    host: url.hostname,
    port: url.port === '' ? null : Number(url.port),
    username: decodeURIComponent(url.username),
    password: url.password === '' ? null : decodeURIComponent(url.password),
    database: url.pathname.replace(/^\//, '') || null,
  }
}

/**
 * Register the data tools for one Agent.
 * @param ctx - Agent-scoped context.
 * @param config - same config the root half used.
 */
export function apply(ctx: Context, config: DbPluginConfig = {}): void {
  const configs = loadDatasources(resolveDatasourcesPath(config))
  const vaultPath = process.env.AGENTOPS_CRED_DB?.trim()
    ?? dshHomePath('agentops', 'credentials.db')
  // The resolver is async because the vault module is loaded lazily; tools await it.
  const resolveLegacyTarget = async (datasource: DatasourceConfig): Promise<Target | null> => {
    const resolver = await createVaultResolver(vaultPath)
    return resolver(datasource)
  }
  const resolve = createDatabaseResolver({
    capabilityStore: () => capabilityStoreOf(ctx),
    datasources: configs,
    resolveLegacyTarget,
  })
  const reg = onlyRegistrar(ctx, (config as { only?: readonly string[] }).only, TOOL_NAMES)
  for (const tool of createDbTools(resolve)) reg(tool)
}
