/**
 * Versioned SQLite schema for the task database.
 *
 * `TASK_SCHEMA_SQL` is the only definition of the v2 tables, indexes and
 * triggers; `contracts.ts` independently states the same names, and
 * `tests/schema.test.ts` asserts the two agree after applying the schema.
 *
 * Opening an existing database never runs this DDL implicitly: callers read
 * `readUserVersion` first and reject unknown or future versions instead of
 * accepting a partially matching file.
 *
 * @module @agentops/dsh-task/schema
 */

import type { DatabaseSync } from 'node:sqlite'

import {
  APPEND_ONLY_TABLES,
  PARENT_CYCLE_TRIGGER,
  REVISION_TRIGGER_PREFIXES,
  TASK_INDEXES,
  TASK_RELATION_TRIGGERS,
  TASK_REVISION_TABLES,
} from './contracts.ts'

/** Schema generation written to `PRAGMA user_version`. */
export const SCHEMA_VERSION = 3

const TABLE_DDL: readonly string[] = [
  `CREATE TABLE global_revision (
    singleton INTEGER PRIMARY KEY,
    revision  INTEGER NOT NULL DEFAULT 0,
    CHECK (singleton = 1),
    CHECK (revision >= 0)
  )`,

  `CREATE TABLE projects (
    project_id       TEXT PRIMARY KEY,
    name             TEXT NOT NULL,
    type             TEXT NOT NULL DEFAULT 'code' CHECK (type IN ('code','knowledge','hybrid')),
    local_path       TEXT,
    github_url       TEXT,
    feishu_doc_token TEXT,
    workspace_id     TEXT,
    next_task_number INTEGER NOT NULL DEFAULT 1 CHECK (next_task_number >= 1),
    metadata         TEXT,
    ownership_state  TEXT NOT NULL DEFAULT 'ownership_pending'
                     CHECK (ownership_state IN ('active','ownership_pending')),
    version          INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
    created_at       TEXT NOT NULL,
    updated_at       TEXT NOT NULL
  )`,

  `CREATE TABLE agent_styles (
    style_id               TEXT PRIMARY KEY,
    name                   TEXT NOT NULL,
    description            TEXT,
    system_prompt_overlay  TEXT,
    permissions_overlay    TEXT,
    model_overlay          TEXT,
    version                INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0)
  )`,

  `CREATE TABLE design_docs (
    doc_id              TEXT PRIMARY KEY,
    project_id          TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
    title               TEXT NOT NULL,
    path                TEXT NOT NULL,
    content_hash        TEXT,
    affected_by_tasks   TEXT,
    last_updated_by_task TEXT,
    version             INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
    last_updated_at     TEXT
  )`,

  `CREATE TABLE ideas (
    idea_id           TEXT PRIMARY KEY,
    project_id        TEXT REFERENCES projects(project_id) ON DELETE SET NULL,
    channel           TEXT NOT NULL DEFAULT 'manual'
                      CHECK (channel IN ('manual','bot','agent','connector','agent_extract')),
    source_system     TEXT,
    connector_ref     TEXT,
    source_ref        TEXT,
    kind              TEXT NOT NULL DEFAULT 'idea'
                      CHECK (kind IN ('requirement','bug','doc','question','idea')),
    title             TEXT,
    content           TEXT NOT NULL,
    tags              TEXT,
    status            TEXT NOT NULL DEFAULT 'captured'
                      CHECK (status IN ('captured','triaged','ready','converted','ignored','archived')),
    confidence        TEXT NOT NULL DEFAULT 'medium' CHECK (confidence IN ('high','medium','low')),
    priority          TEXT NOT NULL DEFAULT 'P2' CHECK (priority IN ('P0','P1','P2')),
    raw_ref           TEXT,
    content_hash      TEXT,
    revision          INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
    captured_at       TEXT,
    converted_task_id TEXT,
    converted_idea_id TEXT,
    version           INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
    created_at        TEXT NOT NULL
  )`,

  `CREATE TABLE tasks (
    task_id           TEXT PRIMARY KEY,
    project_id        TEXT NOT NULL REFERENCES projects(project_id) ON DELETE RESTRICT,
    source_candidate_id TEXT NOT NULL UNIQUE REFERENCES task_candidates(candidate_id) ON DELETE RESTRICT,
    owner_user_id     TEXT NOT NULL DEFAULT 'unknown',
    mandate_id        TEXT REFERENCES task_mandates(mandate_id) ON DELETE RESTRICT,
    workspace_override TEXT,
    repository_ref    TEXT,
    branch_ref        TEXT,
    external_thread_id TEXT,
    external_message_id TEXT,
    authority_epoch   INTEGER NOT NULL DEFAULT 0 CHECK (authority_epoch >= 0),
    lifecycle_mode    TEXT NOT NULL DEFAULT 'v1' CHECK (lifecycle_mode IN ('p0','v1')),
    identifier        TEXT,
    parent_task_id    TEXT REFERENCES tasks(task_id) ON DELETE RESTRICT,
    source_idea_id    TEXT,
    title             TEXT NOT NULL,
    description       TEXT,
    status            TEXT NOT NULL DEFAULT 'idea',
    task_type         TEXT NOT NULL DEFAULT 'code' CHECK (task_type IN ('code','knowledge','design','hybrid')),
    risk_level        TEXT NOT NULL DEFAULT 'medium' CHECK (risk_level IN ('low','medium','high')),
    creator_type      TEXT NOT NULL DEFAULT 'user' CHECK (creator_type IN ('user','agent')),
    creator_id        TEXT,
    creator_name      TEXT,
    assignee_type     TEXT,
    assignee_id       TEXT,
    assignee_name     TEXT,
    style_id          TEXT,
    sort_order        REAL NOT NULL DEFAULT 0,
    thread_id         TEXT,
    approved          INTEGER,
    version           INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
    created_at        TEXT NOT NULL,
    updated_at        TEXT NOT NULL,
    closed_at         TEXT,
    archived_at       TEXT,
    CHECK (
      (lifecycle_mode = 'p0' AND status IN ('idea','backlog','discussing','reviewing','closed'))
      OR
      (lifecycle_mode = 'v1' AND status IN (
        'idea','backlog','discussing','reviewing','decomposing','in_progress',
        'validating','closing','closed','paused','blocked','failed','canceled','abandoned'
      ))
    )
  )`,

  `CREATE TABLE task_stages (
    stage_id     TEXT PRIMARY KEY,
    task_id      TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
    stage_type   TEXT NOT NULL,
    status       TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','running','committed','failed')),
    assigned_agent TEXT,
    style_id     TEXT,
    stage_input  TEXT,
    stage_output TEXT,
    version      INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
    started_at   TEXT,
    committed_at TEXT
  )`,

  `CREATE TABLE task_relations (
    relation_id     TEXT PRIMARY KEY,
    relation_type   TEXT NOT NULL CHECK (relation_type IN ('parent','blocks','related')),
    source_task_id  TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE RESTRICT,
    target_task_id  TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE RESTRICT,
    version         INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
    created_at      TEXT NOT NULL,
    CHECK (source_task_id <> target_task_id)
  )`,

  `CREATE TABLE task_events (
    event_id   TEXT PRIMARY KEY,
    task_id    TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
    stage_id   TEXT,
    event_type TEXT NOT NULL,
    actor      TEXT,
    payload    TEXT,
    created_at TEXT NOT NULL
  )`,

  `CREATE TABLE task_activities (
    activity_id TEXT PRIMARY KEY,
    task_id     TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
    actor_type  TEXT NOT NULL CHECK (actor_type IN ('user','agent')),
    actor_id    TEXT,
    actor_name  TEXT,
    changes     TEXT,
    created_at  TEXT NOT NULL
  )`,

  `CREATE TABLE task_artifacts (
    artifact_id  TEXT PRIMARY KEY,
    task_id      TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
    type         TEXT NOT NULL CHECK (type IN ('code','doc','report','data')),
    path         TEXT,
    content_hash TEXT,
    description  TEXT,
    version      INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
    created_at   TEXT NOT NULL
  )`,

  `CREATE TABLE task_reports (
    report_id    TEXT PRIMARY KEY,
    task_id      TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
    agent_id     TEXT,
    session_id   TEXT,
    content      TEXT NOT NULL,
    artifact_ids TEXT,
    acceptance_self_check TEXT,
    status       TEXT NOT NULL DEFAULT 'submitted'
                 CHECK (status IN ('submitted','approved','changes_requested')),
    version      INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
    submitted_at TEXT NOT NULL
  )`,

  `CREATE TABLE task_comments (
    comment_id      TEXT PRIMARY KEY,
    task_id         TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
    report_id       TEXT REFERENCES task_reports(report_id) ON DELETE SET NULL,
    author_type     TEXT NOT NULL CHECK (author_type IN ('user','agent')),
    author_id       TEXT,
    author_name     TEXT,
    body            TEXT NOT NULL,
    comment_type    TEXT NOT NULL DEFAULT 'discussion'
                    CHECK (comment_type IN ('report','review','discussion')),
    decision        TEXT CHECK (decision IS NULL OR decision IN ('approve','request_changes')),
    rollback_target TEXT,
    thread_id       TEXT,
    mentions        TEXT,
    version         INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
  )`,

  `CREATE TABLE acceptance_criteria (
    criteria_id TEXT PRIMARY KEY,
    task_id     TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
    description TEXT NOT NULL,
    check_type  TEXT NOT NULL DEFAULT 'manual' CHECK (check_type IN ('auto','manual')),
    status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','passed','failed')),
    version     INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
    checked_at  TEXT
  )`,

  `CREATE TABLE doc_change_proposals (
    proposal_id      TEXT PRIMARY KEY,
    doc_id           TEXT NOT NULL REFERENCES design_docs(doc_id) ON DELETE CASCADE,
    task_id          TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
    change_type      TEXT NOT NULL CHECK (change_type IN ('add','modify','deprecate','replace')),
    section_path     TEXT,
    old_content_hash TEXT,
    new_content      TEXT,
    rationale        TEXT,
    status           TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending','approved','rejected','applied')),
    version          INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
    created_at       TEXT NOT NULL,
    applied_at       TEXT
  )`,

  `CREATE TABLE design_doc_changes (
    change_id   TEXT PRIMARY KEY,
    doc_id      TEXT NOT NULL REFERENCES design_docs(doc_id) ON DELETE CASCADE,
    task_id     TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
    proposal_id TEXT REFERENCES doc_change_proposals(proposal_id) ON DELETE SET NULL,
    change_type TEXT NOT NULL CHECK (change_type IN ('add','modify','deprecate','replace')),
    section_path TEXT,
    prev_hash   TEXT,
    new_hash    TEXT,
    changed_at  TEXT NOT NULL
  )`,

  `CREATE TABLE task_runs (
    link_id            TEXT PRIMARY KEY,
    task_id            TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
    run_id             TEXT,
    session_id         TEXT,
    terminal_session_id TEXT,
    role               TEXT NOT NULL DEFAULT 'main_execution'
                       CHECK (role IN ('main_execution','validation','discussion')),
    status             TEXT NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending','running','succeeded','failed','canceled','unknown')),
    idempotency_key    TEXT,
    linked_at          TEXT NOT NULL
  )`,

  `CREATE TABLE task_leases (
    lease_id        TEXT PRIMARY KEY,
    task_id         TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE RESTRICT,
    link_id         TEXT NOT NULL REFERENCES task_runs(link_id) ON DELETE RESTRICT,
    holder_type     TEXT NOT NULL CHECK (holder_type IN ('agent','session','service')),
    holder_id       TEXT NOT NULL,
    session_id      TEXT NOT NULL,
    lease_token     TEXT NOT NULL UNIQUE,
    authority_epoch INTEGER NOT NULL DEFAULT 0 CHECK (authority_epoch >= 0),
    status          TEXT NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active','released','expired','revoked')),
    acquired_at     TEXT NOT NULL,
    heartbeat_at    TEXT NOT NULL,
    expires_at      TEXT NOT NULL,
    released_at     TEXT NOT NULL DEFAULT '',
    version         INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
    CHECK (length(trim(holder_id)) > 0),
    CHECK (length(trim(session_id)) > 0),
    CHECK (length(trim(lease_token)) > 0)
  )`,

  `CREATE TABLE design_notes (
    note_id      TEXT PRIMARY KEY,
    task_id      TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
    project_id   TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
    status       TEXT NOT NULL DEFAULT 'proposed'
                 CHECK (status IN ('proposed','implemented','rejected','archived')),
    content      TEXT NOT NULL,
    supersedes   TEXT REFERENCES design_notes(note_id) ON DELETE SET NULL,
    reject_reason TEXT,
    source_run   TEXT,
    version      INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL
  )`,

  `CREATE TABLE task_contributions (
    contribution_id  TEXT PRIMARY KEY,
    task_id          TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
    agent_id         TEXT NOT NULL,
    contribution_pct REAL NOT NULL CHECK (contribution_pct >= 0 AND contribution_pct <= 100),
    basis            TEXT,
    round            INTEGER NOT NULL DEFAULT 1 CHECK (round >= 1),
    created_at       TEXT NOT NULL
  )`,

  `CREATE TABLE agent_profiles (
    agent_id              TEXT PRIMARY KEY,
    reputation            REAL NOT NULL DEFAULT 0,
    reputation_updated_at TEXT,
    tasks_won             INTEGER NOT NULL DEFAULT 0,
    contribution_total    REAL NOT NULL DEFAULT 0,
    avg_report_score      REAL,
    updated_at            TEXT NOT NULL
  )`,

  `CREATE TABLE task_report_exports (
    export_id   TEXT PRIMARY KEY,
    report_id   TEXT NOT NULL REFERENCES task_reports(report_id) ON DELETE CASCADE,
    task_id     TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
    format      TEXT NOT NULL CHECK (format IN ('md','html','json')),
    path        TEXT NOT NULL,
    sha256      TEXT NOT NULL,
    size_bytes  INTEGER NOT NULL CHECK (size_bytes >= 0),
    exported_at TEXT NOT NULL
  )`,

  `CREATE TABLE project_members (
    membership_id   TEXT PRIMARY KEY,
    project_id      TEXT NOT NULL REFERENCES projects(project_id) ON DELETE RESTRICT,
    principal_type  TEXT NOT NULL CHECK (principal_type IN ('user','agent','service')),
    principal_id    TEXT NOT NULL,
    role            TEXT NOT NULL CHECK (role IN ('owner','maintainer','reviewer','executor','viewer')),
    granted_by      TEXT NOT NULL,
    granted_at      TEXT NOT NULL,
    revoked_at      TEXT NOT NULL DEFAULT '',
    version         INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
    CHECK (length(trim(principal_id)) > 0),
    CHECK (length(trim(granted_by)) > 0)
  )`,

  `CREATE TABLE external_subject_mappings (
    mapping_id           TEXT PRIMARY KEY,
    provider             TEXT NOT NULL CHECK (provider IN ('feishu','oa','wecom','github','local')),
    external_subject_id  TEXT NOT NULL,
    principal_type       TEXT NOT NULL CHECK (principal_type IN ('user','agent','service')),
    principal_id         TEXT NOT NULL,
    active               INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
    verified_at          TEXT NOT NULL,
    verified_by          TEXT NOT NULL,
    UNIQUE(provider, external_subject_id)
  )`,

  `CREATE TABLE task_candidates (
    candidate_id            TEXT PRIMARY KEY,
    source_idea_id          TEXT REFERENCES ideas(idea_id) ON DELETE RESTRICT,
    source_type             TEXT NOT NULL CHECK (source_type IN ('manual','idea','agent','connector','external','legacy_task')),
    source_system           TEXT NOT NULL DEFAULT '',
    source_ref              TEXT NOT NULL,
    project_id              TEXT NOT NULL REFERENCES projects(project_id) ON DELETE RESTRICT,
    workspace_id            TEXT NOT NULL DEFAULT '',
    repository_ref          TEXT NOT NULL DEFAULT '',
    branch_ref              TEXT NOT NULL DEFAULT '',
    title                   TEXT NOT NULL,
    description             TEXT NOT NULL DEFAULT '',
    status                  TEXT NOT NULL DEFAULT 'captured'
                            CHECK (status IN ('captured','analyzing','awaiting_gate','converted','rejected','deferred','merged')),
    analysis_problem        TEXT NOT NULL DEFAULT '',
    analysis_non_goals      TEXT NOT NULL DEFAULT '',
    analysis_deliverables   TEXT NOT NULL DEFAULT '',
    acceptance_criteria_json TEXT NOT NULL DEFAULT '[]',
    dependencies_json       TEXT NOT NULL DEFAULT '[]',
    risk_level              TEXT NOT NULL DEFAULT 'medium' CHECK (risk_level IN ('low','medium','high')),
    risk_reason             TEXT NOT NULL DEFAULT '',
    complexity              TEXT NOT NULL DEFAULT 'medium' CHECK (complexity IN ('simple','medium','complex')),
    owner_user_id           TEXT NOT NULL DEFAULT '',
    proposed_assignee       TEXT NOT NULL DEFAULT '',
    mandate_scope_json      TEXT NOT NULL DEFAULT '{}',
    decision_change_required INTEGER NOT NULL DEFAULT 0 CHECK (decision_change_required IN (0,1)),
    admission_snapshot_id   TEXT REFERENCES admission_snapshots(snapshot_id) ON DELETE RESTRICT,
    admission_snapshot_hash TEXT NOT NULL DEFAULT '',
    duplicate_of_task_id    TEXT REFERENCES tasks(task_id) ON DELETE RESTRICT,
    duplicate_of_candidate_id TEXT REFERENCES task_candidates(candidate_id) ON DELETE RESTRICT,
    converted_task_id       TEXT UNIQUE REFERENCES tasks(task_id) ON DELETE RESTRICT,
    latest_gate_event_id    TEXT REFERENCES candidate_gate_events(event_id) ON DELETE RESTRICT,
    deferred_until          TEXT NOT NULL DEFAULT '',
    defer_reason            TEXT NOT NULL DEFAULT '',
    version                 INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
    created_at              TEXT NOT NULL,
    updated_at              TEXT NOT NULL,
    CHECK (length(trim(source_ref)) > 0),
    CHECK (status <> 'converted' OR converted_task_id IS NOT NULL),
    CHECK (status = 'converted' OR converted_task_id IS NULL),
    CHECK (status <> 'rejected' OR length(trim(defer_reason)) > 0),
    CHECK (status <> 'deferred' OR (length(trim(defer_reason)) > 0 AND length(trim(deferred_until)) > 0))
  )`,

  `CREATE TABLE admission_snapshots (
    snapshot_id             TEXT PRIMARY KEY,
    candidate_id            TEXT NOT NULL REFERENCES task_candidates(candidate_id) ON DELETE RESTRICT,
    candidate_version       INTEGER NOT NULL CHECK (candidate_version >= 0),
    project_id              TEXT NOT NULL REFERENCES projects(project_id) ON DELETE RESTRICT,
    search_query_json       TEXT NOT NULL,
    search_coverage_json    TEXT NOT NULL,
    active_work_json        TEXT NOT NULL,
    proposed_decisions_json TEXT NOT NULL,
    authoritative_decisions_json TEXT NOT NULL,
    historical_decisions_json TEXT NOT NULL,
    selected_decision_ids_json TEXT NOT NULL,
    decision_link_count     INTEGER NOT NULL CHECK (decision_link_count >= 0),
    conflicts_json          TEXT NOT NULL,
    required_actions_json   TEXT NOT NULL,
    residual_risk           TEXT NOT NULL,
    snapshot_version        INTEGER NOT NULL CHECK (snapshot_version >= 1),
    canonical_json          TEXT NOT NULL,
    snapshot_hash           TEXT NOT NULL,
    created_by              TEXT NOT NULL,
    created_at              TEXT NOT NULL,
    CHECK (length(trim(snapshot_hash)) > 0),
    CHECK (length(trim(created_by)) > 0)
  )`,

  `CREATE TABLE candidate_gate_events (
    event_id          TEXT PRIMARY KEY,
    candidate_id      TEXT NOT NULL REFERENCES task_candidates(candidate_id) ON DELETE RESTRICT,
    candidate_version INTEGER NOT NULL CHECK (candidate_version >= 0),
    snapshot_id       TEXT REFERENCES admission_snapshots(snapshot_id) ON DELETE RESTRICT,
    snapshot_hash     TEXT NOT NULL DEFAULT '',
    action            TEXT NOT NULL CHECK (action IN ('approve','reject','defer','merge','legacy_import')),
    actor_type        TEXT NOT NULL CHECK (actor_type IN ('user','agent','service')),
    actor_id          TEXT NOT NULL,
    reason            TEXT NOT NULL DEFAULT '',
    merge_target_id   TEXT REFERENCES task_candidates(candidate_id) ON DELETE RESTRICT,
    requested_changes_json TEXT NOT NULL DEFAULT '[]',
    decided_at        TEXT NOT NULL,
    request_id        TEXT NOT NULL UNIQUE,
    idempotency_key   TEXT NOT NULL,
    payload_hash      TEXT NOT NULL,
    CHECK (length(trim(actor_id)) > 0),
    CHECK (action <> 'approve' OR (
      snapshot_id IS NOT NULL AND length(trim(snapshot_hash)) > 0
    )),
    CHECK (action <> 'reject' OR length(trim(reason)) > 0),
    CHECK (action <> 'defer' OR length(trim(reason)) > 0),
    CHECK (action <> 'merge' OR merge_target_id IS NOT NULL)
  )`,

  `CREATE TABLE task_mandates (
    mandate_id          TEXT PRIMARY KEY,
    candidate_id        TEXT NOT NULL REFERENCES task_candidates(candidate_id) ON DELETE RESTRICT,
    task_id             TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE RESTRICT,
    source_gate_event_id TEXT NOT NULL REFERENCES candidate_gate_events(event_id) ON DELETE RESTRICT,
    issued_by           TEXT NOT NULL,
    scope_json          TEXT NOT NULL,
    status              TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked','expired')),
    effective_from      TEXT NOT NULL,
    effective_to        TEXT NOT NULL DEFAULT '',
    version             INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
    created_at          TEXT NOT NULL,
    revoked_at          TEXT NOT NULL DEFAULT '',
    revoke_reason       TEXT NOT NULL DEFAULT '',
    CHECK (length(trim(issued_by)) > 0)
  )`,

  `CREATE TABLE decisions (
    decision_id          TEXT PRIMARY KEY,
    project_id           TEXT NOT NULL REFERENCES projects(project_id) ON DELETE RESTRICT,
    workspace_id         TEXT NOT NULL DEFAULT '',
    repository_ref       TEXT NOT NULL DEFAULT '',
    decision_key         TEXT NOT NULL,
    title                TEXT NOT NULL,
    status               TEXT NOT NULL DEFAULT 'proposed'
                         CHECK (status IN ('proposed','implemented','rejected','archived')),
    subject_type         TEXT NOT NULL CHECK (subject_type IN ('project','task','module','service','api','process','data','security')),
    subject_id           TEXT NOT NULL DEFAULT '',
    authority_scope      TEXT NOT NULL CHECK (authority_scope IN ('project','workspace','repository','branch','environment','task')),
    authority_level      TEXT NOT NULL CHECK (authority_level IN ('hard_constraint','policy','implementation','local_default')),
    relaxes_decision_id  TEXT REFERENCES decisions(decision_id) ON DELETE RESTRICT,
    relaxes_evidence_id  TEXT REFERENCES decision_evidence(evidence_id) ON DELETE RESTRICT,
    environment          TEXT NOT NULL DEFAULT '',
    branch_key           TEXT NOT NULL DEFAULT '',
    rollout_key          TEXT NOT NULL DEFAULT 'stable',
    tenant_key           TEXT NOT NULL DEFAULT '',
    region_key           TEXT NOT NULL DEFAULT '',
    problem              TEXT NOT NULL,
    proposal             TEXT NOT NULL,
    rationale            TEXT NOT NULL,
    alternatives         TEXT NOT NULL DEFAULT '',
    acceptance_criteria  TEXT NOT NULL DEFAULT '',
    proposed_by          TEXT NOT NULL,
    proposed_at          TEXT NOT NULL,
    approved_by          TEXT NOT NULL DEFAULT '',
    approved_at          TEXT NOT NULL DEFAULT '',
    effective_from       TEXT NOT NULL DEFAULT '',
    effective_to         TEXT NOT NULL DEFAULT '',
    reject_reason        TEXT NOT NULL DEFAULT '',
    archive_reason       TEXT NOT NULL DEFAULT '',
    predecessor_id       TEXT REFERENCES decisions(decision_id) ON DELETE RESTRICT,
    supersedes_id        TEXT REFERENCES decisions(decision_id) ON DELETE RESTRICT,
    source_task_id       TEXT REFERENCES tasks(task_id) ON DELETE SET NULL,
    source_candidate_id  TEXT REFERENCES task_candidates(candidate_id) ON DELETE RESTRICT,
    source_run           TEXT NOT NULL DEFAULT '',
    note_path            TEXT NOT NULL DEFAULT '',
    note_class           TEXT NOT NULL CHECK (note_class IN ('feature','bug-fix','simplification','architecture','process','testing')),
    note_date            TEXT NOT NULL,
    content_hash         TEXT NOT NULL DEFAULT '',
    base_content_hash    TEXT NOT NULL DEFAULT '',
    sync_state           TEXT NOT NULL DEFAULT 'pending' CHECK (sync_state IN ('synced','pending','failed','content_conflict')),
    version              INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
    created_at           TEXT NOT NULL,
    updated_at           TEXT NOT NULL,
    CHECK (status <> 'rejected' OR length(trim(reject_reason)) > 0),
    CHECK (status <> 'archived' OR archive_reason IN ('superseded','invalidated','obsolete','project_archived')),
    CHECK (effective_to = ''),
    CHECK (status NOT IN ('implemented','archived') OR (
      length(trim(approved_by)) > 0 AND length(trim(approved_at)) > 0 AND length(trim(effective_from)) > 0
    )),
    CHECK (status NOT IN ('proposed','rejected') OR (
      trim(approved_by) = '' AND trim(approved_at) = '' AND trim(effective_from) = '' AND trim(effective_to) = ''
    )),
    CHECK (relaxes_decision_id IS NULL OR relaxes_evidence_id IS NOT NULL),
    CHECK (relaxes_decision_id IS NULL OR authority_level IN ('policy','implementation','local_default')),
    CHECK (decision_id <> supersedes_id),
    CHECK (decision_id <> predecessor_id)
  )`,

  `CREATE TABLE decision_evidence (
    evidence_id   TEXT PRIMARY KEY,
    decision_id   TEXT NOT NULL REFERENCES decisions(decision_id) ON DELETE RESTRICT,
    kind          TEXT NOT NULL CHECK (kind IN ('pull_request','commit','deployment','document','approval','test','manual')),
    ref           TEXT NOT NULL,
    verified_by   TEXT NOT NULL,
    verified_at   TEXT NOT NULL,
    content_hash  TEXT NOT NULL,
    created_at    TEXT NOT NULL,
    CHECK (length(trim(ref)) > 0),
    CHECK (length(trim(verified_by)) > 0),
    CHECK (length(trim(content_hash)) > 0)
  )`,

  `CREATE TABLE decision_note_artifacts (
    artifact_id       TEXT PRIMARY KEY,
    decision_id       TEXT NOT NULL REFERENCES decisions(decision_id) ON DELETE RESTRICT,
    decision_version  INTEGER NOT NULL CHECK (decision_version >= 0),
    artifact_kind     TEXT NOT NULL CHECK (artifact_kind IN ('english','chinese','sidecar')),
    relative_path     TEXT NOT NULL,
    content_hash      TEXT NOT NULL,
    base_content_hash TEXT NOT NULL DEFAULT '',
    synced_at         TEXT NOT NULL,
    created_at        TEXT NOT NULL,
    UNIQUE(decision_id, decision_version, artifact_kind)
  )`,

  `CREATE TABLE decision_relations (
    relation_id          TEXT PRIMARY KEY,
    source_decision_id   TEXT NOT NULL REFERENCES decisions(decision_id) ON DELETE RESTRICT,
    target_decision_id   TEXT NOT NULL REFERENCES decisions(decision_id) ON DELETE RESTRICT,
    relation_type        TEXT NOT NULL CHECK (relation_type IN ('supersedes','amends','conflicts_with','related')),
    evidence_ref         TEXT NOT NULL DEFAULT '',
    created_by           TEXT NOT NULL,
    created_at           TEXT NOT NULL,
    CHECK (source_decision_id <> target_decision_id)
  )`,

  `CREATE TABLE decision_audit (
    audit_id             TEXT PRIMARY KEY,
    decision_id          TEXT NOT NULL REFERENCES decisions(decision_id) ON DELETE RESTRICT,
    event_type           TEXT NOT NULL,
    actor_type           TEXT NOT NULL CHECK (actor_type IN ('user','agent','service')),
    actor_id             TEXT NOT NULL,
    decision_version     INTEGER NOT NULL CHECK (decision_version >= 0),
    candidate_gate_event_id TEXT REFERENCES candidate_gate_events(event_id) ON DELETE RESTRICT,
    payload_json         TEXT NOT NULL,
    created_at           TEXT NOT NULL
  )`,

  `CREATE TABLE admission_snapshot_selected_decisions (
    snapshot_id      TEXT NOT NULL REFERENCES admission_snapshots(snapshot_id) ON DELETE RESTRICT,
    decision_id      TEXT NOT NULL REFERENCES decisions(decision_id) ON DELETE RESTRICT,
    decision_status  TEXT NOT NULL CHECK (decision_status IN ('proposed','implemented','rejected','archived')),
    collection_type  TEXT NOT NULL CHECK (collection_type IN ('proposed','authoritative','historical')),
    decision_version INTEGER NOT NULL CHECK (decision_version >= 0),
    selected_rank    INTEGER NOT NULL CHECK (selected_rank >= 0),
    PRIMARY KEY(snapshot_id, decision_id)
  )`,

  `CREATE TABLE task_decision_links (
    link_id                TEXT PRIMARY KEY,
    task_id                TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE RESTRICT,
    decision_id            TEXT NOT NULL REFERENCES decisions(decision_id) ON DELETE RESTRICT,
    admission_snapshot_id  TEXT NOT NULL REFERENCES admission_snapshots(snapshot_id) ON DELETE RESTRICT,
    link_type              TEXT NOT NULL CHECK (link_type IN ('implements','constrains','references')),
    evidence_kind          TEXT NOT NULL CHECK (evidence_kind IN ('gate_event','admission_snapshot','rebind_event','manual_approval')),
    evidence_ref           TEXT NOT NULL,
    authority_epoch        INTEGER NOT NULL CHECK (authority_epoch >= 0),
    active                 INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
    version                INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
    created_by             TEXT NOT NULL,
    created_at             TEXT NOT NULL,
    FOREIGN KEY (admission_snapshot_id, decision_id)
      REFERENCES admission_snapshot_selected_decisions(snapshot_id, decision_id)
      ON DELETE RESTRICT
  )`,

  `CREATE TABLE decision_note_sync_outbox (
    outbox_id                   TEXT PRIMARY KEY,
    decision_id                 TEXT NOT NULL REFERENCES decisions(decision_id) ON DELETE RESTRICT,
    decision_version            INTEGER NOT NULL CHECK (decision_version >= 0),
    target_status               TEXT NOT NULL CHECK (target_status IN ('implemented','archived')),
    expected_note_path          TEXT NOT NULL,
    expected_artifact_set_hash  TEXT NOT NULL,
    job_status                  TEXT NOT NULL DEFAULT 'pending'
                                CHECK (job_status IN ('pending','running','succeeded','failed','dead','stale')),
    attempts                    INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    available_at                TEXT NOT NULL,
    locked_by                   TEXT NOT NULL DEFAULT '',
    lock_expires_at             TEXT NOT NULL DEFAULT '',
    last_error                  TEXT NOT NULL DEFAULT '',
    created_at                  TEXT NOT NULL,
    updated_at                  TEXT NOT NULL,
    UNIQUE(decision_id, decision_version)
  )`,

  `CREATE TABLE migration_cutovers (
    cutover_id            TEXT PRIMARY KEY,
    source_schema_version INTEGER NOT NULL,
    target_schema_version INTEGER NOT NULL,
    source_fingerprint    TEXT NOT NULL,
    status                TEXT NOT NULL CHECK (status IN ('prepared','running','complete','failed')),
    write_token_hash      TEXT NOT NULL DEFAULT '',
    started_at            TEXT NOT NULL,
    completed_at          TEXT NOT NULL DEFAULT '',
    operator_id           TEXT NOT NULL
  )`,

  `CREATE TABLE migration_audit_journal (
    journal_id    TEXT PRIMARY KEY,
    cutover_id    TEXT NOT NULL REFERENCES migration_cutovers(cutover_id) ON DELETE RESTRICT,
    entity_type   TEXT NOT NULL,
    source_id     TEXT NOT NULL,
    target_id     TEXT NOT NULL DEFAULT '',
    action        TEXT NOT NULL,
    outcome       TEXT NOT NULL CHECK (outcome IN ('copied','skipped','quarantined','failed')),
    details_json  TEXT NOT NULL DEFAULT '{}',
    created_at    TEXT NOT NULL
  )`,
]

