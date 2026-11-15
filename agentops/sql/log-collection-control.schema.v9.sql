-- AgentOps control store schema (v9 candidate)
-- v4 is preserved separately as log-collection-control.schema.v4.sql.

PRAGMA foreign_keys = ON;
BEGIN IMMEDIATE;

CREATE TABLE control_store_meta (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  schema_version INTEGER NOT NULL CHECK(schema_version >= 1),
  created_at TEXT NOT NULL,
  applied_at TEXT NOT NULL
);

INSERT INTO control_store_meta(singleton, schema_version, created_at, applied_at)
VALUES (1, 1, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'));

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
  next_lease_fence INTEGER NOT NULL DEFAULT 1 CHECK(next_lease_fence >= 1),
  latest_published_run_id TEXT,
  deleted_at TEXT,
  deleted_by TEXT,
  created_by TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK(task_id GLOB '[A-Za-z0-9]*'),
  CHECK(task_id NOT GLOB '*[^A-Za-z0-9._-]*'),
  CHECK(length(task_id) <= 64),
  CHECK(task_id NOT IN ('.', '..')),
  CHECK(task_id NOT GLOB '*.'),
  CHECK(task_id_normalized = lower(task_id)),
  CHECK(upper(substr(task_id, 1, instr(task_id || '.', '.') - 1)) NOT IN (
    'CON','PRN','AUX','NUL','COM1','COM2','COM3','COM4','COM5','COM6','COM7','COM8','COM9',
    'LPT1','LPT2','LPT3','LPT4','LPT5','LPT6','LPT7','LPT8','LPT9'
  )),
  CHECK(tenant_key = lower(tenant_key)),
  CHECK(tenant_key GLOB '[a-z0-9][a-z0-9._-]*'),
  CHECK(tenant_key NOT GLOB '*[^a-z0-9._-]*'),
  CHECK(length(tenant_key) <= 64),
  CHECK(tenant_key NOT IN ('.', '..')),
  CHECK(tenant_key NOT GLOB '*.'),
  CHECK(upper(substr(tenant_key, 1, instr(tenant_key || '.', '.') - 1)) NOT IN (
    'CON','PRN','AUX','NUL','COM1','COM2','COM3','COM4','COM5','COM6','COM7','COM8','COM9',
    'LPT1','LPT2','LPT3','LPT4','LPT5','LPT6','LPT7','LPT8','LPT9'
  )),
  CHECK(owner_domain <> ''),
  CHECK(name <> ''),
  CHECK(json_valid(remote_paths_json)),
  CHECK(json_type(remote_paths_json) = 'array'),
  CHECK(json_array_length(remote_paths_json) > 0),
  CHECK(storage_key = tenant_key || '/' || task_id_normalized),
  CHECK(deleted_at IS NULL OR enabled = 0),
  CHECK((deleted_at IS NULL AND deleted_by IS NULL) OR (deleted_at IS NOT NULL AND deleted_by IS NOT NULL)),
  UNIQUE(tenant_key, task_id_normalized),
  UNIQUE(tenant_key, task_uid)
);

CREATE TABLE log_collection_task_acl (
  tenant_key TEXT NOT NULL,
  task_uid TEXT NOT NULL,
  agent_preset TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK(generation >= 1),
  can_pull INTEGER NOT NULL CHECK(can_pull IN (0,1)),
  can_query INTEGER NOT NULL CHECK(can_query IN (0,1)),
  granted_by TEXT NOT NULL,
  granted_at TEXT NOT NULL,
  revoked_at TEXT,
  revoked_by TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(task_uid, agent_preset, generation),
  FOREIGN KEY(tenant_key, task_uid) REFERENCES log_collection_tasks(tenant_key, task_uid) ON DELETE RESTRICT,
  CHECK(agent_preset <> ''),
  CHECK(can_pull = 1 OR can_query = 1),
  CHECK((revoked_at IS NULL AND revoked_by IS NULL) OR (revoked_at IS NOT NULL AND revoked_by IS NOT NULL))
);

CREATE UNIQUE INDEX uq_log_acl_active
  ON log_collection_task_acl(task_uid, agent_preset)
  WHERE revoked_at IS NULL;

CREATE TABLE workflow_schedules (
  schedule_id TEXT PRIMARY KEY,
  tenant_key TEXT NOT NULL,
  workflow_id TEXT NOT NULL,
  name TEXT NOT NULL,
  cron TEXT NOT NULL,
  time_zone TEXT NOT NULL DEFAULT 'Asia/Shanghai',
  input_template_json TEXT NOT NULL DEFAULT '{}',
  enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
  revision INTEGER NOT NULL CHECK(revision >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK(workflow_id <> ''),
  CHECK(name <> ''),
  CHECK(cron <> ''),
  CHECK(time_zone <> ''),
  CHECK(json_valid(input_template_json)),
  CHECK(json_type(input_template_json) = 'object'),
  CHECK(tenant_key = lower(tenant_key)),
  CHECK(tenant_key GLOB '[a-z0-9][a-z0-9._-]*'),
  CHECK(tenant_key NOT GLOB '*[^a-z0-9._-]*'),
  CHECK(upper(substr(tenant_key, 1, instr(tenant_key || '.', '.') - 1)) NOT IN (
    'CON','PRN','AUX','NUL','COM1','COM2','COM3','COM4','COM5','COM6','COM7','COM8','COM9',
    'LPT1','LPT2','LPT3','LPT4','LPT5','LPT6','LPT7','LPT8','LPT9'
  )),
  UNIQUE(tenant_key, schedule_id)
);

CREATE TABLE workflow_schedule_log_tasks (
  schedule_id TEXT NOT NULL REFERENCES workflow_schedules(schedule_id) ON DELETE CASCADE,
  task_uid TEXT NOT NULL REFERENCES log_collection_tasks(task_uid) ON DELETE RESTRICT,
  input_key TEXT NOT NULL DEFAULT 'log_task_id',
  created_at TEXT NOT NULL,
  PRIMARY KEY(schedule_id, input_key),
  UNIQUE(schedule_id, task_uid),
  CHECK(input_key GLOB '[a-z][a-z0-9_]*'),
  CHECK(input_key NOT GLOB '*[^a-z0-9_]*')
);

CREATE TABLE workflow_occurrences (
  occurrence_id TEXT PRIMARY KEY,
  schedule_id TEXT NOT NULL,
  tenant_key TEXT NOT NULL,
  scheduled_for TEXT NOT NULL,
  schedule_revision INTEGER NOT NULL CHECK(schedule_revision >= 1),
  input_template_json TEXT NOT NULL,
  input_template_sha256 TEXT NOT NULL,
  inputs_json TEXT NOT NULL,
  inputs_sha256 TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','claimed','running','succeeded','failed','skipped','needs_attention')),
  claimed_by TEXT,
  claim_fence INTEGER,
  claim_expires_at TEXT,
  started_at TEXT,
  finished_at TEXT,
  error_code TEXT,
  error_detail TEXT,
  receipt_json TEXT,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(tenant_key, schedule_id) REFERENCES workflow_schedules(tenant_key, schedule_id) ON DELETE RESTRICT,
  UNIQUE(schedule_id, scheduled_for),
  CHECK(json_valid(input_template_json)),
  CHECK(json_type(input_template_json) = 'object'),
  CHECK(json_valid(inputs_json)),
  CHECK(json_type(inputs_json) = 'object'),
  CHECK(length(input_template_sha256) = 64 AND input_template_sha256 NOT GLOB '*[^0-9a-f]*'),
  CHECK(length(inputs_sha256) = 64 AND inputs_sha256 NOT GLOB '*[^0-9a-f]*'),
  CHECK(length(scheduled_for) = 20
    AND scheduled_for GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]Z'
    AND CAST(substr(scheduled_for, 12, 2) AS INTEGER) BETWEEN 0 AND 23
    AND CAST(substr(scheduled_for, 15, 2) AS INTEGER) BETWEEN 0 AND 59
    AND CAST(substr(scheduled_for, 18, 2) AS INTEGER) BETWEEN 0 AND 59
    AND strftime('%Y-%m-%dT%H:%M:%SZ', scheduled_for) IS NOT NULL
    AND strftime('%Y-%m-%dT%H:%M:%SZ', scheduled_for) = scheduled_for),
  CHECK(receipt_json IS NULL OR json_valid(receipt_json)),
  CHECK(
    (status IN ('pending','claimed','running') AND finished_at IS NULL AND error_code IS NULL)
    OR
    (status IN ('succeeded','skipped') AND finished_at IS NOT NULL AND error_code IS NULL)
    OR
    (status IN ('failed','needs_attention') AND finished_at IS NOT NULL AND error_code IS NOT NULL)
  ),
  CHECK(
    (status = 'pending' AND claimed_by IS NULL AND claim_fence IS NULL AND claim_expires_at IS NULL)
    OR
    (status IN ('claimed','running') AND claimed_by IS NOT NULL AND claim_fence >= 1 AND claim_expires_at IS NOT NULL)
    OR
    status IN ('succeeded','failed','skipped','needs_attention')
  )
);

