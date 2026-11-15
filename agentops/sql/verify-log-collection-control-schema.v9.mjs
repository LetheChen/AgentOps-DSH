import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const schema = readFileSync(new URL('./log-collection-control.schema.v9.sql', import.meta.url), 'utf8');
const remotePath = '/opt/AI_Agent_Platform/logs/app/oa_audit.log';
const remotePaths = JSON.stringify([remotePath]);
const hash64 = (ch) => ch.repeat(64);

function createDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(schema);
  return db;
}

function seedTask(db, { uid = 'task-a', tenant = 'tenant-a', taskId = 'oa_approval', enabled = 1 } = {}) {
  const normalized = taskId.toLowerCase();
  db.prepare(`INSERT INTO log_collection_tasks(
    task_uid, tenant_key, task_id, task_id_normalized, name, owner_domain,
    ssh_instance_id, remote_paths_json, storage_key, local_max_days, enabled,
    revision, next_lease_fence, created_by, updated_by, created_at, updated_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    uid, tenant, taskId, normalized, 'OA audit', 'smart_approval', 'MaxKB',
    remotePaths, `${tenant}/${normalized}`, 7, enabled, 1, 1,
    'fixture', 'fixture', '2026-11-13T00:00:00Z', '2026-11-13T00:00:00Z',
  );
}

function taskRow(db, uid = 'task-a') {
  return db.prepare('SELECT * FROM log_collection_tasks WHERE task_uid=?').get(uid);
}

function insertQueuedRun(db, { uid = 'task-a', runId = 'run-a', fence = 1, taskRevision = null } = {}) {
  const task = taskRow(db, uid);
  db.prepare('UPDATE log_collection_tasks SET next_lease_fence=? WHERE task_uid=?').run(fence + 1, uid);
  db.prepare(`INSERT INTO log_collection_runs(
    run_id, request_id, task_uid, task_revision, lease_fence, task_name,
    owner_domain, remote_paths_json, storage_key, local_max_days, ssh_instance_id,
    ssh_instance_digest, credential_generation, trigger_kind, status,
    started_at, heartbeat_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    runId, `request-${runId}`, uid, taskRevision ?? task.revision, fence, task.name,
    task.owner_domain, task.remote_paths_json, task.storage_key, task.local_max_days,
    task.ssh_instance_id, 'digest-1', 'generation-1', 'manual', 'queued',
    '2026-11-13T00:00:00Z', '2026-11-13T00:00:00Z',
  );
  db.prepare(`INSERT INTO log_collection_leases(
    task_uid, run_id, fence, owner_id, status, expires_at, updated_at
  ) VALUES (?,?,?,?,?,?,?)`).run(
    uid, runId, fence, 'worker-a', 'active', '2099-01-01T00:00:00Z', '2026-11-13T00:00:00Z',
  );
  return { uid, runId, fence, status: 'queued' };
}

function advance(db, run, target) {
  const path = ['queued', 'connecting', 'listing', 'copying', 'publishing'];
  const current = path.indexOf(run.status);
  const wanted = path.indexOf(target);
  for (let i = current + 1; i <= wanted; i += 1) {
    db.prepare('UPDATE log_collection_runs SET status=?, heartbeat_at=? WHERE run_id=?')
      .run(path[i], '2026-11-13T00:00:00Z', run.runId);
  }
  run.status = target;
}

function addObject(db, hex, size = 100) {
  const hash = hash64(hex);
  db.prepare(`INSERT INTO log_collection_objects(
    object_sha256, relative_path, size_bytes, state, publish_token, publish_lease_until, created_at, updated_at
  ) VALUES (?,?,?,?,?,?,?,?)`).run(
    hash, `${hash.slice(0, 2)}/${hash}`, size, 'staged', `token-${hex}`,
    '2099-01-01T00:00:00Z', '2026-11-13T00:00:00Z', '2026-11-13T00:00:00Z',
  );
  return hash;
}

function addObservation(db, run, {
  observationId = 'obs-a', hash = 'b', byteSize = 100, continuity = 'initial',
  priorObservationId = null, priorSize = 0,
} = {}) {
  db.prepare(`INSERT INTO log_collection_observations(
    observation_id, task_uid, run_id, remote_path, prior_observation_id,
    identity_kind, identity_json, byte_size, prior_size, prefix_sha256,
    full_sha256, continuity_state, gap_json, observed_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    observationId, run.uid, run.runId, remotePath, priorObservationId,
    'size_mtime_seconds', '{"mtime":1}', byteSize, priorSize,
    hash64(hash), hash64(hash), continuity, '[]', '2026-11-13T00:00:00Z',
  );
}

function publish(db, run, { status = 'completed', snapshotId = 'snap-a', manifestHex = 'a', contentHex = 'b' } = {}) {
  advance(db, run, 'publishing');
  const manifest = addObject(db, manifestHex, 10);
  const content = addObject(db, contentHex, 100);
  addObservation(db, run, { observationId: `obs-${run.runId}`, hash: contentHex, byteSize: 100 });
  db.prepare(`INSERT INTO log_collection_snapshots(
    snapshot_id, task_uid, run_id, manifest_object_sha256, published_at, status
  ) VALUES (?,?,?,?,?,?)`).run(
    snapshotId, run.uid, run.runId, manifest, '2026-11-13T00:00:00Z',
    status === 'completed' ? 'complete' : 'partial',
  );
  db.prepare(`INSERT INTO log_collection_artifacts(
    artifact_id, snapshot_id, observation_id, remote_path, object_sha256,
    local_relative_path, size_bytes, content_sha256
  ) VALUES (?,?,?,?,?,?,?,?)`).run(
    `art-${run.runId}`, snapshotId, `obs-${run.runId}`, remotePath, content,
    'oa_audit.log', 100, content,
  );
  db.prepare(`UPDATE log_collection_objects SET state='published', updated_at=?
    WHERE object_sha256 IN (?,?)`).run('2026-11-13T00:00:01Z', manifest, content);
  db.prepare('UPDATE log_collection_runs SET published_snapshot_id=? WHERE run_id=?').run(snapshotId, run.runId);
  db.prepare(`UPDATE log_collection_runs
    SET status=?, finished_at=?, heartbeat_at=?, receipt_json=? WHERE run_id=?`).run(
    status, '2026-11-13T00:00:02Z', '2026-11-13T00:00:02Z', '{"ok":true}', run.runId,
  );
  db.prepare('UPDATE log_collection_tasks SET latest_published_run_id=? WHERE task_uid=?').run(run.runId, run.uid);
  if (status === 'completed') {
    db.prepare(`INSERT INTO log_collection_cursors(
      tenant_key, task_uid, remote_path, latest_observation_id, updated_at
    ) VALUES (?,?,?,?,?)
    ON CONFLICT(tenant_key, task_uid, remote_path) DO UPDATE SET
      latest_observation_id=excluded.latest_observation_id, updated_at=excluded.updated_at`).run(
      taskRow(db, run.uid).tenant_key, run.uid, remotePath, `obs-${run.runId}`, '2026-11-13T00:00:02Z',
    );
  }
  run.status = status;
}

function seedSchedule(db, { template = '{}' } = {}) {
  db.prepare(`INSERT INTO workflow_schedules(
    schedule_id, tenant_key, workflow_id, name, cron, time_zone, input_template_json,
    enabled, revision, created_at, updated_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
    'schedule-a', 'tenant-a', 'log-pull', 'hourly', '0 * * * *', 'Asia/Shanghai',
    template, 1, 1, '2026-11-13T00:00:00Z', '2026-11-13T00:00:00Z',
  );
  db.prepare(`INSERT INTO workflow_schedule_log_tasks(schedule_id, task_uid, input_key, created_at)
    VALUES (?,?,?,?)`).run('schedule-a', 'task-a', 'log_task_id', '2026-11-13T00:00:00Z');
}

function seedOccurrence(db, { occ = 'occ-a', template = '{}', inputs = '{"log_task_id":"oa_approval"}' } = {}) {
  db.prepare(`INSERT INTO workflow_occurrences(
    occurrence_id, schedule_id, tenant_key, scheduled_for, schedule_revision,
    input_template_json, input_template_sha256, inputs_json, inputs_sha256,
    status, updated_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
    occ, 'schedule-a', 'tenant-a', '2026-11-13T00:00:00Z', 1,
    template, hash64('c'), inputs, hash64('d'), 'pending', '2026-11-13T00:00:00Z',
  );
  db.prepare(`INSERT INTO workflow_occurrence_log_tasks(occurrence_id, task_uid, task_id, input_key)
    VALUES (?,?,?,?)`).run(occ, 'task-a', 'oa_approval', 'log_task_id');
}

const results = [];
function expectOk(name, fn) {
  try { const detail = fn() ?? ''; results.push({ name, outcome: 'PASS', detail: String(detail) }); }
  catch (error) { results.push({ name, outcome: 'UNEXPECTED_FAIL', detail: error.message }); }
}
function expectFail(name, fn, pattern) {
  try { fn(); results.push({ name, outcome: 'UNEXPECTED_OK', detail: 'operation succeeded' }); }
  catch (error) {
    results.push({ name, outcome: !pattern || pattern.test(error.message) ? 'PASS' : 'WRONG_ERROR', detail: error.message });
  }
}

expectOk('schema creates atomically with foreign keys', () => {
  const db = createDb();
  const stats = {
    fk: db.prepare('PRAGMA foreign_keys').get().foreign_keys,
    businessTables: db.prepare("SELECT count(*) n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").get().n,
    triggers: db.prepare("SELECT count(*) n FROM sqlite_master WHERE type='trigger'").get().n,
    integrity: db.prepare('PRAGMA integrity_check').get().integrity_check,
  };
  if (stats.fk !== 1 || stats.integrity !== 'ok' || stats.businessTables !== 19 || stats.triggers !== 91) throw new Error(JSON.stringify(stats));
  return JSON.stringify(stats);
});

expectOk('complete publish flow and cursor', () => {
  const db = createDb();
  seedTask(db);
  const run = insertQueuedRun(db);
  publish(db, run);
  const cursor = db.prepare('SELECT latest_observation_id FROM log_collection_cursors').get();
  const lease = db.prepare('SELECT status FROM log_collection_leases WHERE run_id=?').get(run.runId);
  if (!cursor || lease.status !== 'released') throw new Error('cursor or lease state missing');
  return `cursor=${cursor.latest_observation_id} lease=${lease.status}`;
});

expectFail('direct completed run insert rejected', () => {
  const db = createDb();
  seedTask(db);
  db.prepare('UPDATE log_collection_tasks SET next_lease_fence=2 WHERE task_uid=?').run('task-a');
  const task = taskRow(db);
  db.prepare(`INSERT INTO log_collection_runs(
    run_id, request_id, task_uid, task_revision, lease_fence, task_name, owner_domain,
    remote_paths_json, storage_key, local_max_days, ssh_instance_id, ssh_instance_digest,
    credential_generation, trigger_kind, status, published_snapshot_id, finished_at,
    heartbeat_at, receipt_json
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    'run-ghost', 'req-ghost', 'task-a', 1, 1, task.name, task.owner_domain,
    task.remote_paths_json, task.storage_key, 7, task.ssh_instance_id, 'digest-1',
    'generation-1', 'manual', 'completed', 'snap-ghost', '2026-11-13T00:00:02Z',
    '2026-11-13T00:00:02Z', '{}',
  );
}, /run must be inserted queued/);

expectFail('terminal run cannot reopen', () => {
  const db = createDb();
  seedTask(db);
  const run = insertQueuedRun(db);
  publish(db, run);
  db.prepare('UPDATE log_collection_runs SET status=? WHERE run_id=?').run('copying', run.runId);
}, /terminal run is immutable|terminal run cannot transition/);

expectFail('expired lease cannot advance run', () => {
  const db = createDb();
  seedTask(db);
  const run = insertQueuedRun(db);
  db.prepare("UPDATE log_collection_leases SET expires_at='2000-01-01T00:00:00Z' WHERE run_id=?").run(run.runId);
  db.prepare('UPDATE log_collection_runs SET status=?, heartbeat_at=? WHERE run_id=?')
    .run('connecting', '2026-11-13T00:00:00Z', run.runId);
}, /live lease|expiry is immutable/);

expectFail('lease physical delete rejected', () => {
  const db = createDb();
  seedTask(db);
  const run = insertQueuedRun(db);
  db.prepare('DELETE FROM log_collection_leases WHERE run_id=?').run(run.runId);
}, /durable history/);

expectFail('schedule link update rejected', () => {
  const db = createDb();
  seedTask(db);
  seedSchedule(db);
  db.prepare("UPDATE workflow_schedule_log_tasks SET task_uid='task-b' WHERE schedule_id='schedule-a'").run();
}, /immutable|live enabled task/);

expectFail('occurrence frozen inputs cannot be mutated', () => {
  const db = createDb();
  seedTask(db);
  seedSchedule(db);
  seedOccurrence(db);
  db.prepare("UPDATE workflow_occurrences SET inputs_json='{\"log_task_id\":\"tampered\"}' WHERE occurrence_id='occ-a'").run();
}, /frozen inputs are immutable/);

expectFail('occurrence cannot be inserted running', () => {
  const db = createDb();
  seedTask(db);
  seedSchedule(db);
  db.prepare(`INSERT INTO workflow_occurrences(
    occurrence_id, schedule_id, tenant_key, scheduled_for, schedule_revision,
    input_template_json, input_template_sha256, inputs_json, inputs_sha256,
    status, claimed_by, claim_fence, claim_expires_at, updated_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    'occ-run', 'schedule-a', 'tenant-a', '2026-11-13T00:00:00Z', 1,
    '{}', hash64('c'), '{"log_task_id":"oa_approval"}', hash64('d'),
    'running', 'worker', 1, '2099-01-01T00:00:00Z', '2026-11-13T00:00:00Z',
  );
}, /inserted pending/);

expectFail('occurrence extra input rejected', () => {
  const db = createDb();
  seedTask(db);
  seedSchedule(db);
  seedOccurrence(db, { inputs: '{"log_task_id":"oa_approval","host":"evil"}' });
}, /missing or extra keys/);

expectFail('pending occurrence cannot create attempt', () => {
  const db = createDb();
  seedTask(db);
  seedSchedule(db);
  seedOccurrence(db);
  db.prepare(`INSERT INTO workflow_attempts(
    attempt_id, occurrence_id, attempt_no, attempt_fence, owner_id, workflow_run_id,
    status, claim_expires_at, heartbeat_at, started_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
    'attempt-a', 'occ-a', 1, 1, 'worker-a', 'workflow-run-a',
    'claimed', '2099-01-01T00:00:00Z', '2026-11-13T00:00:00Z', '2026-11-13T00:00:00Z',
  );
}, /live occurrence claim/);

expectOk('workflow occurrence claim and attempt succeed', () => {
  const db = createDb();
  seedTask(db);
  seedSchedule(db);
  seedOccurrence(db);
  db.prepare(`UPDATE workflow_occurrences
    SET status='claimed', claimed_by='worker-a', claim_fence=1,
        claim_expires_at='2099-01-01T00:00:00Z', updated_at='2026-11-13T00:00:00Z'
    WHERE occurrence_id='occ-a'`).run();
  db.prepare(`INSERT INTO workflow_attempts(
    attempt_id, occurrence_id, attempt_no, attempt_fence, owner_id, workflow_run_id,
    status, claim_expires_at, heartbeat_at, started_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
    'attempt-a', 'occ-a', 1, 1, 'worker-a', 'workflow-run-a',
    'claimed', '2099-01-01T00:00:00Z', '2026-11-13T00:00:00Z', '2026-11-13T00:00:00Z',
  );
  db.prepare("UPDATE workflow_occurrences SET status='running' WHERE occurrence_id='occ-a'").run();
  return 'occurrence=running attempt=claimed';
});

expectFail('artifact traversal rejected', () => {
  const db = createDb();
  seedTask(db);
  const run = insertQueuedRun(db);
  advance(db, run, 'publishing');
  const manifest = addObject(db, 'a', 10);
  const content = addObject(db, 'b', 100);
  addObservation(db, run, { observationId: 'obs-a', hash: 'b', byteSize: 100 });
  db.prepare(`INSERT INTO log_collection_snapshots(
    snapshot_id, task_uid, run_id, manifest_object_sha256, published_at, status
  ) VALUES (?,?,?,?,?,?)`).run('snap-a', run.uid, run.runId, manifest, '2026-11-13T00:00:00Z', 'complete');
  db.prepare(`INSERT INTO log_collection_artifacts(
    artifact_id, snapshot_id, observation_id, remote_path, object_sha256,
    local_relative_path, size_bytes, content_sha256
  ) VALUES (?,?,?,?,?,?,?,?)`).run(
    'art-a', 'snap-a', 'obs-a', remotePath, content, '../../escape.log', 100, content,
  );
}, /CHECK constraint failed/);

expectFail('artifact hash or size mismatch rejected', () => {
  const db = createDb();
  seedTask(db);
  const run = insertQueuedRun(db);
  advance(db, run, 'publishing');
  const manifest = addObject(db, 'a', 10);
  const content = addObject(db, 'b', 100);
  addObservation(db, run, { observationId: 'obs-a', hash: 'b', byteSize: 100 });
  db.prepare(`INSERT INTO log_collection_snapshots(
    snapshot_id, task_uid, run_id, manifest_object_sha256, published_at, status
  ) VALUES (?,?,?,?,?,?)`).run('snap-a', run.uid, run.runId, manifest, '2026-11-13T00:00:00Z', 'complete');
  db.prepare(`INSERT INTO log_collection_artifacts(
    artifact_id, snapshot_id, observation_id, remote_path, object_sha256,
    local_relative_path, size_bytes, content_sha256
  ) VALUES (?,?,?,?,?,?,?,?)`).run(
    'art-a', 'snap-a', 'obs-a', remotePath, content, 'oa_audit.log', 200, content,
  );
}, /artifact identity mismatch|CHECK constraint failed/);

expectFail('artifact physical delete rejected', () => {
  const db = createDb();
  seedTask(db);
  const run = insertQueuedRun(db);
  publish(db, run);
  db.prepare('DELETE FROM log_collection_artifacts WHERE artifact_id=?').run(`art-${run.runId}`);
}, /expire, never delete/);

expectFail('expired snapshot cannot accept new artifact', () => {
  const db = createDb();
  seedTask(db);
  const run = insertQueuedRun(db);
  publish(db, run);
  db.prepare("UPDATE log_collection_artifacts SET retention_state='expired', object_sha256=NULL, retired_at='2026-11-20T00:00:00Z' WHERE snapshot_id='snap-a'").run();
  db.prepare("UPDATE log_collection_snapshots SET retention_state='expired', retired_at='2026-11-20T00:00:00Z' WHERE snapshot_id='snap-a'").run();
  const content = hash64('b');
  db.prepare(`INSERT INTO log_collection_artifacts(
    artifact_id, snapshot_id, observation_id, remote_path, object_sha256,
    local_relative_path, size_bytes, content_sha256
  ) VALUES (?,?,?,?,?,?,?,?)`).run(
    'art-late', 'snap-a', 'obs-run-a', remotePath, content, 'late.log', 100, content,
  );
}, /expired|artifact identity mismatch/);

expectFail('invalid remote path JSON rejected', () => {
  const db = createDb();
  seedTask(db);
  db.prepare('UPDATE log_collection_tasks SET remote_paths_json=? WHERE task_uid=?')
    .run(JSON.stringify(['/ok', '../escape']), 'task-a');
}, /invalid remote path/);

expectFail('uppercase tenant rejected', () => {
  const db = createDb();
  seedTask(db, { tenant: 'Tenant' });
}, /CHECK constraint failed/);

expectFail('Windows reserved tenant rejected', () => {
  const db = createDb();
  seedTask(db, { tenant: 'CON' });
}, /CHECK constraint failed/);

expectFail('task undelete rejected', () => {
  const db = createDb();
  seedTask(db);
  db.prepare('UPDATE log_collection_tasks SET enabled=0 WHERE task_uid=?').run('task-a');
  db.prepare("UPDATE log_collection_tasks SET deleted_at='2026-11-13T00:00:00Z', deleted_by='owner' WHERE task_uid='task-a'").run();
  db.prepare("UPDATE log_collection_tasks SET deleted_at=NULL, deleted_by=NULL, enabled=1 WHERE task_uid='task-a'").run();
}, /cannot be restored|CHECK constraint failed/);

expectFail('task latest pointer on insert rejected', () => {
  const db = createDb();
  db.prepare(`INSERT INTO log_collection_tasks(
    task_uid, tenant_key, task_id, task_id_normalized, name, owner_domain,
    ssh_instance_id, remote_paths_json, storage_key, local_max_days, enabled,
    revision, next_lease_fence, latest_published_run_id, created_by, updated_by, created_at, updated_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    'task-b', 'tenant-a', 'other', 'other', 'Other', 'smart_approval', 'MaxKB', remotePaths,
    'tenant-a/other', 7, 1, 1, 1, 'ghost-run', 'fixture', 'fixture',
    '2026-11-13T00:00:00Z', '2026-11-13T00:00:00Z',
  );
}, /latest pointer must start null|CHECK constraint failed/);

expectFail('schema version downgrade rejected', () => {
  const db = createDb();
  db.prepare('UPDATE control_store_meta SET schema_version=5 WHERE singleton=1').run();
  db.prepare('UPDATE control_store_meta SET schema_version=2 WHERE singleton=1').run();
}, /schema_version must increase/);

expectFail('gap observation cannot complete run', () => {
  const db = createDb();
  seedTask(db);
  const run = insertQueuedRun(db);
  advance(db, run, 'copying');
  addObservation(db, run, { continuity: 'gap', observationId: 'obs-gap' });
  advance(db, run, 'publishing');
  const manifest = addObject(db, 'a', 10);
  db.prepare(`INSERT INTO log_collection_snapshots(
    snapshot_id, task_uid, run_id, manifest_object_sha256, published_at, status
  ) VALUES (?,?,?,?,?,?)`).run('snap-a', run.uid, run.runId, manifest, '2026-11-13T00:00:00Z', 'complete');
  const content = addObject(db, 'b', 100);
  db.prepare(`INSERT INTO log_collection_artifacts(artifact_id, snapshot_id, observation_id, remote_path, object_sha256, local_relative_path, size_bytes, content_sha256)
    VALUES (?,?,?,?,?,?,?,?)`).run('art-gap','snap-a','obs-gap',remotePath,content,'oa_audit.log',100,content);
  db.prepare("UPDATE log_collection_objects SET state='published', updated_at='2026-11-13T00:00:01Z' WHERE object_sha256 IN (?,?)").run(manifest,content);
  db.prepare('UPDATE log_collection_runs SET published_snapshot_id=? WHERE run_id=?').run('snap-a', run.runId);
  db.prepare(`UPDATE log_collection_runs SET status='completed', finished_at=?, receipt_json='{}' WHERE run_id=?`)
    .run('2026-11-13T00:00:02Z', run.runId);
}, /unproved continuity/);

expectFail('proved cannot use non-cursor stale baseline', () => {
  const db = createDb();
  seedTask(db);
  const run1 = insertQueuedRun(db, { runId: 'run-1', fence: 1 });
  publish(db, run1);
  const run2 = insertQueuedRun(db, { runId: 'run-2', fence: 2 });
  publish(db, run2, { snapshotId: 'snap-2', manifestHex: 'c', contentHex: 'd' });
  const run3 = insertQueuedRun(db, { runId: 'run-3', fence: 3 });
  advance(db, run3, 'copying');
  addObservation(db, run3, {
    observationId: 'obs-3', continuity: 'proved', priorObservationId: 'obs-run-1',
    priorSize: 100, byteSize: 120, hash: 'b',
  });
}, /latest completed cursor baseline/);

expectOk('retention expires artifact before snapshot', () => {
  const db = createDb();
  seedTask(db);
  const run = insertQueuedRun(db);
  publish(db, run);
  db.prepare("UPDATE log_collection_artifacts SET retention_state='expired', object_sha256=NULL, retired_at='2026-11-20T00:00:00Z' WHERE snapshot_id='snap-a'").run();
  db.prepare("UPDATE log_collection_snapshots SET retention_state='expired', retired_at='2026-11-20T00:00:00Z' WHERE snapshot_id='snap-a'").run();
  return 'artifact_then_snapshot=expired';
});

expectFail('migration cannot complete with pending required item', () => {
  const db = createDb();
  db.prepare(`INSERT INTO log_collection_migrations(
    migration_id, status, required_item_count, source_hashes_json, details_json, started_at, updated_at
  ) VALUES (?,?,?,?,?,?,?)`).run(
    'mig-1', 'pending', 1, '{"audit":"x"}', '{}', '2026-11-13T00:00:00Z', '2026-11-13T00:00:00Z',
  );
  db.prepare(`INSERT INTO log_collection_migration_items(
    migration_id, source_item_id, target_kind, required, status, updated_at
  ) VALUES (?,?,?,?,?,?)`).run(
    'mig-1', 'ssh:MaxKB', 'credential', 1, 'pending', '2026-11-13T00:00:00Z',
  );
  db.prepare("UPDATE log_collection_migrations SET status='running' WHERE migration_id='mig-1'").run();
  db.prepare("UPDATE log_collection_migrations SET status='completed', completed_at='2026-11-13T00:00:01Z' WHERE migration_id='mig-1'").run();
}, /required migration item is not completed/);

expectFail('lease expiry cannot be rewritten', () => {
  const db = createDb();
  seedTask(db);
  const run = insertQueuedRun(db);
  db.prepare("UPDATE log_collection_leases SET expires_at='2099-01-01T00:00:00Z' WHERE run_id=?").run(run.runId);
}, /expiry is immutable/);

expectFail('occurrence claim fields cannot be rewritten', () => {
  const db = createDb();
  seedTask(db);
  seedSchedule(db);
  seedOccurrence(db);
  db.prepare("UPDATE workflow_occurrences SET status='claimed', claimed_by='worker-a', claim_fence=1, claim_expires_at='2099-01-01T00:00:00Z' WHERE occurrence_id='occ-a'").run();
  db.prepare("UPDATE workflow_occurrences SET claimed_by='worker-b' WHERE occurrence_id='occ-a'").run();
}, /claim change requires|expired lower-fence/);

expectFail('occurrence task link cannot be updated', () => {
  const db = createDb();
  seedTask(db);
  seedSchedule(db);
  seedOccurrence(db);
  db.prepare("UPDATE workflow_occurrence_log_tasks SET task_uid='task-b' WHERE occurrence_id='occ-a'").run();
}, /links are immutable/);

expectFail('occurrence task link cannot be deleted', () => {
  const db = createDb();
  seedTask(db);
  seedSchedule(db);
  seedOccurrence(db);
  db.prepare("DELETE FROM workflow_occurrence_log_tasks WHERE occurrence_id='occ-a'").run();
}, /links are immutable/);

expectFail('control meta cannot be deleted', () => {
  const db = createDb();
  db.prepare('DELETE FROM control_store_meta WHERE singleton=1').run();
}, /meta is immutable/);

expectFail('schedule tenant reserved name rejected', () => {
  const db = createDb();
  seedTask(db);
  db.prepare(`INSERT INTO workflow_schedules(
    schedule_id, tenant_key, workflow_id, name, cron, time_zone, input_template_json,
    enabled, revision, created_at, updated_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
    'schedule-con', 'con', 'log-pull', 'hourly', '0 * * * *', 'Asia/Shanghai',
    '{}', 1, 1, '2026-11-13T00:00:00Z', '2026-11-13T00:00:00Z',
  );
}, /CHECK constraint failed/);

expectFail('malformed scheduled_for rejected', () => {
  const db = createDb();
  seedTask(db);
  seedSchedule(db);
  db.prepare(`INSERT INTO workflow_occurrences(
    occurrence_id, schedule_id, tenant_key, scheduled_for, schedule_revision,
    input_template_json, input_template_sha256, inputs_json, inputs_sha256,
    status, updated_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
    'occ-bad', 'schedule-a', 'tenant-a', 'not-a-time', 1,
    '{}', hash64('c'), '{"log_task_id":"oa_approval"}', hash64('d'),
    'pending', '2026-11-13T00:00:00Z',
  );
}, /CHECK constraint failed/);

expectFail('direct completed migration insert rejected', () => {
  const db = createDb();
  db.prepare(`INSERT INTO log_collection_migrations(
    migration_id, status, required_item_count, source_hashes_json, details_json, started_at, completed_at, updated_at
  ) VALUES (?,?,?,?,?,?,?,?)`).run(
    'mig-bad', 'completed', 1, '{}', '{}', '2026-11-13T00:00:00Z',
    '2026-11-13T00:00:01Z', '2026-11-13T00:00:01Z',
  );
}, /inserted pending/);

expectFail('completed snapshot cannot accept late artifact', () => {
  const db = createDb();
  seedTask(db);
  const run = insertQueuedRun(db);
  publish(db, run);
  const content = hash64('b');
  db.prepare(`INSERT INTO log_collection_artifacts(
    artifact_id, snapshot_id, observation_id, remote_path, object_sha256,
    local_relative_path, size_bytes, content_sha256
  ) VALUES (?,?,?,?,?,?,?,?)`).run(
    'art-late', 'snap-a', 'obs-run-a', remotePath, content, 'late.log', 100, content,
  );
}, /artifact identity mismatch/);

expectFail('attempt expiry cannot be rewritten', () => {
  const db = createDb();
  seedTask(db); seedSchedule(db); seedOccurrence(db);
  db.prepare("UPDATE workflow_occurrences SET status='claimed', claimed_by='worker-a', claim_fence=1, claim_expires_at='2099-01-01T00:00:00Z' WHERE occurrence_id='occ-a'").run();
  db.prepare(`INSERT INTO workflow_attempts(
    attempt_id, occurrence_id, attempt_no, attempt_fence, owner_id, workflow_run_id,
    status, claim_expires_at, heartbeat_at, started_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?)`).run('attempt-a','occ-a',1,1,'worker-a','workflow-run-a','claimed','2099-01-01T00:00:00Z','2026-11-13T00:00:00Z','2026-11-13T00:00:00Z');
  db.prepare("UPDATE workflow_attempts SET claim_expires_at='2099-02-01T00:00:00Z' WHERE attempt_id='attempt-a'").run();
}, /expiry is immutable/);

expectFail('attempt heartbeat cannot move backwards', () => {
  const db = createDb();
  seedTask(db); seedSchedule(db); seedOccurrence(db);
  db.prepare("UPDATE workflow_occurrences SET status='claimed', claimed_by='worker-a', claim_fence=1, claim_expires_at='2099-01-01T00:00:00Z' WHERE occurrence_id='occ-a'").run();
  db.prepare(`INSERT INTO workflow_attempts(
    attempt_id, occurrence_id, attempt_no, attempt_fence, owner_id, workflow_run_id,
    status, claim_expires_at, heartbeat_at, started_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?)`).run('attempt-a','occ-a',1,1,'worker-a','workflow-run-a','claimed','2099-01-01T00:00:00Z','2026-11-13T00:00:01Z','2026-11-13T00:00:00Z');
  db.prepare("UPDATE workflow_attempts SET heartbeat_at='2026-11-13T00:00:00Z' WHERE attempt_id='attempt-a'").run();
}, /heartbeat cannot move backwards/);

expectFail('expired object publish lease cannot be extended', () => {
  const db = createDb();
  addObject(db, 'a', 10);
  db.prepare("UPDATE log_collection_objects SET publish_lease_until='2099-01-01T00:00:00Z' WHERE object_sha256=?").run(hash64('a'));
}, /object identity is immutable/);

expectFail('latest published run cannot be cleared', () => {
  const db = createDb();
  seedTask(db);
  const run = insertQueuedRun(db);
  publish(db, run);
  db.prepare('UPDATE log_collection_tasks SET latest_published_run_id=NULL WHERE task_uid=?').run('task-a');
}, /cannot be cleared/);

expectFail('24:00 and next-day 00:00 cannot create two occurrences', () => {
  const db = createDb();
  seedTask(db); seedSchedule(db);
  seedOccurrence(db, { occ: 'occ-24', template: '{}', inputs: '{"log_task_id":"oa_approval"}' });
  db.prepare(`INSERT INTO workflow_occurrences(
    occurrence_id, schedule_id, tenant_key, scheduled_for, schedule_revision,
    input_template_json, input_template_sha256, inputs_json, inputs_sha256,
    status, updated_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
    'occ-24b','schedule-a','tenant-a','2026-11-13T24:00:00Z',1,'{}',hash64('c'),'{"log_task_id":"oa_approval"}',hash64('d'),'pending','2026-11-13T00:00:00Z'
  );
}, /CHECK constraint failed/);

expectFail('zero-item migration cannot complete', () => {
  const db = createDb();
  db.prepare(`INSERT INTO log_collection_migrations(
    migration_id, status, required_item_count, source_hashes_json, details_json, started_at, updated_at
  ) VALUES (?,?,?,?,?,?,?)`).run('mig-zero','pending',1,'{}','{}','2026-11-13T00:00:00Z','2026-11-13T00:00:00Z');
  db.prepare("UPDATE log_collection_migrations SET status='running' WHERE migration_id='mig-zero'").run();
  db.prepare("UPDATE log_collection_migrations SET status='completed', completed_at='2026-11-13T00:00:01Z' WHERE migration_id='mig-zero'").run();
}, /required migration item count mismatch/);

expectFail('invalid calendar date rejected', () => {
  const db = createDb(); seedTask(db); seedSchedule(db);
  db.prepare(`INSERT INTO workflow_occurrences(
    occurrence_id, schedule_id, tenant_key, scheduled_for, schedule_revision,
    input_template_json, input_template_sha256, inputs_json, inputs_sha256,
    status, updated_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
    'occ-baddate','schedule-a','tenant-a','2026-02-30T00:00:00Z',1,'{}',hash64('c'),'{"log_task_id":"oa_approval"}',hash64('d'),'pending','2026-11-13T00:00:00Z'
  );
}, /CHECK constraint failed/);

expectOk('ACL revocation can be followed by a new grant generation', () => {
  const db = createDb(); seedTask(db);
  db.prepare(`INSERT INTO log_collection_task_acl(tenant_key, task_uid, agent_preset, generation, can_pull, can_query, granted_by, granted_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?)`).run('tenant-a','task-a','log_puller',1,1,0,'owner','2026-11-13T00:00:00Z','2026-11-13T00:00:00Z');
  db.prepare("UPDATE log_collection_task_acl SET revoked_at='2026-11-13T01:00:00Z', revoked_by='owner', updated_at='2026-11-13T01:00:00Z' WHERE task_uid='task-a' AND agent_preset='log_puller' AND generation=1").run();
  db.prepare(`INSERT INTO log_collection_task_acl(tenant_key, task_uid, agent_preset, generation, can_pull, can_query, granted_by, granted_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?)`).run('tenant-a','task-a','log_puller',2,1,0,'owner','2026-11-13T02:00:00Z','2026-11-13T02:00:00Z');
  return 'acl_generation=2';
});

expectFail('completed run requires at least one retained artifact', () => {
  const db = createDb(); seedTask(db); const run = insertQueuedRun(db); advance(db, run, 'publishing');
  const manifest = addObject(db, 'a', 10);
  db.prepare(`INSERT INTO log_collection_snapshots(snapshot_id, task_uid, run_id, manifest_object_sha256, published_at, status)
    VALUES (?,?,?,?,?,?)`).run('snap-empty', run.uid, run.runId, manifest, '2026-11-13T00:00:00Z', 'complete');
  db.prepare("UPDATE log_collection_objects SET state='published', updated_at='2026-11-13T00:00:01Z' WHERE object_sha256=?").run(manifest);
  db.prepare('UPDATE log_collection_runs SET published_snapshot_id=? WHERE run_id=?').run('snap-empty', run.runId);
  db.prepare("UPDATE log_collection_runs SET status='completed', finished_at='2026-11-13T00:00:02Z', receipt_json='{}' WHERE run_id=?").run(run.runId);
}, /retained published artifact/);

expectFail('artifact cannot expire before terminal run', () => {
  const db = createDb(); seedTask(db); const run = insertQueuedRun(db); advance(db, run, 'publishing');
  const manifest = addObject(db, 'a', 10); const content = addObject(db, 'b', 100);
  addObservation(db, run, { observationId: 'obs-a', hash: 'b', byteSize: 100 });
  db.prepare(`INSERT INTO log_collection_snapshots(snapshot_id, task_uid, run_id, manifest_object_sha256, published_at, status)
    VALUES (?,?,?,?,?,?)`).run('snap-a', run.uid, run.runId, manifest, '2026-11-13T00:00:00Z', 'complete');
  db.prepare(`INSERT INTO log_collection_artifacts(artifact_id, snapshot_id, observation_id, remote_path, object_sha256, local_relative_path, size_bytes, content_sha256)
    VALUES (?,?,?,?,?,?,?,?)`).run('art-a','snap-a','obs-a',remotePath,content,'oa_audit.log',100,content);
  db.prepare("UPDATE log_collection_artifacts SET retention_state='expired', object_sha256=NULL, retired_at='2026-11-13T00:00:02Z' WHERE artifact_id='art-a'").run();
}, /terminal run/);

expectFail('ACL generation cannot go backwards', () => {
  const db=createDb(); seedTask(db);
  db.prepare(`INSERT INTO log_collection_task_acl(tenant_key,task_uid,agent_preset,generation,can_pull,can_query,granted_by,granted_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?)`).run('tenant-a','task-a','puller',10,1,0,'owner','2026-11-13T00:00:00Z','2026-11-13T00:00:00Z');
  db.prepare("UPDATE log_collection_task_acl SET revoked_at='2026-11-13T01:00:00Z', revoked_by='owner', updated_at='2026-11-13T01:00:00Z' WHERE task_uid='task-a' AND agent_preset='puller' AND generation=10").run();
  db.prepare(`INSERT INTO log_collection_task_acl(tenant_key,task_uid,agent_preset,generation,can_pull,can_query,granted_by,granted_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?)`).run('tenant-a','task-a','puller',2,1,0,'owner','2026-11-13T02:00:00Z','2026-11-13T02:00:00Z');
}, /generation must increase/);

expectFail('credential migration item completion requires generation', () => {
  const db=createDb();
  db.prepare(`INSERT INTO log_collection_migrations(migration_id,status,required_item_count,source_hashes_json,details_json,started_at,updated_at)
    VALUES (?,?,?,?,?,?,?)`).run('mig-c','pending',1,'{}','{}','2026-11-13T00:00:00Z','2026-11-13T00:00:00Z');
  db.prepare(`INSERT INTO log_collection_migration_items(migration_id,source_item_id,target_kind,target_id,required,status,updated_at)
    VALUES (?,?,?,?,?,?,?)`).run('mig-c','ssh:MaxKB','credential','instance-maxkb',1,'pending','2026-11-13T00:00:00Z');
  db.prepare("UPDATE log_collection_migration_items SET status='completed' WHERE migration_id='mig-c' AND source_item_id='ssh:MaxKB'").run();
}, /CHECK constraint failed/);

const failed = results.filter((item) => item.outcome !== 'PASS');
for (const item of results) {
  console.log(`${item.outcome.padEnd(15)} ${item.name}`);
  if (item.outcome !== 'PASS') console.log(`  ${item.detail}`);
}
console.log(`summary pass=${results.length - failed.length} fail=${failed.length} total=${results.length}`);
if (failed.length > 0) process.exitCode = 1;
