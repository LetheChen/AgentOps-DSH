/**
 * Root half: datasource status route (no secrets) and config loading.
 *
 * The tool half lives in `./tools.ts` and is mounted from a preset, because the
 * `tools` registry is Agent-scoped.
 *
 * @module @agentops/dsh-db/dsh
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'

import { parseDatasources, type DatasourceConfig } from './datasources.ts'

export const name = 'agentops-db'

/** Root mounts no tools: that registry only exists inside an Agent scope. */
export const inject: string[] = []

/** Configuration of the database plugin: the datasources file location. */
export interface DbPluginConfig {
  /** YAML file describing datasources (default: `$DSH_HOME/agentops/datasources.yml`). */
  datasourcesFile?: string
}

/**
 * Resolve the datasources file path.
 * @param config - plugin configuration.
 * @returns the resolved datasources file path.
 */
export function resolveDatasourcesPath(config: DbPluginConfig = {}): string {
  const explicit = config.datasourcesFile?.trim() ?? process.env.AGENTOPS_DATASOURCES_FILE?.trim()
  if (explicit !== undefined && explicit.length > 0) return explicit
  return dshHomePath('agentops', 'datasources.yml')
}

/**
 * Load datasources, creating a documented sample on first run so the page has
 * something truthful to show instead of "not configured" with no explanation.
 * @param path - datasources file.
 * @returns the configured datasources.
 */
export function loadDatasources(path: string): DatasourceConfig[] {
  try {
    return parseDatasources(readFileSync(path, 'utf8'))
  } catch {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, SAMPLE, 'utf8')
    return parseDatasources(SAMPLE)
  }
}

const SAMPLE = `# AgentOps 数据源（只读问数，首次运行示例；请替换为真实配置）
# dsn_env 指向环境变量；不要把真实 DSN 写进本文件。
datasources:
  - key: audit_reader
    label: 业务数据库（示例）
    driver: sqlite            # mysql 需另装 mysql2；sqlite 内置
    dsn_env: AGENTOPS_DB_AUDIT_DSN
    credential_id: '@agentops/db/audit_reader'
    schemas: [business_db]
    tables:
      business_db: [records]
    denied_columns: [password_hash]
    max_rows: 1000
    timeout_seconds: 30
`

/**
 * Register `GET /api/agentops/datasources`: names, drivers and whether a DSN
 * resolves — never the DSN itself.
 * @param ctx - context carrying Connection.
 * @param configs - parsed datasources.
 * @param hasSecret - whether a DSN can be resolved for a datasource.
 */
export function registerDatasourceRoutes(
  ctx: Context,
  configs: readonly DatasourceConfig[],
  hasSecret: (datasource: DatasourceConfig) => Promise<boolean>,
): void {
  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/agentops/datasources',
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async () => {
      const rows = await Promise.all(configs.map(async datasource => ({
        key: datasource.key,
        label: datasource.label,
        driver: datasource.driver,
        configured:  (await hasSecret(datasource)),
        schemas: datasource.whitelist.schemas,
        tables: datasource.whitelist.tables,
        deniedColumns: datasource.whitelist.deniedColumns,
        maxRows: datasource.whitelist.maxRows,
      })))
      return new Response(JSON.stringify({ datasources: rows }), {
        headers: { 'content-type': 'application/json; charset=utf-8' },
      })
    },
  }), 'agentops-db: /api/agentops/datasources')
}

/**
 * Mount the root half.
 * @param ctx - Cordis context.
 * @param config - plugin configuration.
 */
export function apply(ctx: Context, config: DbPluginConfig = {}): void {
  const path = resolveDatasourcesPath(config)
  const configs = loadDatasources(path)
  const hasSecret = async (datasource: DatasourceConfig): Promise<boolean> => {
    const env = datasource.dsnEnv === null ? undefined : process.env[datasource.dsnEnv]
    if (env !== undefined && env.trim().length > 0) return true
    // A connection saved in the credential vault counts as configured.
    try {
      const { ConnectionStore } = await import('@agentops/dsh-vault/src/store.ts')
      const vaultPath = process.env.AGENTOPS_CRED_DB?.trim()
        ?? dshHomePath('agentops', 'credentials.db')
      const store = new ConnectionStore(vaultPath)
      const connection = store.get(datasource.key)
      store.close()
      if (connection !== null && connection.kind === 'database' && connection.hasSecret) return true
    } catch {
      // Vault unavailable: fall through to the other sources.
    }
    const credentials = ctx.get('credentials') as {
      describeRecord?: (key: string) => Promise<{ present: boolean }>
    } | undefined
    if (credentials?.describeRecord === undefined || datasource.credentialId === null) return false
    try {
      return (await credentials.describeRecord(datasource.credentialId)).present
    } catch {
      return false
    }
  }
  ctx.inject(['connection'], (connectionCtx) => {
    registerDatasourceRoutes(connectionCtx, configs, hasSecret)
  })
}