CREATE TABLE workflow_occurrence_log_tasks (
  occurrence_id TEXT NOT NULL REFERENCES workflow_occurrences(occurrence_id) ON DELETE RESTRICT,
  task_uid TEXT NOT NULL REFERENCES log_collection_tasks(task_uid) ON DELETE RESTRICT,
  task_id TEXT NOT NULL,
  input_key TEXT NOT NULL,
  PRIMARY KEY(occurrence_id, input_key),
  UNIQUE(occurrence_id, task_uid),
  CHECK(input_key GLOB '[a-z][a-z0-9_]*')
);

CREATE TABLE workflow_attempts (
  attempt_id TEXT PRIMARY KEY,
  occurrence_id TEXT NOT NULL REFERENCES workflow_occurrences(occurrence_id) ON DELETE RESTRICT,
  attempt_no INTEGER NOT NULL CHECK(attempt_no >= 1),
  attempt_fence INTEGER NOT NULL CHECK(attempt_fence >= 1),
  owner_id TEXT NOT NULL,
  workflow_run_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('claimed','running','succeeded','failed','canceled','needs_attention')),
  claim_expires_at TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  error_code TEXT,
  error_detail TEXT,
  receipt_json TEXT,
  UNIQUE(occurrence_id, attempt_id),
  UNIQUE(occurrence_id, attempt_no),
  UNIQUE(occurrence_id, attempt_fence),
  UNIQUE(workflow_run_id),
  CHECK(owner_id <> ''),
  CHECK(receipt_json IS NULL OR json_valid(receipt_json)),
  CHECK(
    (status IN ('claimed','running') AND finished_at IS NULL AND error_code IS NULL)
    OR
    (status IN ('succeeded','canceled') AND finished_at IS NOT NULL AND error_code IS NULL)
    OR
    (status IN ('failed','needs_attention') AND finished_at IS NOT NULL AND error_code IS NOT NULL)
  )
);

CREATE UNIQUE INDEX uq_workflow_attempt_active
  ON workflow_attempts(occurrence_id)
  WHERE status IN ('claimed','running');

CREATE TABLE log_collection_runs (
  run_id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  task_uid TEXT NOT NULL,
  task_revision INTEGER NOT NULL CHECK(task_revision >= 1),
  lease_fence INTEGER NOT NULL CHECK(lease_fence >= 1),
  occurrence_id TEXT,
  attempt_id TEXT,
  task_name TEXT NOT NULL,
  owner_domain TEXT NOT NULL,
  remote_paths_json TEXT NOT NULL,
  storage_key TEXT NOT NULL,
  local_max_days INTEGER NOT NULL CHECK(local_max_days >= 0),
  ssh_instance_id TEXT NOT NULL,
  ssh_instance_digest TEXT NOT NULL,
  credential_generation TEXT NOT NULL,
  trigger_kind TEXT NOT NULL CHECK(trigger_kind IN ('manual','schedule','agent','recovery')),
  status TEXT NOT NULL CHECK(status IN (
    'queued','connecting','listing','copying','publishing',
    'cancel_requested','canceled','completed','partial','failed','needs_attention'
  )),
  published_snapshot_id TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  heartbeat_at TEXT NOT NULL,
  files_seen INTEGER NOT NULL DEFAULT 0 CHECK(files_seen >= 0),
  files_pulled INTEGER NOT NULL DEFAULT 0 CHECK(files_pulled >= 0),
  files_skipped INTEGER NOT NULL DEFAULT 0 CHECK(files_skipped >= 0),
  bytes_pulled INTEGER NOT NULL DEFAULT 0 CHECK(bytes_pulled >= 0),
  error_code TEXT,
  error_detail TEXT,
  receipt_json TEXT,
  FOREIGN KEY(task_uid) REFERENCES log_collection_tasks(task_uid) ON DELETE RESTRICT,
  FOREIGN KEY(occurrence_id, attempt_id) REFERENCES workflow_attempts(occurrence_id, attempt_id) ON DELETE RESTRICT,
  UNIQUE(task_uid, lease_fence),
  UNIQUE(task_uid, run_id),
  UNIQUE(task_uid, run_id, lease_fence),
  CHECK(request_id <> ''),
  CHECK(ssh_instance_digest <> ''),
  CHECK(credential_generation <> ''),
  CHECK(json_valid(remote_paths_json)),
  CHECK(json_type(remote_paths_json) = 'array'),
  CHECK(json_array_length(remote_paths_json) > 0),
  CHECK(receipt_json IS NULL OR json_valid(receipt_json)),
  CHECK(
    (trigger_kind = 'schedule' AND occurrence_id IS NOT NULL AND attempt_id IS NOT NULL)
    OR
    (trigger_kind <> 'schedule' AND occurrence_id IS NULL AND attempt_id IS NULL)
  ),
  CHECK(
    (status IN ('queued','connecting','listing','copying','publishing','cancel_requested') AND finished_at IS NULL)
    OR
    (status IN ('canceled','completed','partial','failed','needs_attention') AND finished_at IS NOT NULL)
  ),
  CHECK(
    (status IN ('completed','partial') AND published_snapshot_id IS NOT NULL AND receipt_json IS NOT NULL)
    OR
    (status NOT IN ('completed','partial'))
  ),
  CHECK(status NOT IN ('failed','needs_attention') OR error_code IS NOT NULL)
);

CREATE UNIQUE INDEX uq_log_run_attempt
  ON log_collection_runs(attempt_id)
  WHERE attempt_id IS NOT NULL;

CREATE TABLE log_collection_objects (
  object_sha256 TEXT PRIMARY KEY,
  relative_path TEXT NOT NULL UNIQUE,
  size_bytes INTEGER NOT NULL CHECK(size_bytes >= 0),
  state TEXT NOT NULL CHECK(state IN ('staged','published','garbage')),
  publish_token TEXT NOT NULL,
  publish_lease_until TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK(length(object_sha256) = 64 AND object_sha256 NOT GLOB '*[^0-9a-f]*'),
  CHECK(relative_path = substr(object_sha256, 1, 2) || '/' || object_sha256),
  CHECK(publish_token <> '')
);

CREATE TABLE log_collection_observations (
  observation_id TEXT PRIMARY KEY,
  task_uid TEXT NOT NULL,
  run_id TEXT NOT NULL,
  remote_path TEXT NOT NULL,
  prior_observation_id TEXT REFERENCES log_collection_observations(observation_id) ON DELETE RESTRICT,
  identity_kind TEXT NOT NULL CHECK(identity_kind IN (
    'inode_mtime_ns','file_id_mtime_ns','size_mtime_ns','size_mtime_seconds','unobservable'
  )),
  identity_json TEXT NOT NULL,
  byte_size INTEGER NOT NULL CHECK(byte_size >= 0),
  prior_size INTEGER NOT NULL DEFAULT 0 CHECK(prior_size >= 0),
  prefix_sha256 TEXT NOT NULL,
  full_sha256 TEXT NOT NULL,
  continuity_state TEXT NOT NULL CHECK(continuity_state IN ('initial','proved','unprovable','gap')),
  gap_json TEXT NOT NULL DEFAULT '[]',
  observed_at TEXT NOT NULL,
  FOREIGN KEY(task_uid, run_id) REFERENCES log_collection_runs(task_uid, run_id) ON DELETE RESTRICT,
  UNIQUE(task_uid, run_id, remote_path),
  UNIQUE(task_uid, remote_path, observation_id),
  CHECK(remote_path LIKE '/%'),
  CHECK(length(remote_path) > 1),
  CHECK(instr(remote_path, char(0)) = 0),
  CHECK(('/' || remote_path || '/') NOT LIKE '%/../%'),
  CHECK(('/' || remote_path || '/') NOT LIKE '%/./%'),
  CHECK(json_valid(identity_json)),
  CHECK(json_valid(gap_json)),
  CHECK(json_type(gap_json) = 'array'),
  CHECK(length(prefix_sha256) = 64 AND prefix_sha256 NOT GLOB '*[^0-9a-f]*'),
  CHECK(length(full_sha256) = 64 AND full_sha256 NOT GLOB '*[^0-9a-f]*'),
  CHECK(
    (continuity_state = 'initial' AND prior_observation_id IS NULL AND prior_size = 0)
    OR
    (continuity_state = 'proved' AND prior_observation_id IS NOT NULL AND prior_size > 0 AND byte_size >= prior_size)
    OR
    continuity_state IN ('unprovable','gap')
  )
);

CREATE TABLE log_collection_snapshots (
  snapshot_id TEXT PRIMARY KEY,
  task_uid TEXT NOT NULL,
  run_id TEXT NOT NULL UNIQUE,
  manifest_object_sha256 TEXT NOT NULL REFERENCES log_collection_objects(object_sha256) ON DELETE RESTRICT,
  published_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('complete','partial')),
  retention_state TEXT NOT NULL DEFAULT 'retained' CHECK(retention_state IN ('retained','expired')),
  retired_at TEXT,
  FOREIGN KEY(task_uid, run_id) REFERENCES log_collection_runs(task_uid, run_id) ON DELETE RESTRICT,
  UNIQUE(task_uid, snapshot_id),
  CHECK((retention_state = 'retained' AND retired_at IS NULL) OR (retention_state = 'expired' AND retired_at IS NOT NULL))
);

