/**
 * Versioned SQLite schema for the capability control plane.
 *
 * One database owns definitions, instances, sealed credential ciphertext,
 * Agent bindings, control-plane audit, and the outbox. Mutations that span
 * those tables use the same connection and transaction.
 *
 * @module @agentops/dsh-capability/schema
 */

import type { DatabaseSync } from 'node:sqlite'

/** Schema generation written to `PRAGMA user_version`. */
export const SCHEMA_VERSION = 1

/** Table names owned by this package. */
export const CAPABILITY_TABLES = [
  'capability_definitions',
  'capability_instances',
  'capability_bindings',
  'capability_audit',
  'capability_outbox',
  'capability_meta',
] as const

const SCHEMA_SQL = `
  CREATE TABLE capability_definitions (
    capability_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    category TEXT NOT NULL,
    provider TEXT NOT NULL,
    description TEXT NOT NULL,
    transports TEXT NOT NULL,
    config_schema TEXT NOT NULL,
    risk_level TEXT NOT NULL CHECK (risk_level IN ('low','medium','high')),
    authorization_capability_id TEXT NOT NULL,
    supports_instances INTEGER NOT NULL CHECK (supports_instances IN (0,1)),
    credential_required INTEGER NOT NULL CHECK (credential_required IN (0,1)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE capability_instances (
    instance_id TEXT PRIMARY KEY,
    capability_id TEXT NOT NULL REFERENCES capability_definitions(capability_id),
    name TEXT NOT NULL,
    config_json TEXT NOT NULL,
    access_policy_json TEXT NOT NULL,
    credential_cipher TEXT,
    credential_updated_at TEXT,
    status TEXT NOT NULL CHECK (status IN ('enabled','disabled','error')),
    last_test_status TEXT CHECK (last_test_status IN ('succeeded','failed')),
    last_test_at TEXT,
    last_test_error TEXT,
    created_by TEXT,
    updated_by TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX capability_instances_capability
    ON capability_instances(capability_id, created_at DESC);

  CREATE TABLE capability_bindings (
    agent_preset TEXT NOT NULL,
    capability_id TEXT NOT NULL,
    instance_id TEXT NOT NULL REFERENCES capability_instances(instance_id) ON DELETE CASCADE,
    enabled INTEGER NOT NULL CHECK (enabled IN (0,1)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (agent_preset, capability_id, instance_id)
  );
  CREATE INDEX capability_bindings_agent ON capability_bindings(agent_preset, enabled);

  CREATE TABLE capability_audit (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    target TEXT NOT NULL,
    result TEXT NOT NULL CHECK (result IN ('ok','fail')),
    detail_json TEXT NOT NULL,
    at TEXT NOT NULL
  );
  CREATE INDEX capability_audit_target ON capability_audit(target, seq DESC);

  CREATE TABLE capability_outbox (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    published_at TEXT
  );
  CREATE INDEX capability_outbox_pending ON capability_outbox(published_at, seq);

  CREATE TABLE capability_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`

/**
 * Create the current schema in an empty database.
 * @param db - open handle; the caller owns the surrounding transaction.
 */
export function createCapabilitySchema(db: DatabaseSync): void {
  db.exec(SCHEMA_SQL)
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
}

/**
 * Read the stored schema version.
 * @param db - open handle.
 * @returns the user-version integer, or 0 when absent.
 */
export function readSchemaVersion(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get() as Record<string, number> | undefined
  const value = row === undefined ? 0 : Object.values(row)[0]
  return typeof value === 'number' ? value : 0
}

/**
 * Reject a database that is not exactly at this package's schema generation.
 * @param db - open handle.
 */
export function assertCapabilitySchema(db: DatabaseSync): void {
  const version = readSchemaVersion(db)
  if (version !== SCHEMA_VERSION) {
    throw new Error(`capability database schema version ${version} is not ${SCHEMA_VERSION}`)
  }
}
