/**
 * Database instance resolution for the model-facing tools.
 *
 * The capability center is the authority for a capability-managed database: the
 * page that authorizes tables and the tool that runs SQL resolve the same
 * instance through the same store. `datasources.yml` stays as an explicit legacy
 * branch for presets the capability center has never configured, so an existing
 * deployment keeps working until an operator saves bindings for that preset.
 *
 * @module @agentops/dsh-db/instances
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { CapabilityRuntime, CapabilityStore } from '@agentops/dsh-capability'

import type { DatasourceConfig } from './datasources.ts'
import { findDatasource } from './datasources.ts'
import type { DatasourceWhitelist } from './guard.ts'
import type { Target } from './query.ts'

/** One database instance resolved for a single tool call. */
export interface ResolvedDatabase {
  /** Instance id; also the value the model passes as `database`. */
  readonly instanceId: string
  /** Human label used in rendered results and refusals. */
  readonly label: string
  /** Connection target with the decrypted password. */
  readonly target: Target
  /** Effective read-only policy, taken from the instance access policy. */
  readonly whitelist: DatasourceWhitelist
}

/** Outcome of resolving the database one tool call asked for. */
export type DatabaseResolution =
  | { readonly ok: true; readonly database: ResolvedDatabase }
  | { readonly ok: false; readonly reason: string }

/**
 * Resolve one database for a tool call.
 * @param requested - the model-supplied instance id, display name or database name.
 * @param agentPreset - preset of the executing Agent, when one is known.
 * @returns the resolved instance, or a reason the call must not run.
 */
export type DatabaseResolver = (
  requested: string | undefined,
  agentPreset: string | undefined,
) => Promise<DatabaseResolution>

/** Capability id whose instances may back SQL tools. */
export const DATABASE_CAPABILITY_ID = 'database'

/** Table names must be plain identifiers; the guard interpolates them into SQL. */
const TABLE_NAME = /^[A-Za-z0-9_$.-]+$/

/** Default row cap the original AgentOps policy used. */
const DEFAULT_MAX_ROWS = 5000

/** Default statement timeout the original AgentOps policy used. */
const DEFAULT_TIMEOUT_SECONDS = 30

/**
 * Read the executing Agent's live composed preset.
 * @param exec - the tool execution context, or undefined outside a tool run.
 * @returns the composed preset name, or undefined when no Agent is running.
 */
export function agentPresetOf(exec: ToolRunContext | undefined): string | undefined {
  const agent = exec?.agent
  if (agent === undefined) return undefined
  return agent.ctx.get('agentPresets')?.composedPreset(agent.ctx)
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}

/**
 * Normalize the engine name used by the original AgentOps instances.
 * @param config - instance configuration.
 * @returns the database engine the instance talks to.
 */
export function databaseEngineOf(config: Readonly<Record<string, unknown>>): 'mysql' | 'sqlite' | 'postgres' {
  const engine = stringValue(config.engine).toLowerCase()
  if (engine === 'sqlite') return 'sqlite'
  if (engine === 'pg' || engine === 'postgres' || engine === 'postgresql') return 'postgres'
  return 'mysql'
}

/**
 * The schema an instance exposes.
 *
 * PostgreSQL keeps database and schema in separate namespaces, so the schema
 * comes from `config.schema` and defaults to `public`. MySQL and SQLite use the
 * configured database name, then the first configured allowed schema.
 * @param config - instance configuration.
 * @param policy - instance access policy.
 * @returns the schema/table selector, or an empty string when none is configured.
 */
export function databaseSchemaOf(
  config: Readonly<Record<string, unknown>>,
  policy: Readonly<Record<string, unknown>>,
): string {
  if (databaseEngineOf(config) === 'postgres') {
    return stringValue(config.schema) || 'public'
  }
  const database = stringValue(config.database)
  if (database !== '') return database
  const allowed = policy.allowed_schemas
  if (Array.isArray(allowed)) {
    for (const item of allowed) {
      const value = stringValue(item)
      if (value !== '') return value
    }
  }
  // SQLite has no database name of its own; the single authorized schema key is
  // the only schema the instance can mean, so use it rather than dropping the policy.
  const tableMap = policy.allowed_tables
  if (typeof tableMap === 'object' && tableMap !== null && !Array.isArray(tableMap)) {
    const keys = Object.keys(tableMap)
    if (keys.length === 1 && keys[0] !== undefined) return keys[0]
  }
  return ''
}