CREATE TABLE log_collection_artifacts (
  artifact_id TEXT PRIMARY KEY,
  snapshot_id TEXT NOT NULL REFERENCES log_collection_snapshots(snapshot_id) ON DELETE RESTRICT,
  observation_id TEXT NOT NULL REFERENCES log_collection_observations(observation_id) ON DELETE RESTRICT,
  remote_path TEXT NOT NULL,
  object_sha256 TEXT REFERENCES log_collection_objects(object_sha256) ON DELETE RESTRICT,
  local_relative_path TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK(size_bytes >= 0),
  content_sha256 TEXT NOT NULL,
  retention_state TEXT NOT NULL DEFAULT 'retained' CHECK(retention_state IN ('retained','expired')),
  retired_at TEXT,
  UNIQUE(snapshot_id, remote_path),
  UNIQUE(snapshot_id, local_relative_path),
  CHECK(content_sha256 = object_sha256 OR object_sha256 IS NULL),
  CHECK(length(content_sha256) = 64 AND content_sha256 NOT GLOB '*[^0-9a-f]*'),
  CHECK(local_relative_path <> ''),
  CHECK(local_relative_path NOT LIKE '/%'),
  CHECK(local_relative_path NOT GLOB '*[\\:]*'),
  CHECK(instr(local_relative_path, char(0)) = 0),
  CHECK(('/' || local_relative_path || '/') NOT LIKE '%/../%'),
  CHECK(('/' || local_relative_path || '/') NOT LIKE '%/./%'),
  CHECK((retention_state = 'retained' AND object_sha256 IS NOT NULL AND retired_at IS NULL)
    OR (retention_state = 'expired' AND object_sha256 IS NULL AND retired_at IS NOT NULL))
);

CREATE TABLE log_collection_cursors (
  tenant_key TEXT NOT NULL,
  task_uid TEXT NOT NULL,
  remote_path TEXT NOT NULL,
  latest_observation_id TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(tenant_key, task_uid, remote_path),
  FOREIGN KEY(task_uid, remote_path, latest_observation_id)
    REFERENCES log_collection_observations(task_uid, remote_path, observation_id)
    ON DELETE RESTRICT
);

CREATE TABLE log_collection_leases (
  task_uid TEXT NOT NULL REFERENCES log_collection_tasks(task_uid) ON DELETE RESTRICT,
  run_id TEXT NOT NULL,
  fence INTEGER NOT NULL CHECK(fence >= 1),
  owner_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('active','released','expired','revoked')),
  expires_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  released_at TEXT,
  PRIMARY KEY(task_uid, run_id, fence),
  FOREIGN KEY(task_uid, run_id, fence)
    REFERENCES log_collection_runs(task_uid, run_id, lease_fence) ON DELETE RESTRICT,
  CHECK(owner_id <> ''),
  CHECK((status = 'active' AND released_at IS NULL) OR (status <> 'active' AND released_at IS NOT NULL))
);

CREATE UNIQUE INDEX uq_log_lease_active_task
  ON log_collection_leases(task_uid)
  WHERE status = 'active';

CREATE TABLE log_collection_staging (
  run_id TEXT PRIMARY KEY,
  task_uid TEXT NOT NULL,
  lease_fence INTEGER NOT NULL,
  owner_id TEXT NOT NULL,
  staging_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  cleaned_at TEXT,
  FOREIGN KEY(task_uid, run_id, lease_fence)
    REFERENCES log_collection_runs(task_uid, run_id, lease_fence) ON DELETE RESTRICT,
  CHECK(owner_id <> ''),
  CHECK(staging_key = task_uid || '/' || run_id || '/' || lease_fence)
);

CREATE TABLE log_collection_audit (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_key TEXT NOT NULL,
  actor_type TEXT NOT NULL CHECK(actor_type IN ('human','service','agent')),
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK(action IN (
    'TASK_CREATE','TASK_UPDATE','TASK_DELETE','ACL_GRANT','ACL_REVOKE',
    'SCHEDULE_CREATE','SCHEDULE_UPDATE','SCHEDULE_DELETE','SCHEDULE_LINK','SCHEDULE_UNLINK',
    'OCCURRENCE_CREATE','OCCURRENCE_CLAIM','OCCURRENCE_FINISH',
    'ATTEMPT_START','ATTEMPT_FINISH',
    'RUN_CREATE','RUN_START','RUN_COMPLETE','RUN_FAIL','RUN_CANCEL',
    'SNAPSHOT_PUBLISH','RETENTION_EXPIRE','OBJECT_GC',
    'MIGRATION_START','MIGRATION_COMPLETE','MIGRATION_FAIL'
  )),
  target_type TEXT NOT NULL CHECK(target_type IN (
    'TASK','ACL','SCHEDULE','OCCURRENCE','ATTEMPT','RUN','SNAPSHOT','OBJECT','MIGRATION'
  )),
  target_id TEXT NOT NULL,
  result TEXT NOT NULL CHECK(result IN ('ok','fail')),
  request_id TEXT NOT NULL,
  detail_json TEXT NOT NULL,
  at TEXT NOT NULL,
  CHECK(actor_id <> ''),
  CHECK(target_id <> ''),
  CHECK(request_id <> ''),
  CHECK(json_valid(detail_json)),
  CHECK(json_type(detail_json) = 'object')
);

CREATE TABLE log_collection_migrations (
  migration_id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK(status IN ('pending','running','completed','failed')),
  required_item_count INTEGER NOT NULL CHECK(required_item_count > 0),
  source_hashes_json TEXT NOT NULL,
  details_json TEXT NOT NULL DEFAULT '{}',
  rollback_point TEXT,
  error TEXT,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  updated_at TEXT NOT NULL,
  CHECK(json_valid(source_hashes_json)),
  CHECK(json_type(source_hashes_json) = 'object'),
  CHECK(json_valid(details_json)),
  CHECK(json_type(details_json) = 'object'),
  CHECK(
    (status IN ('pending','running') AND completed_at IS NULL AND error IS NULL)
    OR
    (status = 'completed' AND completed_at IS NOT NULL AND error IS NULL)
    OR
    (status = 'failed' AND completed_at IS NOT NULL AND error IS NOT NULL
      AND rollback_point IS NOT NULL AND rollback_point <> '')
  )
);

CREATE TABLE log_collection_migration_items (
  migration_id TEXT NOT NULL REFERENCES log_collection_migrations(migration_id) ON DELETE RESTRICT,
  source_item_id TEXT NOT NULL,
  target_kind TEXT NOT NULL CHECK(target_kind IN ('credential','capability_instance','binding','task','acl','schedule','history')),
  target_id TEXT,
  required INTEGER NOT NULL CHECK(required IN (0,1)),
  status TEXT NOT NULL CHECK(status IN ('pending','completed','failed','skipped')),
  error TEXT,
  credential_generation TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(migration_id, source_item_id),
  CHECK(
    (status = 'pending' AND error IS NULL)
    OR
    (status = 'completed' AND error IS NULL AND target_id IS NOT NULL
      AND (target_kind <> 'credential' OR credential_generation IS NOT NULL))
    OR
    (status = 'failed' AND error IS NOT NULL)
    OR
    (status = 'skipped' AND error IS NULL)
  )
);

-- Meta and task identity.
CREATE TRIGGER trg_control_schema_version_monotonic
BEFORE UPDATE OF schema_version ON control_store_meta
WHEN NEW.schema_version <= OLD.schema_version
BEGIN
  SELECT RAISE(ABORT, 'schema_version must increase');
END;

CREATE TRIGGER trg_log_task_insert_latest_pointer_null
BEFORE INSERT ON log_collection_tasks
WHEN NEW.latest_published_run_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'task latest pointer must start null');
END;

CREATE TRIGGER trg_log_task_remote_paths
BEFORE INSERT ON log_collection_tasks
BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM json_each(NEW.remote_paths_json)
    WHERE type <> 'text'
      OR value = ''
      OR value NOT LIKE '/%'
      OR instr(value, char(0)) > 0
      OR ('/' || value || '/') LIKE '%/../%'
      OR ('/' || value || '/') LIKE '%/./%'
      OR value LIKE '%/'
  ) THEN RAISE(ABORT, 'remote_paths_json contains an invalid remote path') END;
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM json_each(NEW.remote_paths_json) GROUP BY value HAVING count(*) > 1
  ) THEN RAISE(ABORT, 'remote_paths_json contains duplicates') END;
END;

CREATE TRIGGER trg_log_task_remote_paths_update
BEFORE UPDATE OF remote_paths_json ON log_collection_tasks
BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM json_each(NEW.remote_paths_json)
    WHERE type <> 'text'
      OR value = ''
      OR value NOT LIKE '/%'
      OR instr(value, char(0)) > 0
      OR ('/' || value || '/') LIKE '%/../%'
      OR ('/' || value || '/') LIKE '%/./%'
      OR value LIKE '%/'
  ) THEN RAISE(ABORT, 'remote_paths_json contains an invalid remote path') END;
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM json_each(NEW.remote_paths_json) GROUP BY value HAVING count(*) > 1
  ) THEN RAISE(ABORT, 'remote_paths_json contains duplicates') END;
END;

CREATE TRIGGER trg_log_task_no_physical_delete
BEFORE DELETE ON log_collection_tasks
BEGIN
  SELECT RAISE(ABORT, 'log tasks use soft delete');
