/**
 * Minimal log collection control schema.
 * @module @agentops/dsh-log-collection/schema
 */

import type { DatabaseSync } from 'node:sqlite'

/** Current schema version. */
export const LOG_COLLECTION_SCHEMA_VERSION = 1

/** Create the initial task and ACL tables. */
export function createLogCollectionSchema(db: DatabaseSync): void {
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA user_version = 1;
    CREATE TABLE log_collection_tasks (
      task_uid TEXT PRIMARY KEY,
      tenant_key TEXT NOT NULL,
      task_id TEXT NOT NULL,
      task_id_normalized TEXT NOT NULL,
      name TEXT NOT NULL,
      owner_domain TEXT NOT NULL,
      ssh_instance_id TEXT NOT NULL,
      remote_paths_json TEXT NOT NULL,
      storage_key TEXT NOT NULL UNIQUE,
      local_max_days INTEGER NOT NULL CHECK(local_max_days >= 0),
      enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
      revision INTEGER NOT NULL CHECK(revision >= 1),
      deleted_at TEXT,
      deleted_by TEXT,
      created_by TEXT NOT NULL,
      updated_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(tenant_key, task_id_normalized),
      CHECK(task_id_normalized = lower(task_id)),
      CHECK(storage_key = tenant_key || '/' || task_id_normalized),
      CHECK(json_valid(remote_paths_json)),
      CHECK(json_type(remote_paths_json) = 'array'),
      CHECK(json_array_length(remote_paths_json) > 0),
      CHECK(deleted_at IS NULL OR enabled = 0),
      CHECK((deleted_at IS NULL AND deleted_by IS NULL) OR (deleted_at IS NOT NULL AND deleted_by IS NOT NULL))
    );
    CREATE TABLE log_collection_task_acl (
      tenant_key TEXT NOT NULL,
      task_uid TEXT NOT NULL REFERENCES log_collection_tasks(task_uid) ON DELETE RESTRICT,
      agent_preset TEXT NOT NULL,
      generation INTEGER NOT NULL CHECK(generation >= 1),
      can_pull INTEGER NOT NULL CHECK(can_pull IN (0,1)),
      can_query INTEGER NOT NULL CHECK(can_query IN (0,1)),
      granted_by TEXT NOT NULL,
      granted_at TEXT NOT NULL,
      revoked_at TEXT,
      revoked_by TEXT,
      PRIMARY KEY(task_uid, agent_preset, generation),
      CHECK(can_pull = 1 OR can_query = 1),
      CHECK((revoked_at IS NULL AND revoked_by IS NULL) OR (revoked_at IS NOT NULL AND revoked_by IS NOT NULL))
    );
    CREATE UNIQUE INDEX uq_log_collection_acl_active
      ON log_collection_task_acl(task_uid, agent_preset)
      WHERE revoked_at IS NULL;
  `)
}

/** Read an existing schema version. */
export function readLogCollectionSchemaVersion(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number }
  return row.user_version
}
