/**
 * Datasource registry: where a datasource lives, how it is reached, and whether
 * its credential is present.
 *
 * Credentials are never stored here. A datasource names either an environment
 * variable holding a DSN or a DSH credential record (`@agentops/db/<key>`), and
 * only the DSH `credentials` service can turn that into a secret.
 */

import { load } from 'js-yaml'

import type { DatasourceWhitelist } from './guard.ts'

/** One configured datasource: where it lives, how it is reached, and its query policy. */
export interface DatasourceConfig {
  /** Logical name used by tools (`database` argument). */
  readonly key: string
  /** Human label for the UI. */
  readonly label: string
  /** `sqlite` for local/verification, `mysql` or `postgres` for a server database. */
  readonly driver: 'sqlite' | 'mysql' | 'postgres'
  /** Environment variable that may hold the DSN. */
  readonly dsnEnv: string | null
  /** Credential id inside the DSH store, when one is used. */
  readonly credentialId: string | null
  readonly whitelist: DatasourceWhitelist
}

/** The parsed shape of the datasources YAML document. */
export interface DatasourcesFile {
  readonly datasources: readonly DatasourceConfig[]
}

const EMPTY_WHITELIST: DatasourceWhitelist = {
  schemas: [],
  tables: {},
  deniedColumns: [],
  maxRows: 1000,
  timeoutSeconds: 30,
}

/**
 * Parse a datasources description (the DSH replacement for `db_whitelist.yaml`).
 * @param source - YAML text.
 * @returns the parsed datasources.
 */
export function parseDatasources(source: string): DatasourceConfig[] {
  const parsed = load(source) as {
    datasources?: {
      key?: unknown
      label?: unknown
      driver?: unknown
      dsn_env?: unknown
      credential_id?: unknown
      schemas?: unknown
      tables?: unknown
      denied_columns?: unknown
      max_rows?: unknown
      timeout_seconds?: unknown
    }[]
  } | null

  const rows = parsed?.datasources ?? []
  return rows.map((row) => {
    const key = String(row.key ?? '').trim()
    if (key === '') throw new Error('datasource 缺少 key')
    const driver = row.driver === 'mysql'
      ? 'mysql'
      : row.driver === 'postgres' || row.driver === 'pg'
        ? 'postgres'
        : 'sqlite'
    return {
      key,
      label: String(row.label ?? key),
      driver,
      dsnEnv: typeof row.dsn_env === 'string' ? row.dsn_env : null,
      credentialId: typeof row.credential_id === 'string' ? row.credential_id : null,
      whitelist: {
        schemas: Array.isArray(row.schemas) ? row.schemas.map(String) : EMPTY_WHITELIST.schemas,
        tables: (row.tables ?? {}) as Record<string, readonly string[]>,
        deniedColumns: Array.isArray(row.denied_columns) ? row.denied_columns.map(String) : [],
        maxRows: typeof row.max_rows === 'number' ? row.max_rows : EMPTY_WHITELIST.maxRows,
        timeoutSeconds: typeof row.timeout_seconds === 'number' ? row.timeout_seconds : EMPTY_WHITELIST.timeoutSeconds,
      },
    }
  })
}

/**
 * Find one datasource, or explain that it is not configured.
 * @param configs - parsed datasources.
 * @param key - requested key.
 * @returns the matching datasource, or undefined when it is not configured.
 */
export function findDatasource(configs: readonly DatasourceConfig[], key: string): DatasourceConfig | undefined {
  return configs.find(config => config.key === key)
}

/**
 * Conservative DSN redaction for logs and API responses.
 * @param dsn - the connection string whose password must not be shown.
 * @returns the DSN with its password replaced by `***`.
 */
export function redactDsn(dsn: string): string {
  return dsn.replace(/\/\/([^:]+):([^@]+)@/, '//$1:***@')
}