END;

CREATE TRIGGER trg_log_task_identity_immutable
BEFORE UPDATE OF tenant_key, task_id, task_id_normalized, storage_key ON log_collection_tasks
BEGIN
  SELECT RAISE(ABORT, 'task identity is immutable');
END;

CREATE TRIGGER trg_log_task_no_undelete
BEFORE UPDATE OF deleted_at ON log_collection_tasks
WHEN OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL
BEGIN
  SELECT RAISE(ABORT, 'soft-deleted task cannot be restored; create a new task');
END;

CREATE TRIGGER trg_log_task_next_fence_monotonic
BEFORE UPDATE OF next_lease_fence ON log_collection_tasks
WHEN NEW.next_lease_fence <= OLD.next_lease_fence
BEGIN
  SELECT RAISE(ABORT, 'next lease fence must increase');
END;

CREATE TRIGGER trg_log_task_disable_referenced
BEFORE UPDATE OF enabled ON log_collection_tasks
WHEN OLD.enabled = 1 AND NEW.enabled = 0
  AND EXISTS (SELECT 1 FROM workflow_schedule_log_tasks WHERE task_uid = OLD.task_uid)
BEGIN
  SELECT RAISE(ABORT, 'referenced task cannot be disabled');
END;

CREATE TRIGGER trg_log_task_soft_delete
BEFORE UPDATE OF deleted_at ON log_collection_tasks
WHEN NEW.deleted_at IS NOT NULL
BEGIN
  SELECT CASE WHEN NEW.enabled <> 0 THEN RAISE(ABORT, 'deleted task must be disabled') END;
  SELECT CASE WHEN EXISTS (SELECT 1 FROM workflow_schedule_log_tasks WHERE task_uid = OLD.task_uid)
    THEN RAISE(ABORT, 'task is referenced by schedules') END;
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM log_collection_runs WHERE task_uid = OLD.task_uid AND status NOT IN (
      'canceled','completed','partial','failed','needs_attention'
    )
  ) THEN RAISE(ABORT, 'task has a non-terminal run') END;
END;

CREATE TRIGGER trg_log_acl_identity_immutable
BEFORE UPDATE OF tenant_key, task_uid, agent_preset, generation ON log_collection_task_acl
BEGIN
  SELECT RAISE(ABORT, 'ACL identity is immutable');
END;

CREATE TRIGGER trg_log_acl_no_physical_delete
BEFORE DELETE ON log_collection_task_acl
BEGIN
  SELECT RAISE(ABORT, 'ACL rows are revoked, not deleted');
END;

CREATE TRIGGER trg_workflow_schedule_tenant_immutable
BEFORE UPDATE OF tenant_key ON workflow_schedules
BEGIN
  SELECT RAISE(ABORT, 'schedule tenant is immutable');
END;

CREATE TRIGGER trg_workflow_schedule_revision_monotonic
BEFORE UPDATE OF revision ON workflow_schedules
WHEN NEW.revision <= OLD.revision
BEGIN
  SELECT RAISE(ABORT, 'schedule revision must increase');
END;

CREATE TRIGGER trg_schedule_link_live_task
BEFORE INSERT ON workflow_schedule_log_tasks
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM workflow_schedules s
    JOIN log_collection_tasks t ON t.task_uid = NEW.task_uid
    WHERE s.schedule_id = NEW.schedule_id
      AND s.tenant_key = t.tenant_key
      AND t.deleted_at IS NULL
      AND t.enabled = 1
  ) THEN RAISE(ABORT, 'schedule requires a live enabled task in the same tenant') END;
  SELECT CASE WHEN json_type(
    (SELECT input_template_json FROM workflow_schedules WHERE schedule_id = NEW.schedule_id),
    '$.' || NEW.input_key
  ) IS NOT NULL THEN RAISE(ABORT, 'schedule input key collides with task link') END;
END;

CREATE TRIGGER trg_schedule_link_no_update
BEFORE UPDATE ON workflow_schedule_log_tasks
BEGIN
  SELECT RAISE(ABORT, 'schedule task links are immutable; unlink and insert');
END;

CREATE TRIGGER trg_schedule_template_no_link_collision
BEFORE UPDATE OF input_template_json ON workflow_schedules
WHEN EXISTS (SELECT 1 FROM workflow_schedule_log_tasks WHERE schedule_id = OLD.schedule_id)
BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM workflow_schedule_log_tasks l
    WHERE l.schedule_id = OLD.schedule_id
      AND json_type(NEW.input_template_json, '$.' || l.input_key) IS NOT NULL
  ) THEN RAISE(ABORT, 'schedule input key collides with task link') END;
END;

CREATE TRIGGER trg_workflow_occurrence_insert
BEFORE INSERT ON workflow_occurrences
BEGIN
  SELECT CASE WHEN NEW.status <> 'pending'
    OR NEW.claimed_by IS NOT NULL OR NEW.claim_fence IS NOT NULL OR NEW.claim_expires_at IS NOT NULL
    OR NEW.started_at IS NOT NULL OR NEW.finished_at IS NOT NULL OR NEW.error_code IS NOT NULL
    OR NEW.receipt_json IS NOT NULL
  THEN RAISE(ABORT, 'occurrence must be inserted pending') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM workflow_schedules s
    WHERE s.tenant_key = NEW.tenant_key
      AND s.schedule_id = NEW.schedule_id
      AND s.enabled = 1
      AND s.revision = NEW.schedule_revision
      AND s.input_template_json = NEW.input_template_json
  ) THEN RAISE(ABORT, 'occurrence requires the current enabled schedule template') END;
  SELECT CASE WHEN (
    SELECT count(*) FROM json_each(NEW.inputs_json)
  ) <> (
    SELECT count(*) FROM json_each(NEW.input_template_json)
  ) + (
    SELECT count(*) FROM workflow_schedule_log_tasks WHERE schedule_id = NEW.schedule_id
  ) THEN RAISE(ABORT, 'occurrence inputs contain missing or extra keys') END;
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM json_each(NEW.input_template_json) t
    WHERE json_type(NEW.inputs_json, '$.' || t.key) IS NULL
      OR json_extract(NEW.inputs_json, '$.' || t.key) IS NOT t.value
  ) THEN RAISE(ABORT, 'occurrence inputs do not match schedule template') END;
  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM workflow_schedule_log_tasks l
    JOIN log_collection_tasks t ON t.task_uid = l.task_uid
    WHERE l.schedule_id = NEW.schedule_id
      AND (
        json_type(NEW.inputs_json, '$.' || l.input_key) IS NULL
        OR json_extract(NEW.inputs_json, '$.' || l.input_key) <> t.task_id
        OR t.deleted_at IS NOT NULL
        OR t.enabled = 0
      )
  ) THEN RAISE(ABORT, 'occurrence inputs do not match linked live tasks') END;
END;

CREATE TRIGGER trg_workflow_occurrence_link_insert
BEFORE INSERT ON workflow_occurrence_log_tasks
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM workflow_occurrences o
    JOIN workflow_schedule_log_tasks l ON l.schedule_id = o.schedule_id
    JOIN log_collection_tasks t ON t.task_uid = NEW.task_uid
    WHERE o.occurrence_id = NEW.occurrence_id
      AND o.status = 'pending'
      AND l.task_uid = NEW.task_uid
      AND l.input_key = NEW.input_key
      AND t.task_id = NEW.task_id
      AND json_extract(o.inputs_json, '$.' || NEW.input_key) = NEW.task_id
  ) THEN RAISE(ABORT, 'occurrence task link does not match schedule link') END;
END;

CREATE TRIGGER trg_workflow_occurrence_claim
BEFORE UPDATE OF status ON workflow_occurrences
WHEN NEW.status <> OLD.status
BEGIN
  SELECT CASE WHEN OLD.status IN ('succeeded','failed','skipped','needs_attention')
    THEN RAISE(ABORT, 'terminal occurrence cannot transition') END;
  SELECT CASE WHEN NOT (
    (OLD.status = 'pending' AND NEW.status IN ('claimed','failed','skipped','needs_attention')) OR
    (OLD.status = 'claimed' AND NEW.status IN ('claimed','running','failed','skipped','needs_attention')) OR
    (OLD.status = 'running' AND NEW.status IN ('succeeded','failed','needs_attention'))
  ) THEN RAISE(ABORT, 'invalid occurrence status transition') END;
  SELECT CASE WHEN NEW.status IN ('claimed','running') AND (
    NEW.claimed_by IS NULL OR NEW.claim_fence IS NULL OR NEW.claim_fence < 1
    OR NEW.claim_expires_at IS NULL
    OR julianday(NEW.claim_expires_at) <= julianday('now')
  ) THEN RAISE(ABORT, 'active occurrence requires a live claim') END;
  SELECT CASE WHEN NEW.status = 'running' AND NOT EXISTS (
    SELECT 1 FROM workflow_attempts a
    WHERE a.occurrence_id = NEW.occurrence_id
      AND a.status IN ('claimed','running')
      AND a.owner_id = NEW.claimed_by
      AND a.attempt_fence = NEW.claim_fence
  ) THEN RAISE(ABORT, 'running occurrence requires its active attempt') END;
  SELECT CASE WHEN NEW.status IN ('claimed','running') AND EXISTS (
    SELECT 1 FROM workflow_occurrence_log_tasks ol
    JOIN log_collection_tasks t ON t.task_uid = ol.task_uid
    WHERE ol.occurrence_id = NEW.occurrence_id
      AND (t.deleted_at IS NOT NULL OR t.enabled = 0 OR t.task_id <> ol.task_id)
  ) THEN RAISE(ABORT, 'occurrence task is no longer live') END;