/**
 * Build the trigger DDL: revision counters, append-only guards, relation cache
 * synchronization, admission closure checks and decision lifecycle guards.
 * Names come from `contracts.ts` so schema and snapshot cannot drift.
 * @returns one `CREATE TRIGGER` statement per trigger.
 */
export function buildTriggerDdl(): string[] {
  const statements: string[] = []
  for (const table of TASK_REVISION_TABLES) {
    const prefix = REVISION_TRIGGER_PREFIXES[table]
    for (const event of ['insert', 'update', 'delete'] as const) {
      statements.push(
        `CREATE TRIGGER ${prefix}${event} AFTER ${event.toUpperCase()} ON ${table} ` +
        'BEGIN UPDATE global_revision SET revision = revision + 1 WHERE singleton = 1; END',
      )
    }
  }

  for (const table of APPEND_ONLY_TABLES) {
    statements.push(
      `CREATE TRIGGER ${table}_append_only_update BEFORE UPDATE ON ${table} ` +
      "BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY_TABLE'); END",
      `CREATE TRIGGER ${table}_append_only_delete BEFORE DELETE ON ${table} ` +
      "BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY_TABLE'); END",
    )
  }

  statements.push(
    `CREATE TRIGGER ${TASK_RELATION_TRIGGERS.taskInsertParent} BEFORE INSERT ON tasks
     WHEN NEW.parent_task_id IS NOT NULL
     BEGIN
       SELECT RAISE(ABORT, 'PARENT_CACHE_REQUIRES_RELATION');
     END`,

    `CREATE TRIGGER ${TASK_RELATION_TRIGGERS.taskUpdateParent} BEFORE UPDATE OF parent_task_id ON tasks
     WHEN NEW.parent_task_id IS NOT OLD.parent_task_id
      AND NEW.parent_task_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM task_relations
        WHERE relation_type = 'parent'
          AND source_task_id = NEW.task_id
          AND target_task_id = NEW.parent_task_id
      )
     BEGIN
       SELECT RAISE(ABORT, 'PARENT_CACHE_REQUIRES_RELATION');
     END`,

    `CREATE TRIGGER tasks_prevent_insert_or_replace BEFORE INSERT ON tasks
     WHEN EXISTS (SELECT 1 FROM tasks WHERE task_id = NEW.task_id)
     BEGIN
       SELECT RAISE(ABORT, 'TASK_ID_ALREADY_EXISTS');
     END`,

    `CREATE TRIGGER tasks_prevent_project_move BEFORE UPDATE OF project_id ON tasks
     WHEN NEW.project_id <> OLD.project_id
     BEGIN
       SELECT RAISE(ABORT, 'TASK_PROJECT_IMMUTABLE');
     END`,

    `CREATE TRIGGER tasks_prevent_candidate_rebind BEFORE UPDATE OF source_candidate_id ON tasks
     WHEN NEW.source_candidate_id <> OLD.source_candidate_id
     BEGIN
       SELECT RAISE(ABORT, 'TASK_CANDIDATE_IMMUTABLE');
     END`,

    `CREATE TRIGGER ${PARENT_CYCLE_TRIGGER} BEFORE INSERT ON task_relations
     WHEN NEW.relation_type = 'parent'
     BEGIN
       SELECT RAISE(ABORT, 'RELATION_CROSS_PROJECT')
       WHERE (SELECT project_id FROM tasks WHERE task_id = NEW.source_task_id)
          <> (SELECT project_id FROM tasks WHERE task_id = NEW.target_task_id);

       SELECT RAISE(ABORT, 'RELATION_CYCLE')
       WHERE NEW.source_task_id = NEW.target_task_id
          OR EXISTS (
            WITH RECURSIVE ancestors(id) AS (
              SELECT NEW.target_task_id
              UNION
              SELECT tr.target_task_id
              FROM task_relations tr
              JOIN ancestors a ON tr.source_task_id = a.id
              WHERE tr.relation_type = 'parent'
            )
            SELECT 1 FROM ancestors WHERE id = NEW.source_task_id
          );
     END`,

    `CREATE TRIGGER ${TASK_RELATION_TRIGGERS.update} BEFORE UPDATE ON task_relations
     BEGIN
       SELECT RAISE(ABORT, 'RELATION_IMMUTABLE');
     END`,

    `CREATE TRIGGER ${TASK_RELATION_TRIGGERS.afterInsert} AFTER INSERT ON task_relations
     WHEN NEW.relation_type = 'parent'
     BEGIN
       UPDATE tasks SET parent_task_id = NEW.target_task_id WHERE task_id = NEW.source_task_id;
     END`,

    `CREATE TRIGGER ${TASK_RELATION_TRIGGERS.afterDelete} AFTER DELETE ON task_relations
     WHEN OLD.relation_type = 'parent'
     BEGIN
       UPDATE tasks SET parent_task_id = NULL WHERE task_id = OLD.source_task_id;
     END`,

    `CREATE TRIGGER candidate_gate_events_require_matching_snapshot
     BEFORE INSERT ON candidate_gate_events
     WHEN NEW.action = 'approve'
     BEGIN
       SELECT RAISE(ABORT, 'CANDIDATE_GATE_SNAPSHOT_MISMATCH')
       WHERE NOT EXISTS (
         SELECT 1
         FROM admission_snapshots s
         WHERE s.snapshot_id = NEW.snapshot_id
           AND s.candidate_id = NEW.candidate_id
           AND s.candidate_version = NEW.candidate_version
           AND s.snapshot_hash = NEW.snapshot_hash
       );
     END`,

    `CREATE TRIGGER tasks_require_gated_candidate
     BEFORE INSERT ON tasks
     BEGIN
       SELECT RAISE(ABORT, 'CANDIDATE_GATE_REQUIRED')
       WHERE NOT EXISTS (
         SELECT 1
         FROM task_candidates c
         JOIN admission_snapshots s
           ON s.snapshot_id = c.admission_snapshot_id
          AND s.candidate_id = c.candidate_id
          AND s.project_id = c.project_id
         JOIN candidate_gate_events g
           ON g.candidate_id = c.candidate_id
          AND g.candidate_version = s.candidate_version
          AND g.snapshot_id = s.snapshot_id
          AND g.snapshot_hash = s.snapshot_hash
          AND g.action = 'approve'
         WHERE c.candidate_id = NEW.source_candidate_id
           AND c.project_id = NEW.project_id
           AND c.status = 'awaiting_gate'
           AND c.admission_snapshot_hash = s.snapshot_hash
       )
       AND NOT EXISTS (SELECT 1 FROM tasks WHERE task_id = NEW.task_id);
     END`,

    `CREATE TRIGGER task_candidates_require_gate_for_conversion
     BEFORE UPDATE OF status ON task_candidates
     WHEN NEW.status = 'converted' AND OLD.status <> 'converted'
     BEGIN
       SELECT RAISE(ABORT, 'CANDIDATE_GATE_REQUIRED')
       WHERE NEW.converted_task_id IS NULL
          OR NEW.admission_snapshot_id IS NULL
          OR length(trim(NEW.admission_snapshot_hash)) = 0
          OR NOT EXISTS (
            SELECT 1
            FROM admission_snapshots s
            JOIN candidate_gate_events g
              ON g.candidate_id = s.candidate_id
             AND g.candidate_version = s.candidate_version
             AND g.snapshot_id = s.snapshot_id
             AND g.snapshot_hash = s.snapshot_hash
             AND g.action = 'approve'
            WHERE s.snapshot_id = NEW.admission_snapshot_id
              AND s.candidate_id = NEW.candidate_id
              AND s.project_id = NEW.project_id
              AND s.snapshot_hash = NEW.admission_snapshot_hash
          );
     END`,

    `CREATE TRIGGER task_candidates_require_selected_links_on_conversion
     BEFORE UPDATE OF status ON task_candidates
     WHEN NEW.status = 'converted' AND OLD.status <> 'converted'
     BEGIN
       SELECT RAISE(ABORT, 'CANDIDATE_DECISION_LINK_CLOSURE')
       WHERE NEW.admission_snapshot_id IS NULL
          OR EXISTS (
            SELECT 1
            FROM admission_snapshot_selected_decisions s
            WHERE s.snapshot_id = NEW.admission_snapshot_id
              AND NOT EXISTS (
                SELECT 1
                FROM task_decision_links l
                WHERE l.task_id = NEW.converted_task_id
                  AND l.admission_snapshot_id = s.snapshot_id
                  AND l.decision_id = s.decision_id
                  AND l.active = 1
              )
          )
          OR EXISTS (
            SELECT 1
            FROM task_decision_links l
            WHERE l.task_id = NEW.converted_task_id
              AND l.admission_snapshot_id = NEW.admission_snapshot_id
              AND l.active = 1
              AND NOT EXISTS (
                SELECT 1
                FROM admission_snapshot_selected_decisions s
                WHERE s.snapshot_id = l.admission_snapshot_id
                  AND s.decision_id = l.decision_id
              )
          );
     END`,

    `CREATE TRIGGER task_decision_links_require_selected_decision
     BEFORE INSERT ON task_decision_links
     WHEN NEW.active = 1
     BEGIN
       SELECT RAISE(ABORT, 'DECISION_NOT_SELECTED')
       WHERE NOT EXISTS (
         SELECT 1
         FROM admission_snapshot_selected_decisions s
         WHERE s.snapshot_id = NEW.admission_snapshot_id
           AND s.decision_id = NEW.decision_id
       );
     END`,

    `CREATE TRIGGER decisions_prevent_invalid_status_transition
     BEFORE UPDATE OF status ON decisions
     WHEN NEW.status <> OLD.status
     BEGIN
       SELECT RAISE(ABORT, 'DECISION_INVALID_TRANSITION')
       WHERE NOT (
         (OLD.status = 'proposed' AND NEW.status IN ('implemented','rejected'))
         OR (OLD.status = 'implemented' AND NEW.status = 'archived')
       );
     END`,

    `CREATE TRIGGER decisions_prevent_implement_without_evidence
     BEFORE UPDATE OF status ON decisions
     WHEN OLD.status = 'proposed' AND NEW.status = 'implemented'
     BEGIN
       SELECT RAISE(ABORT, 'DECISION_EVIDENCE_REQUIRED')
       WHERE NOT EXISTS (
         SELECT 1 FROM decision_evidence WHERE decision_id = NEW.decision_id
       );
     END`,

    `CREATE TRIGGER decisions_freeze_approval_fields
     BEFORE UPDATE OF approved_by, approved_at, effective_from, effective_to ON decisions
     WHEN OLD.status IN ('implemented','archived')
      AND (
        NEW.approved_by IS NOT OLD.approved_by
        OR NEW.approved_at IS NOT OLD.approved_at
        OR NEW.effective_from IS NOT OLD.effective_from
        OR NEW.effective_to IS NOT OLD.effective_to
      )
     BEGIN
       SELECT RAISE(ABORT, 'DECISION_APPROVAL_IMMUTABLE');
     END`,
  )
  return statements
}

