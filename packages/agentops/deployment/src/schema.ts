/**
 * Deployment journal schema.
 * @module @agentops/dsh-deployment/schema
 */

import type { DatabaseSync } from 'node:sqlite'

/** Current deployment journal schema version. */
export const DEPLOYMENT_SCHEMA_VERSION = 1

/**
 * Create the release and lease tables.
 * @param db - deployment journal database.
 */
export function createDeploymentSchema(db: DatabaseSync): void {
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA user_version = 1;
    CREATE TABLE IF NOT EXISTS deployment_releases (
      release_uid TEXT PRIMARY KEY,
      instance_id TEXT NOT NULL,
      tenant_key TEXT NOT NULL,
      release_id TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN (
        'planned','uploading','releasing','health_checking','healthy','failed','unknown_hold','rolled_back'
      )),
      manifest_json TEXT,
      manifest_digest TEXT,
      backup_tag TEXT,
      backup_image_id TEXT,
      image_id TEXT,
      last_confirmed_step TEXT,
      steps_json TEXT NOT NULL,
      error_code TEXT,
      error_message TEXT,
      started_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      finished_at TEXT,
      UNIQUE(instance_id, release_id),
      CHECK(manifest_json IS NULL OR json_valid(manifest_json)),
      CHECK(json_valid(steps_json)),
      CHECK(json_type(steps_json) = 'array')
    );
    CREATE INDEX IF NOT EXISTS deployment_releases_instance_state
      ON deployment_releases(instance_id, state, started_at DESC);
    CREATE INDEX IF NOT EXISTS deployment_releases_instance_release
      ON deployment_releases(instance_id, release_id);
    CREATE TABLE IF NOT EXISTS deployment_leases (
      instance_id TEXT PRIMARY KEY,
      release_uid TEXT NOT NULL REFERENCES deployment_releases(release_uid) ON DELETE RESTRICT,
      owner_preset TEXT NOT NULL,
      fencing_token TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('active','unknown_hold')),
      acquired_at TEXT NOT NULL,
      heartbeat_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS deployment_leases_state
      ON deployment_leases(state, heartbeat_at);
  `)
}

/**
 * Read the current deployment journal schema version.
 * @param db - deployment journal database.
 * @returns current SQLite user_version.
 */
export function readDeploymentSchemaVersion(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number }
  return row.user_version
}