END;

CREATE TRIGGER trg_workflow_occurrence_immutable
BEFORE UPDATE OF occurrence_id, schedule_id, tenant_key, scheduled_for,
  schedule_revision, input_template_json, input_template_sha256, inputs_json, inputs_sha256
ON workflow_occurrences
BEGIN
  SELECT RAISE(ABORT, 'occurrence frozen inputs are immutable');
END;

CREATE TRIGGER trg_workflow_occurrence_terminal_immutable
BEFORE UPDATE ON workflow_occurrences
WHEN OLD.status IN ('succeeded','failed','skipped','needs_attention')
BEGIN
  SELECT RAISE(ABORT, 'terminal occurrence is immutable');
END;

CREATE TRIGGER trg_workflow_occurrence_no_physical_delete
BEFORE DELETE ON workflow_occurrences
BEGIN
  SELECT RAISE(ABORT, 'workflow occurrences are immutable history');
END;

CREATE TRIGGER trg_workflow_attempt_insert
BEFORE INSERT ON workflow_attempts
BEGIN
  SELECT CASE WHEN NEW.status <> 'claimed'
    OR NEW.finished_at IS NOT NULL OR NEW.error_code IS NOT NULL OR NEW.receipt_json IS NOT NULL
  THEN RAISE(ABORT, 'attempt must be inserted claimed') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM workflow_occurrences o
    WHERE o.occurrence_id = NEW.occurrence_id
      AND o.status IN ('claimed','running')
      AND o.claimed_by = NEW.owner_id
      AND o.claim_fence = NEW.attempt_fence
      AND julianday(o.claim_expires_at) > julianday('now')
      AND julianday(NEW.claim_expires_at) > julianday('now')
  ) THEN RAISE(ABORT, 'attempt requires the live occurrence claim') END;
END;

CREATE TRIGGER trg_workflow_attempt_transition
BEFORE UPDATE OF status ON workflow_attempts
WHEN NEW.status <> OLD.status
BEGIN
  SELECT CASE WHEN OLD.status IN ('succeeded','failed','canceled','needs_attention')
    THEN RAISE(ABORT, 'terminal attempt cannot transition') END;
  SELECT CASE WHEN NOT (
    (OLD.status = 'claimed' AND NEW.status IN ('running','failed','canceled','needs_attention')) OR
    (OLD.status = 'running' AND NEW.status IN ('succeeded','failed','canceled','needs_attention'))
  ) THEN RAISE(ABORT, 'invalid attempt status transition') END;
  SELECT CASE WHEN NEW.status IN ('claimed','running') AND (
    NEW.owner_id IS NULL OR NEW.claim_expires_at IS NULL
    OR julianday(NEW.claim_expires_at) <= julianday('now')
  ) THEN RAISE(ABORT, 'active attempt requires a live lease') END;
END;

CREATE TRIGGER trg_workflow_attempt_identity_immutable
BEFORE UPDATE OF attempt_id, occurrence_id, attempt_no, attempt_fence, owner_id, workflow_run_id
ON workflow_attempts
BEGIN
  SELECT RAISE(ABORT, 'attempt identity is immutable');
END;

CREATE TRIGGER trg_workflow_attempt_terminal_immutable
BEFORE UPDATE ON workflow_attempts
WHEN OLD.status IN ('succeeded','failed','canceled','needs_attention')
BEGIN
  SELECT RAISE(ABORT, 'terminal workflow attempt is immutable');
END;

CREATE TRIGGER trg_workflow_attempt_no_physical_delete
BEFORE DELETE ON workflow_attempts
BEGIN
  SELECT RAISE(ABORT, 'workflow attempts are immutable history');
END;

-- Runs.
CREATE TRIGGER trg_log_run_insert_initial
BEFORE INSERT ON log_collection_runs
BEGIN
  SELECT CASE WHEN NEW.status <> 'queued'
    OR NEW.published_snapshot_id IS NOT NULL
    OR NEW.finished_at IS NOT NULL
    OR NEW.error_code IS NOT NULL
    OR NEW.error_detail IS NOT NULL
    OR NEW.receipt_json IS NOT NULL
    OR NEW.files_seen <> 0 OR NEW.files_pulled <> 0 OR NEW.files_skipped <> 0 OR NEW.bytes_pulled <> 0
  THEN RAISE(ABORT, 'run must be inserted queued with empty outcome') END;
END;

CREATE TRIGGER trg_log_run_insert_identity
BEFORE INSERT ON log_collection_runs
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM log_collection_tasks t
    WHERE t.task_uid = NEW.task_uid
      AND t.deleted_at IS NULL
      AND t.enabled = 1
      AND t.revision = NEW.task_revision
      AND t.name = NEW.task_name
      AND t.owner_domain = NEW.owner_domain
      AND t.remote_paths_json = NEW.remote_paths_json
      AND t.storage_key = NEW.storage_key
      AND t.local_max_days = NEW.local_max_days
      AND t.ssh_instance_id = NEW.ssh_instance_id
      AND NEW.lease_fence = t.next_lease_fence - 1
  ) THEN RAISE(ABORT, 'run inputs or fence do not match a live task revision') END;
  SELECT CASE WHEN NEW.trigger_kind = 'schedule' AND NOT EXISTS (
    SELECT 1
    FROM workflow_attempts a
    JOIN workflow_occurrences o ON o.occurrence_id = a.occurrence_id
    JOIN workflow_occurrence_log_tasks ol ON ol.occurrence_id = o.occurrence_id AND ol.task_uid = NEW.task_uid
    JOIN log_collection_tasks t ON t.task_uid = ol.task_uid AND t.task_id = ol.task_id AND t.tenant_key = o.tenant_key
    WHERE a.occurrence_id = NEW.occurrence_id
      AND a.attempt_id = NEW.attempt_id
      AND a.status IN ('claimed','running')
      AND a.attempt_fence = NEW.lease_fence
      AND a.owner_id = o.claimed_by
      AND o.claim_fence = a.attempt_fence
      AND julianday(o.claim_expires_at) > julianday('now')
      AND julianday(a.claim_expires_at) > julianday('now')
      AND t.task_uid = NEW.task_uid
  ) THEN RAISE(ABORT, 'scheduled run requires its live attempt and task') END;
END;

CREATE TRIGGER trg_log_run_identity_immutable
BEFORE UPDATE OF run_id, request_id, task_uid, task_revision, lease_fence,
  occurrence_id, attempt_id, task_name, owner_domain, remote_paths_json,
  storage_key, local_max_days, ssh_instance_id, ssh_instance_digest,
  credential_generation, trigger_kind ON log_collection_runs
BEGIN
  SELECT RAISE(ABORT, 'run identity is immutable');
END;

CREATE TRIGGER trg_log_run_transition
BEFORE UPDATE OF status ON log_collection_runs
WHEN NEW.status <> OLD.status
BEGIN
  SELECT CASE WHEN OLD.status IN ('canceled','completed','partial','failed','needs_attention')
    THEN RAISE(ABORT, 'terminal run cannot transition') END;
  SELECT CASE WHEN NOT (
    (OLD.status = 'queued' AND NEW.status IN ('connecting','cancel_requested','failed','needs_attention')) OR
    (OLD.status = 'connecting' AND NEW.status IN ('listing','cancel_requested','failed','needs_attention')) OR
    (OLD.status = 'listing' AND NEW.status IN ('copying','cancel_requested','failed','needs_attention')) OR
    (OLD.status = 'copying' AND NEW.status IN ('publishing','cancel_requested','failed','needs_attention')) OR
    (OLD.status = 'publishing' AND NEW.status IN ('completed','partial','failed','needs_attention')) OR
    (OLD.status = 'cancel_requested' AND NEW.status IN ('canceled','failed','needs_attention'))
  ) THEN RAISE(ABORT, 'invalid run status transition') END;
  SELECT CASE WHEN NEW.status IN ('connecting','listing','copying','publishing','completed','partial')
    AND NOT EXISTS (
      SELECT 1 FROM log_collection_leases l
      WHERE l.task_uid = NEW.task_uid
        AND l.run_id = NEW.run_id
        AND l.fence = NEW.lease_fence
        AND l.status = 'active'
        AND julianday(l.expires_at) > julianday('now')
    )
  THEN RAISE(ABORT, 'active run transition requires its live lease') END;
  SELECT CASE WHEN NEW.status = 'completed' AND EXISTS (
    SELECT 1 FROM log_collection_observations
    WHERE task_uid = NEW.task_uid AND run_id = NEW.run_id
      AND continuity_state IN ('gap','unprovable')
  ) THEN RAISE(ABORT, 'completed run cannot contain unproved continuity') END;
END;

CREATE TRIGGER trg_log_run_terminal_immutable
BEFORE UPDATE ON log_collection_runs
WHEN OLD.status IN ('canceled','completed','partial','failed','needs_attention')
BEGIN
  SELECT RAISE(ABORT, 'terminal run is immutable');