function tableNames(policy: Readonly<Record<string, unknown>>, schema: string): string[] {
  const allowed = policy.allowed_tables
  let values: readonly unknown[] = []
  if (Array.isArray(allowed)) {
    values = allowed
  } else if (typeof allowed === 'object' && allowed !== null) {
    const map = allowed as Record<string, unknown>
    const direct = map[schema]
    if (Array.isArray(direct)) values = direct
    else {
      const entries = Object.values(map).filter(Array.isArray)
      if (entries.length === 1) values = entries[0] as readonly unknown[]
    }
  }
  const result: string[] = []
  const seen = new Set<string>()
  for (const value of values) {
    const name = stringValue(value)
    if (name === '' || seen.has(name)) continue
    if (!TABLE_NAME.test(name)) throw new Error(`access policy 里的表名不合法：${name}`)
    seen.add(name)
    result.push(name)
  }
  return result.sort()
}

/**
 * Canonicalize one instance access policy into the read-only guard policy.
 *
 * Mirrors AgentOps `normalize_database_policy`: `allowed_tables` accepts the
 * canonical `{ schema: [table] }` map and the legacy flat list, `denied_columns`
 * stays a list, and row/statement limits come from `operation_limits`.
 * @param config - instance configuration.
 * @param policy - instance access policy.
 * @returns the policy the SQL guard and schema reader share.
 */
export function normalizeDatabasePolicy(
  config: Readonly<Record<string, unknown>>,
  policy: Readonly<Record<string, unknown>>,
): DatasourceWhitelist {
  const schema = databaseSchemaOf(config, policy)
  const tables = tableNames(policy, schema)
  const schemas: string[] = schema === '' ? [] : [schema]
  if (Array.isArray(policy.allowed_schemas)) {
    for (const item of policy.allowed_schemas) {
      const value = stringValue(item)
      if (value !== '' && !schemas.includes(value)) schemas.push(value)
    }
  }
  const deniedColumns = Array.isArray(policy.denied_columns)
    ? policy.denied_columns.map(stringValue).filter(value => value !== '')
    : []
  const limits = typeof policy.operation_limits === 'object' && policy.operation_limits !== null
    ? policy.operation_limits as Readonly<Record<string, unknown>>
    : {}
  return {
    driver: databaseEngineOf(config),
    schemas,
    tables: schema === '' ? {} : { [schema]: tables },
    deniedColumns,
    maxRows: numberValue(limits.max_rows, DEFAULT_MAX_ROWS),
    timeoutSeconds: numberValue(limits.max_query_seconds, DEFAULT_TIMEOUT_SECONDS),
  }
}

/**
 * Build the connection target for one capability instance.
 * @param config - instance configuration.
 * @param secret - decrypted instance credential.
 * @returns the driver, host, port and credential the query layer needs.
 */
export function targetFromInstance(
  config: Readonly<Record<string, unknown>>,
  secret: string | null,
): Target {
  const engine = databaseEngineOf(config)
  const host = stringValue(config.host)
  if (host === '') throw new Error('数据库实例缺少 host')
  if (engine === 'sqlite') {
    return { driver: 'sqlite', host, port: null, username: '', password: null, database: null }
  }
  const username = stringValue(config.username)
  if (username === '') throw new Error('数据库实例缺少 username')
  return {
    driver: engine,
    host,
    port: typeof config.port === 'number' ? config.port : engine === 'postgres' ? 5432 : 3306,
    username,
    password: secret,
    database: stringValue(config.database) || null,
  }
}

/**
 * Resolve a database through the capability center for one preset.
 * @param store - the control-plane store.
 * @param agentPreset - preset of the executing Agent.
 * @param requested - model-supplied instance id, name or database name.
 * @returns the resolved instance, or a deny reason.
 */
