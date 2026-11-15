/**
 * AgentOps data querying (read-only SQL) on DSH.
 *
 * Root: datasource status route. Tools (`sql_query`, `describe_database`) live in
 * `./tools.ts` because the tool registry is Agent-scoped.
 *
 * @module @agentops/dsh-db
 */

export { apply, inject, name, resolveDatasourcesPath, loadDatasources, registerDatasourceRoutes } from './dsh.ts'
export type { DbPluginConfig } from './dsh.ts'
export { parseDatasources, findDatasource, redactDsn } from './datasources.ts'
export type { DatasourceConfig, DatasourcesFile } from './datasources.ts'
export { guardSql, referencedTables } from './guard.ts'
export type { DatasourceWhitelist, GuardResult } from './guard.ts'
export { runQuery, describeSchema } from './query.ts'
export type { QueryPolicy, QueryResult, SchemaDescription, TableColumn, Target } from './query.ts'
export {
  agentPresetOf,
  capabilityStoreOf,
  claimsCapabilityDatabase,
  createDatabaseResolver,
  databaseEngineOf,
  databaseSchemaOf,
  normalizeDatabasePolicy,
  resolveCapabilityDatabase,
  resolveLegacyDatabase,
  targetFromInstance,
} from './instances.ts'
export type {
  CapabilityStoreProvider,
  DatabaseResolution,
  DatabaseResolver,
  ResolvedDatabase,
} from './instances.ts'
export { createDbTools } from './tools.ts'