END;

CREATE TRIGGER trg_log_run_no_physical_delete
BEFORE DELETE ON log_collection_runs
BEGIN
  SELECT RAISE(ABORT, 'runs are immutable history');
END;

CREATE TRIGGER trg_log_run_completion_snapshot
BEFORE UPDATE OF status ON log_collection_runs
WHEN NEW.status IN ('completed','partial') AND NEW.status <> OLD.status
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM log_collection_snapshots s
    WHERE s.snapshot_id = NEW.published_snapshot_id
      AND s.task_uid = NEW.task_uid
      AND s.run_id = NEW.run_id
      AND s.status = CASE NEW.status WHEN 'completed' THEN 'complete' ELSE 'partial' END
  ) THEN RAISE(ABORT, 'terminal snapshot status mismatch') END;
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM log_collection_snapshots s
    JOIN log_collection_objects o ON o.object_sha256 = s.manifest_object_sha256
    WHERE s.snapshot_id = NEW.published_snapshot_id AND o.state <> 'published'
  ) OR EXISTS (
    SELECT 1 FROM log_collection_artifacts a
    JOIN log_collection_objects o ON o.object_sha256 = a.object_sha256
    WHERE a.snapshot_id = NEW.published_snapshot_id AND o.state <> 'published'
  ) OR NOT EXISTS (
    SELECT 1 FROM log_collection_artifacts a
    WHERE a.snapshot_id = NEW.published_snapshot_id AND a.retention_state = 'retained'
  ) THEN RAISE(ABORT, 'published snapshot requires a retained published artifact') END;
END;

CREATE TRIGGER trg_log_run_pointer_matches_snapshot
BEFORE UPDATE OF published_snapshot_id ON log_collection_runs
WHEN NEW.published_snapshot_id IS NOT NULL
BEGIN
  SELECT CASE WHEN NEW.status <> 'publishing' THEN RAISE(ABORT, 'snapshot pointer is set while publishing') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM log_collection_snapshots s
    WHERE s.snapshot_id = NEW.published_snapshot_id
      AND s.task_uid = NEW.task_uid
      AND s.run_id = NEW.run_id
  ) THEN RAISE(ABORT, 'published snapshot identity mismatch') END;
END;

CREATE TRIGGER trg_log_task_latest_pointer
BEFORE UPDATE OF latest_published_run_id ON log_collection_tasks
WHEN NEW.latest_published_run_id IS NOT NULL
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM log_collection_runs r
    WHERE r.run_id = NEW.latest_published_run_id
      AND r.task_uid = NEW.task_uid
      AND r.status IN ('completed','partial')
      AND r.published_snapshot_id IS NOT NULL
  ) THEN RAISE(ABORT, 'latest published run identity mismatch') END;
END;

-- Objects.
CREATE TRIGGER trg_log_object_insert
BEFORE INSERT ON log_collection_objects
BEGIN
  SELECT CASE WHEN NEW.state <> 'staged' THEN RAISE(ABORT, 'object must be inserted staged') END;
END;

CREATE TRIGGER trg_log_object_identity_immutable
BEFORE UPDATE OF object_sha256, relative_path, size_bytes, publish_token, publish_lease_until ON log_collection_objects
BEGIN
  SELECT RAISE(ABORT, 'object identity is immutable');
END;

CREATE TRIGGER trg_log_object_state_transition
BEFORE UPDATE OF state ON log_collection_objects
WHEN NEW.state <> OLD.state
BEGIN
  SELECT CASE WHEN NOT (
    (OLD.state = 'staged' AND NEW.state = 'published'
      AND julianday(OLD.publish_lease_until) > julianday('now') AND (
      EXISTS (SELECT 1 FROM log_collection_snapshots WHERE manifest_object_sha256 = OLD.object_sha256)
      OR EXISTS (SELECT 1 FROM log_collection_artifacts WHERE object_sha256 = OLD.object_sha256)
    ))
    OR
    (OLD.state = 'staged' AND NEW.state = 'garbage'
      AND julianday(OLD.publish_lease_until) <= julianday(NEW.updated_at)
      AND NOT EXISTS (SELECT 1 FROM log_collection_snapshots WHERE manifest_object_sha256 = OLD.object_sha256)
      AND NOT EXISTS (SELECT 1 FROM log_collection_artifacts WHERE object_sha256 = OLD.object_sha256))
    OR
    (OLD.state = 'published' AND NEW.state = 'garbage'
      AND NOT EXISTS (SELECT 1 FROM log_collection_snapshots WHERE manifest_object_sha256 = OLD.object_sha256)
      AND NOT EXISTS (SELECT 1 FROM log_collection_artifacts WHERE object_sha256 = OLD.object_sha256))
  ) THEN RAISE(ABORT, 'invalid object state transition') END;
END;

CREATE TRIGGER trg_log_object_no_delete
BEFORE DELETE ON log_collection_objects
WHEN OLD.state <> 'garbage'
BEGIN
  SELECT RAISE(ABORT, 'only garbage objects may be deleted');
END;

-- Observations, snapshots, artifacts.
CREATE TRIGGER trg_log_observation_run_state
BEFORE INSERT ON log_collection_observations
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM log_collection_runs r
    WHERE r.task_uid = NEW.task_uid
      AND r.run_id = NEW.run_id
      AND r.status IN ('copying','publishing')
  ) THEN RAISE(ABORT, 'observation requires a copying or publishing run') END;
END;

CREATE TRIGGER trg_log_observation_prior_identity
BEFORE INSERT ON log_collection_observations
WHEN NEW.continuity_state = 'proved'
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM log_collection_observations p
    JOIN log_collection_runs pr ON pr.task_uid = p.task_uid AND pr.run_id = p.run_id
    JOIN log_collection_cursors c
      ON c.task_uid = NEW.task_uid
     AND c.remote_path = NEW.remote_path
     AND c.latest_observation_id = p.observation_id
    WHERE p.observation_id = NEW.prior_observation_id
      AND p.task_uid = NEW.task_uid
      AND p.remote_path = NEW.remote_path
      AND p.run_id <> NEW.run_id
      AND p.byte_size = NEW.prior_size
      AND p.full_sha256 = NEW.prefix_sha256
      AND p.continuity_state IN ('initial','proved')
      AND pr.status = 'completed'
      AND pr.published_snapshot_id IS NOT NULL
  ) THEN RAISE(ABORT, 'continuity proof does not match the latest completed cursor baseline') END;
END;

CREATE TRIGGER trg_log_observation_immutable
BEFORE UPDATE ON log_collection_observations
BEGIN
  SELECT RAISE(ABORT, 'observations are immutable');
END;

CREATE TRIGGER trg_log_observation_no_physical_delete
BEFORE DELETE ON log_collection_observations
BEGIN
  SELECT RAISE(ABORT, 'observations are immutable history');
END;

CREATE TRIGGER trg_log_snapshot_requires_run
BEFORE INSERT ON log_collection_snapshots
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM log_collection_runs r
    WHERE r.run_id = NEW.run_id
      AND r.task_uid = NEW.task_uid
      AND r.status = 'publishing'
      AND EXISTS (
        SELECT 1 FROM log_collection_leases l
        WHERE l.task_uid = r.task_uid AND l.run_id = r.run_id
          AND l.fence = r.lease_fence AND l.status = 'active'
          AND julianday(l.expires_at) > julianday('now')
      )
  ) THEN RAISE(ABORT, 'snapshot requires a publishing run with its live lease') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM log_collection_objects o
    WHERE o.object_sha256 = NEW.manifest_object_sha256
      AND (o.state = 'published' OR (o.state = 'staged' AND julianday(o.publish_lease_until) > julianday('now')))
  ) THEN RAISE(ABORT, 'snapshot manifest object must exist') END;
END;

CREATE TRIGGER trg_log_snapshot_immutable
BEFORE UPDATE OF snapshot_id, task_uid, run_id, manifest_object_sha256, published_at, status
ON log_collection_snapshots
BEGIN
  SELECT RAISE(ABORT, 'snapshot identity is immutable');
END;

CREATE TRIGGER trg_log_snapshot_retention_transition
BEFORE UPDATE OF retention_state, retired_at ON log_collection_snapshots
WHEN NEW.retention_state <> OLD.retention_state OR NEW.retired_at IS NOT OLD.retired_at
BEGIN
  SELECT CASE WHEN NOT (
    OLD.retention_state = 'retained'
    AND NEW.retention_state = 'expired'
    AND NEW.retired_at IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM log_collection_artifacts
      WHERE snapshot_id = OLD.snapshot_id AND retention_state = 'retained'
    )
  ) THEN RAISE(ABORT, 'invalid snapshot retention transition') END;
END;

CREATE TRIGGER trg_log_snapshot_no_physical_delete
BEFORE DELETE ON log_collection_snapshots
BEGIN
  SELECT RAISE(ABORT, 'snapshots are immutable history');
END;