export function resolveCapabilityDatabase(
  store: CapabilityStore,
  agentPreset: string,
  requested: string | undefined,
): DatabaseResolution {
  let runtime: CapabilityRuntime
  try {
    runtime = store.resolveRuntime(agentPreset, DATABASE_CAPABILITY_ID, requested)
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
  try {
    return {
      ok: true,
      database: {
        instanceId: runtime.instanceId,
        label: runtime.name,
        target: targetFromInstance(runtime.config, runtime.secret),
        whitelist: normalizeDatabasePolicy(runtime.config, runtime.accessPolicy),
      },
    }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Whether a requested key names a capability-managed database instance.
 *
 * A capability instance must never be reachable through the legacy datasource
 * file; otherwise a denied binding would be bypassed by the same key.
 * @param store - the control-plane store.
 * @param requested - model-supplied key.
 * @returns whether an instance claims that id, name or database.
 */
export function claimsCapabilityDatabase(store: CapabilityStore, requested: string | undefined): boolean {
  if (requested === undefined || requested.trim() === '') return false
  return store.findInstanceByKey(DATABASE_CAPABILITY_ID, requested) !== null
}

/**
 * Resolve a database from the legacy `datasources.yml` registry.
 * @param configs - parsed datasources.
 * @param requested - model-supplied datasource key.
 * @param resolveTarget - resolves the datasource to a live target.
 * @returns the resolved datasource, or a deny reason.
 */
export async function resolveLegacyDatabase(
  configs: readonly DatasourceConfig[],
  requested: string | undefined,
  resolveTarget: (datasource: DatasourceConfig) => Promise<Target | null>,
): Promise<DatabaseResolution> {
  const key = requested?.trim()
  const datasource = key === undefined || key === ''
    ? configs[0]
    : findDatasource(configs, key)
  if (datasource === undefined) {
    return { ok: false, reason: key === undefined || key === '' ? '没有配置任何数据源' : `未知数据源：${key}` }
  }
  const target = await resolveTarget(datasource)
  if (target === null) {
    return { ok: false, reason: `数据源 ${datasource.key} 未配置凭据` }
  }
  return {
    ok: true,
    database: {
      instanceId: datasource.key,
      label: datasource.label,
      target,
      whitelist: datasource.whitelist,
    },
  }
}

/**
 * Build the production resolver over the capability center and legacy fallback.
 * @param options - capability store, legacy datasources and legacy target resolver.
 * @returns a resolver the SQL tools can call.
 */
export function createDatabaseResolver(options: {
  /** Read the mounted capability store on each call, so preset load order cannot disable it. */
  readonly capabilityStore: () => CapabilityStore | undefined
  readonly datasources: readonly DatasourceConfig[]
  readonly resolveLegacyTarget: (datasource: DatasourceConfig) => Promise<Target | null>
}): DatabaseResolver {
  return async (requested, agentPreset) => {
    const store = options.capabilityStore()
    if (store !== undefined) {
      const preset = agentPreset?.trim() ?? ''
      if (preset !== '' && store.hasBindings(preset)) {
        return resolveCapabilityDatabase(store, preset, requested)
      }
      if (claimsCapabilityDatabase(store, requested)) {
        return {
          ok: false,
          reason: `数据库 ${requested ?? ''} 由能力中心管理，但当前 Agent 未获授权`,
        }
      }
    }
    return resolveLegacyDatabase(options.datasources, requested, options.resolveLegacyTarget)
  }
}

/** Structural view of the capability runtime service used by the resolver. */
export interface CapabilityStoreProvider {
  readonly store: CapabilityStore
}

/**
 * Read the capability store from one tool execution's Agent context.
 * @param ctx - the context holding the mounted capability center.
 * @returns the store, or undefined when the capability center is not mounted.
 */
export function capabilityStoreOf(ctx: Context): CapabilityStore | undefined {
  return ctx.get('capabilityRuntime')?.store
}