/**
 * Build the schema DDL: tables, then indexes, then triggers.
 * @returns every statement, in the order SQLite must execute them.
 */
export function buildSchemaStatements(): string[] {
  const indexes = TASK_INDEXES.map((index) => {
    if (index.definition.startsWith('UNIQUE ')) {
      return `CREATE UNIQUE INDEX ${index.name} ON ${index.definition.slice('UNIQUE '.length)}`
    }
    return `CREATE INDEX ${index.name} ON ${index.definition}`
  })
  return [...TABLE_DDL, ...indexes, ...buildTriggerDdl()]
}

/** Complete schema as one executable script, for inspection and snapshots. */
export const TASK_SCHEMA_SQL = `${buildSchemaStatements().map(sql => `${sql};`).join('\n')}\n`

/** Upgrade a v2 database by adding the task lease control-plane table. */
export function upgradeTaskSchemaV2ToV3(db: DatabaseSync): void {
  db.exec(`CREATE TABLE task_leases (
    lease_id        TEXT PRIMARY KEY,
    task_id         TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE RESTRICT,
    link_id         TEXT NOT NULL REFERENCES task_runs(link_id) ON DELETE RESTRICT,
    holder_type     TEXT NOT NULL CHECK (holder_type IN ('agent','session','service')),
    holder_id       TEXT NOT NULL,
    session_id      TEXT NOT NULL,
    lease_token     TEXT NOT NULL UNIQUE,
    authority_epoch INTEGER NOT NULL DEFAULT 0 CHECK (authority_epoch >= 0),
    status          TEXT NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active','released','expired','revoked')),
    acquired_at     TEXT NOT NULL,
    heartbeat_at    TEXT NOT NULL,
    expires_at      TEXT NOT NULL,
    released_at     TEXT NOT NULL DEFAULT '',
    version         INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
    CHECK (length(trim(holder_id)) > 0),
    CHECK (length(trim(session_id)) > 0),
    CHECK (length(trim(lease_token)) > 0)
  )`)
  db.exec('CREATE UNIQUE INDEX idx_task_leases_one_active ON task_leases(task_id) WHERE status = \'active\'')
  db.exec('CREATE INDEX idx_task_leases_task_status ON task_leases(task_id, status, expires_at)')
  db.exec('CREATE INDEX idx_task_leases_session ON task_leases(session_id, status)')
  db.exec(`CREATE TRIGGER task_leases_rev_after_insert AFTER INSERT ON task_leases BEGIN
    UPDATE global_revision SET revision = revision + 1 WHERE singleton = 1;
  END`)
  db.exec(`CREATE TRIGGER task_leases_rev_after_update AFTER UPDATE ON task_leases BEGIN
    UPDATE global_revision SET revision = revision + 1 WHERE singleton = 1;
  END`)
  db.exec(`CREATE TRIGGER task_leases_rev_after_delete AFTER DELETE ON task_leases BEGIN
    UPDATE global_revision SET revision = revision + 1 WHERE singleton = 1;
  END`)
  db.exec('PRAGMA user_version = 3')
}

/**
 * Create the complete schema in a database that must be empty, then record the
 * schema version. The caller owns the transaction.
 * @param db - open SQLite handle.
 */
export function createTaskSchema(db: DatabaseSync): void {
  for (const statement of buildSchemaStatements()) db.exec(statement)
  db.exec('INSERT INTO global_revision(singleton, revision) VALUES (1, 0)')
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
}

/**
 * Read the stored schema version.
 * @param db - open SQLite handle.
 * @returns the value stored in `PRAGMA user_version`.
 */
export function readUserVersion(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get() as Record<string, number> | undefined
  const value = row === undefined ? 0 : Object.values(row)[0]
  return typeof value === 'number' ? value : 0
}

/**
 * Assert that an open database is exactly the current schema version.
 * @param db - open SQLite handle.
 * @returns nothing; throws when the version is missing, older or newer.
 */
export function assertSchemaVersion(db: DatabaseSync): void {
  const version = readUserVersion(db)
  if (version === 2) {
    upgradeTaskSchemaV2ToV3(db)
    return
  }
  if (version !== SCHEMA_VERSION) {
    throw new Error(
      `task database schema version ${version} is not ${SCHEMA_VERSION}; run the migrator instead of opening it directly`,
    )
  }
}