CREATE TRIGGER trg_log_artifact_identity
BEFORE INSERT ON log_collection_artifacts
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM log_collection_snapshots s
    JOIN log_collection_observations o
      ON o.observation_id = NEW.observation_id
     AND o.task_uid = s.task_uid
     AND o.run_id = s.run_id
     AND o.remote_path = NEW.remote_path
    JOIN log_collection_objects obj ON obj.object_sha256 = NEW.object_sha256
    JOIN log_collection_runs r ON r.task_uid = s.task_uid AND r.run_id = s.run_id
    WHERE s.snapshot_id = NEW.snapshot_id
      AND r.status = 'publishing'
      AND s.retention_state = 'retained'
      AND (obj.state = 'published' OR (obj.state = 'staged' AND julianday(obj.publish_lease_until) > julianday('now')))
      AND obj.size_bytes = NEW.size_bytes
      AND obj.object_sha256 = NEW.content_sha256
      AND o.full_sha256 = NEW.content_sha256
      AND o.byte_size = NEW.size_bytes
  ) THEN RAISE(ABORT, 'artifact identity mismatch') END;
END;

CREATE TRIGGER trg_log_artifact_identity_immutable
BEFORE UPDATE OF artifact_id, snapshot_id, observation_id, remote_path,
  local_relative_path, size_bytes, content_sha256 ON log_collection_artifacts
BEGIN
  SELECT RAISE(ABORT, 'artifact identity is immutable');
END;

CREATE TRIGGER trg_log_artifact_retention_transition
BEFORE UPDATE OF retention_state, object_sha256, retired_at ON log_collection_artifacts
WHEN NEW.retention_state <> OLD.retention_state
  OR NEW.object_sha256 IS NOT OLD.object_sha256
  OR NEW.retired_at IS NOT OLD.retired_at
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM log_collection_snapshots s
    JOIN log_collection_runs r ON r.task_uid = s.task_uid AND r.run_id = s.run_id
    WHERE s.snapshot_id = OLD.snapshot_id
      AND r.status IN ('canceled','completed','partial','failed','needs_attention')
  ) THEN RAISE(ABORT, 'artifact retention requires a terminal run') END;
  SELECT CASE WHEN NOT (
    OLD.retention_state = 'retained'
    AND NEW.retention_state = 'expired'
    AND NEW.object_sha256 IS NULL
    AND NEW.retired_at IS NOT NULL
  ) THEN RAISE(ABORT, 'invalid artifact retention transition') END;
END;

CREATE TRIGGER trg_log_artifact_no_physical_delete
BEFORE DELETE ON log_collection_artifacts
BEGIN
  SELECT RAISE(ABORT, 'artifacts expire, never delete');
END;

-- Cursors advance only to newer completed baselines.
CREATE TRIGGER trg_log_cursor_insert_identity
BEFORE INSERT ON log_collection_cursors
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM log_collection_observations o
    JOIN log_collection_tasks t ON t.task_uid = o.task_uid
    JOIN log_collection_runs r ON r.task_uid = o.task_uid AND r.run_id = o.run_id
    WHERE o.observation_id = NEW.latest_observation_id
      AND o.task_uid = NEW.task_uid
      AND o.remote_path = NEW.remote_path
      AND t.tenant_key = NEW.tenant_key
      AND r.status = 'completed'
      AND r.published_snapshot_id IS NOT NULL
  ) THEN RAISE(ABORT, 'cursor identity mismatch') END;
END;

CREATE TRIGGER trg_log_cursor_update_identity
BEFORE UPDATE ON log_collection_cursors
BEGIN
  SELECT CASE WHEN NEW.tenant_key <> OLD.tenant_key
    OR NEW.task_uid <> OLD.task_uid
    OR NEW.remote_path <> OLD.remote_path
    OR NOT EXISTS (
      SELECT 1
      FROM log_collection_observations o
      JOIN log_collection_runs r ON r.task_uid = o.task_uid AND r.run_id = o.run_id
      JOIN log_collection_observations oldo ON oldo.observation_id = OLD.latest_observation_id
      JOIN log_collection_runs oldr ON oldr.task_uid = oldo.task_uid AND oldr.run_id = oldo.run_id
      WHERE o.observation_id = NEW.latest_observation_id
        AND o.task_uid = NEW.task_uid
        AND o.remote_path = NEW.remote_path
        AND r.status = 'completed'
        AND r.published_snapshot_id IS NOT NULL
        AND r.lease_fence > oldr.lease_fence
    )
  THEN RAISE(ABORT, 'cursor identity mismatch or regression') END;
END;

CREATE TRIGGER trg_log_cursor_no_physical_delete
BEFORE DELETE ON log_collection_cursors
BEGIN
  SELECT RAISE(ABORT, 'cursors are immutable identity; update in place');
END;

-- Leases remain as durable history. Only one active lease per task.
CREATE TRIGGER trg_log_lease_insert
BEFORE INSERT ON log_collection_leases
BEGIN
  SELECT CASE WHEN NEW.status <> 'active' THEN RAISE(ABORT, 'lease must be inserted active') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM log_collection_runs
    WHERE task_uid = NEW.task_uid AND run_id = NEW.run_id
      AND lease_fence = NEW.fence
      AND status NOT IN ('canceled','completed','partial','failed','needs_attention')
  ) THEN RAISE(ABORT, 'lease requires a non-terminal run at the same fence') END;
  SELECT CASE WHEN julianday(NEW.expires_at) <= julianday(NEW.updated_at)
    THEN RAISE(ABORT, 'lease must be live at creation') END;
END;

CREATE TRIGGER trg_log_lease_identity_immutable
BEFORE UPDATE OF task_uid, run_id, fence, owner_id ON log_collection_leases
BEGIN
  SELECT RAISE(ABORT, 'lease identity is immutable');
END;

CREATE TRIGGER trg_log_lease_transition
BEFORE UPDATE OF status ON log_collection_leases
WHEN NEW.status <> OLD.status
BEGIN
  SELECT CASE WHEN OLD.status <> 'active'
    OR NEW.status NOT IN ('released','expired','revoked')
  THEN RAISE(ABORT, 'invalid lease transition') END;
END;

CREATE TRIGGER trg_log_lease_no_physical_delete
BEFORE DELETE ON log_collection_leases
BEGIN
  SELECT RAISE(ABORT, 'leases are durable history');
END;

CREATE TRIGGER trg_log_lease_terminal_cleanup
AFTER UPDATE OF status ON log_collection_runs
WHEN NEW.status IN ('canceled','completed','partial','failed','needs_attention')
BEGIN
  UPDATE log_collection_leases
  SET status = 'released', released_at = NEW.finished_at, updated_at = NEW.finished_at
  WHERE task_uid = NEW.task_uid AND run_id = NEW.run_id
    AND fence = NEW.lease_fence AND status = 'active';
END;

CREATE TRIGGER trg_log_staging_identity
BEFORE INSERT ON log_collection_staging
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM log_collection_runs r
    WHERE r.task_uid = NEW.task_uid AND r.run_id = NEW.run_id
      AND r.lease_fence = NEW.lease_fence
      AND r.status NOT IN ('canceled','completed','partial','failed','needs_attention')
  ) THEN RAISE(ABORT, 'staging requires a non-terminal run') END;
END;

CREATE TRIGGER trg_log_staging_no_delete
BEFORE DELETE ON log_collection_staging
BEGIN
  SELECT RAISE(ABORT, 'staging rows retain cleanup history');
END;

-- Audit and migration append-only state.
CREATE TRIGGER trg_log_audit_immutable
BEFORE UPDATE ON log_collection_audit
BEGIN
  SELECT RAISE(ABORT, 'audit rows are immutable');
END;

CREATE TRIGGER trg_log_audit_no_physical_delete
BEFORE DELETE ON log_collection_audit
BEGIN
  SELECT RAISE(ABORT, 'audit rows are immutable');
END;

CREATE TRIGGER trg_log_migration_transition
BEFORE UPDATE OF status ON log_collection_migrations
WHEN NEW.status <> OLD.status
BEGIN
  SELECT CASE WHEN OLD.status IN ('completed','failed')
    THEN RAISE(ABORT, 'terminal migration cannot transition') END;
  SELECT CASE WHEN NOT (
    (OLD.status = 'pending' AND NEW.status IN ('running','failed')) OR
    (OLD.status = 'running' AND NEW.status IN ('completed','failed'))
  ) THEN RAISE(ABORT, 'invalid migration transition') END;
END;

CREATE TRIGGER trg_log_migration_completed_items
BEFORE UPDATE OF status ON log_collection_migrations
WHEN NEW.status = 'completed' AND NEW.status <> OLD.status
BEGIN
  SELECT CASE WHEN (
    SELECT count(*) FROM log_collection_migration_items
    WHERE migration_id = NEW.migration_id AND required = 1
  ) <> NEW.required_item_count THEN RAISE(ABORT, 'required migration item count mismatch') END;
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM log_collection_migration_items
    WHERE migration_id = NEW.migration_id
      AND required = 1
      AND status <> 'completed'
  ) THEN RAISE(ABORT, 'required migration item is not completed') END;
END;

CREATE TRIGGER trg_log_migration_terminal_immutable
BEFORE UPDATE ON log_collection_migrations
WHEN OLD.status IN ('completed','failed')
BEGIN
  SELECT RAISE(ABORT, 'terminal migration row is immutable');
END;

CREATE TRIGGER trg_log_migration_no_physical_delete
BEFORE DELETE ON log_collection_migrations
BEGIN
  SELECT RAISE(ABORT, 'migration rows are immutable history');
END;

CREATE TRIGGER trg_log_migration_item_identity_immutable
BEFORE UPDATE OF migration_id, source_item_id, target_kind, required ON log_collection_migration_items
BEGIN
  SELECT RAISE(ABORT, 'migration item identity is immutable');
END;

CREATE TRIGGER trg_log_migration_item_no_physical_delete
BEFORE DELETE ON log_collection_migration_items
BEGIN
  SELECT RAISE(ABORT, 'migration item rows are immutable history');
END;


-- R5 closure triggers.
CREATE TRIGGER trg_control_meta_no_delete
BEFORE DELETE ON control_store_meta
BEGIN
  SELECT RAISE(ABORT, 'control store meta is immutable');
END;

CREATE TRIGGER trg_control_meta_no_reinsert
BEFORE INSERT ON control_store_meta
WHEN EXISTS (SELECT 1 FROM control_store_meta)
BEGIN
  SELECT RAISE(ABORT, 'control store meta already exists');
END;

CREATE TRIGGER trg_log_run_heartbeat_monotonic
BEFORE UPDATE OF heartbeat_at ON log_collection_runs
WHEN NEW.heartbeat_at < OLD.heartbeat_at
BEGIN
  SELECT RAISE(ABORT, 'run heartbeat cannot move backwards');
END;

CREATE TRIGGER trg_log_lease_expiry_immutable
BEFORE UPDATE OF expires_at ON log_collection_leases
BEGIN
  SELECT RAISE(ABORT, 'lease expiry is immutable; take a new fence');
END;

CREATE TRIGGER trg_log_occurrence_claim_immutable
BEFORE UPDATE OF claimed_by, claim_fence, claim_expires_at ON workflow_occurrences
WHEN OLD.claimed_by IS NOT NULL AND (
  NEW.claimed_by IS NOT OLD.claimed_by
  OR NEW.claim_fence IS NOT OLD.claim_fence
  OR NEW.claim_expires_at IS NOT OLD.claim_expires_at
) AND NOT (
  OLD.status = 'claimed'
  AND NEW.status = 'claimed'
  AND NEW.claim_fence > OLD.claim_fence
  AND julianday(OLD.claim_expires_at) <= julianday('now')
  AND julianday(NEW.claim_expires_at) > julianday('now')
)
BEGIN
  SELECT RAISE(ABORT, 'occurrence claim change requires an expired lower-fence claim');
END;

CREATE TRIGGER trg_workflow_attempt_requires_current_claim
BEFORE UPDATE OF status ON workflow_attempts
WHEN NEW.status <> OLD.status AND NEW.status IN ('running','succeeded')
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM workflow_occurrences o
    WHERE o.occurrence_id = NEW.occurrence_id
      AND o.claimed_by = NEW.owner_id
      AND o.claim_fence = NEW.attempt_fence
      AND o.status IN ('claimed','running')
      AND julianday(o.claim_expires_at) > julianday('now')
      AND julianday(NEW.claim_expires_at) > julianday('now')
  ) THEN RAISE(ABORT, 'attempt does not match current occurrence claim') END;
END;

CREATE TRIGGER trg_workflow_occurrence_link_no_update
BEFORE UPDATE ON workflow_occurrence_log_tasks
BEGIN
  SELECT RAISE(ABORT, 'occurrence task links are immutable');
END;

CREATE TRIGGER trg_workflow_occurrence_link_no_delete
BEFORE DELETE ON workflow_occurrence_log_tasks
BEGIN
  SELECT RAISE(ABORT, 'occurrence task links are immutable');
END;

CREATE TRIGGER trg_log_acl_revoke_irreversible
BEFORE UPDATE OF revoked_at, revoked_by ON log_collection_task_acl
WHEN OLD.revoked_at IS NOT NULL AND (NEW.revoked_at IS NULL OR NEW.revoked_by IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'ACL revocation is irreversible; grant a new row generation');
END;

CREATE TRIGGER trg_workflow_schedule_content_cas
BEFORE UPDATE OF workflow_id, name, cron, time_zone, input_template_json, enabled ON workflow_schedules
WHEN NEW.revision <= OLD.revision
BEGIN
  SELECT RAISE(ABORT, 'schedule content update requires a higher revision');
END;

CREATE TRIGGER trg_log_task_latest_pointer_monotonic
BEFORE UPDATE OF latest_published_run_id ON log_collection_tasks
WHEN OLD.latest_published_run_id IS NOT NULL
BEGIN
  SELECT CASE WHEN NEW.latest_published_run_id IS NULL THEN RAISE(ABORT, 'latest published run cannot be cleared') END;
  SELECT CASE WHEN (
    SELECT lease_fence FROM log_collection_runs WHERE run_id = NEW.latest_published_run_id AND task_uid = NEW.task_uid
  ) <= (
    SELECT lease_fence FROM log_collection_runs WHERE run_id = OLD.latest_published_run_id AND task_uid = OLD.task_uid
  ) THEN RAISE(ABORT, 'latest published run cannot move backwards') END;
END;

CREATE TRIGGER trg_log_migration_insert_pending
BEFORE INSERT ON log_collection_migrations
WHEN NEW.status <> 'pending'
BEGIN
  SELECT RAISE(ABORT, 'migration must be inserted pending');
END;

CREATE TRIGGER trg_log_migration_item_parent_active
BEFORE INSERT ON log_collection_migration_items
WHEN NOT EXISTS (
  SELECT 1 FROM log_collection_migrations m
  WHERE m.migration_id = NEW.migration_id AND m.status IN ('pending','running')
)
BEGIN
  SELECT RAISE(ABORT, 'migration item requires an active parent');
END;

CREATE TRIGGER trg_log_migration_item_parent_frozen
BEFORE UPDATE ON log_collection_migration_items
WHEN EXISTS (
  SELECT 1 FROM log_collection_migrations m
  WHERE m.migration_id = OLD.migration_id AND m.status IN ('completed','failed')
)
BEGIN
  SELECT RAISE(ABORT, 'migration item is frozen after terminal parent');
END;


CREATE TRIGGER trg_workflow_attempt_expiry_immutable
BEFORE UPDATE OF claim_expires_at ON workflow_attempts
BEGIN
  SELECT RAISE(ABORT, 'attempt expiry is immutable; take a new fence');
END;

CREATE TRIGGER trg_workflow_attempt_heartbeat_monotonic
BEFORE UPDATE OF heartbeat_at ON workflow_attempts
WHEN NEW.heartbeat_at < OLD.heartbeat_at
BEGIN
  SELECT RAISE(ABORT, 'attempt heartbeat cannot move backwards');
END;


CREATE TRIGGER trg_workflow_attempt_takeover_cleanup
AFTER UPDATE OF claimed_by, claim_fence, claim_expires_at ON workflow_occurrences
WHEN OLD.status = 'claimed' AND NEW.status = 'claimed' AND NEW.claim_fence > OLD.claim_fence
BEGIN
  UPDATE workflow_attempts
  SET status = 'failed',
      finished_at = NEW.updated_at,
      error_code = 'WORKFLOW_ATTEMPT_TAKEOVER',
      error_detail = 'attempt superseded by a higher occurrence claim fence'
  WHERE occurrence_id = NEW.occurrence_id AND status IN ('claimed','running');
END;

CREATE TRIGGER trg_workflow_attempt_late_write
BEFORE UPDATE OF heartbeat_at, receipt_json ON workflow_attempts
WHEN OLD.status IN ('claimed','running') AND NEW.status = OLD.status
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM workflow_occurrences o
    WHERE o.occurrence_id = OLD.occurrence_id
      AND o.status IN ('claimed','running')
      AND o.claimed_by = OLD.owner_id
      AND o.claim_fence = OLD.attempt_fence
      AND julianday(o.claim_expires_at) > julianday('now')
      AND julianday(OLD.claim_expires_at) > julianday('now')
  ) THEN RAISE(ABORT, 'stale attempt cannot write heartbeat or receipt') END;
END;


CREATE TRIGGER trg_log_acl_generation_monotonic
BEFORE INSERT ON log_collection_task_acl
WHEN EXISTS (
  SELECT 1 FROM log_collection_task_acl a
  WHERE a.task_uid = NEW.task_uid
    AND a.agent_preset = NEW.agent_preset
    AND a.generation >= NEW.generation
)
BEGIN
  SELECT RAISE(ABORT, 'ACL generation must increase');
END;

CREATE TRIGGER trg_workflow_attempt_terminal_receipt_guard
BEFORE UPDATE OF status ON workflow_attempts
WHEN NEW.status IN ('failed','canceled','needs_attention')
  AND NEW.status <> OLD.status
  AND NEW.receipt_json IS NOT NULL
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM workflow_occurrences o
    WHERE o.occurrence_id = OLD.occurrence_id
      AND o.claimed_by = OLD.owner_id
      AND o.claim_fence = OLD.attempt_fence
      AND o.status IN ('claimed','running')
      AND julianday(o.claim_expires_at) > julianday('now')
      AND julianday(OLD.claim_expires_at) > julianday('now')
  ) THEN RAISE(ABORT, 'stale attempt cannot write receipt') END;
END;

COMMIT;
