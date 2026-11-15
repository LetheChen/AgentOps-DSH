/**
 * Contract snapshot for the task database and its HTTP surface.
 *
 * The snapshot is the single machine-readable statement of what the migration
 * must produce: table set, index set, revision triggers, lifecycle edges and
 * the migrated route list. Runtime code does not read it; the contract test and
 * `scripts/gen-contracts.ts` do, so a drift in any of those sets fails a check
 * instead of being discovered during data migration.
 *
 * Sources: `TASK-MANAGEMENT-MIGRATION-DESIGN.md` §4.2, §4.3, §5.1, §5.4, §5.5,
 * §6.1. Counts in `counts` are derived, never typed by hand.
 *
 * @module @agentops/dsh-task/contracts
 */

import { P0_TERMINAL, P0_STATUSES, P0_TRANSITIONS } from './lifecycle/p0.ts'
import { TASK_STATUSES, TERMINAL, TRANSITIONS } from './status.ts'

/** Bumped when the snapshot shape changes in a way readers must notice. */
export const TASK_CONTRACT_VERSION = 3

/** Table creation order for the v2 schema. */
export const TASK_TABLES = [
  'global_revision',
  'projects',
  'agent_styles',
  'design_docs',
  'ideas',
  'tasks',
  'task_stages',
  'task_relations',
  'task_events',
  'task_activities',
  'task_artifacts',
  'task_reports',
  'task_comments',
  'acceptance_criteria',
  'doc_change_proposals',
  'design_doc_changes',
  'task_runs',
  'task_leases',
  'design_notes',
  'task_contributions',
  'agent_profiles',
  'task_report_exports',
  'project_members',
  'external_subject_mappings',
  'task_candidates',
  'admission_snapshots',
  'candidate_gate_events',
  'task_mandates',
  'decisions',
  'decision_evidence',
  'decision_note_artifacts',
  'decision_relations',
  'decision_audit',
  'admission_snapshot_selected_decisions',
  'task_decision_links',
  'decision_note_sync_outbox',
  'migration_cutovers',
  'migration_audit_journal',
] as const

/** One table in the snapshot. */
export type TaskTable = typeof TASK_TABLES[number]

/** Tables whose INSERT/UPDATE/DELETE bump global_revision. */
export const TASK_REVISION_TABLES = [
  'projects',
  'tasks',
  'task_stages',
  'ideas',
  'task_relations',
  'task_events',
  'task_activities',
  'task_artifacts',
  'task_reports',
  'task_comments',
  'acceptance_criteria',
  'design_docs',
  'doc_change_proposals',
  'design_doc_changes',
  'agent_styles',
  'task_runs',
  'task_leases',
  'design_notes',
  'task_contributions',
  'agent_profiles',
  'task_report_exports',
  'project_members',
  'external_subject_mappings',
  'task_candidates',
  'admission_snapshots',
  'candidate_gate_events',
  'task_mandates',
  'decisions',
  'decision_evidence',
  'decision_note_artifacts',
  'decision_relations',
  'decision_audit',
  'admission_snapshot_selected_decisions',
  'task_decision_links',
  'decision_note_sync_outbox',
  'migration_cutovers',
  'migration_audit_journal',
] as const

/** Trigger-name prefix per revision table; task_stages keeps its legacy name. */
export const REVISION_TRIGGER_PREFIXES: Readonly<Record<typeof TASK_REVISION_TABLES[number], string>> = {
  projects: 'projects_rev_after_',
  tasks: 'tasks_rev_after_',
  task_stages: 'stages_rev_after_',
  ideas: 'ideas_rev_after_',
  task_relations: 'task_relations_rev_after_',
  task_events: 'task_events_rev_after_',
  task_activities: 'task_activities_rev_after_',
  task_artifacts: 'task_artifacts_rev_after_',
  task_reports: 'task_reports_rev_after_',
  task_comments: 'task_comments_rev_after_',
  acceptance_criteria: 'acceptance_criteria_rev_after_',
  design_docs: 'design_docs_rev_after_',
  doc_change_proposals: 'doc_change_proposals_rev_after_',
  design_doc_changes: 'design_doc_changes_rev_after_',
  agent_styles: 'agent_styles_rev_after_',
  task_runs: 'task_runs_rev_after_',
  task_leases: 'task_leases_rev_after_',
  design_notes: 'design_notes_rev_after_',
  task_contributions: 'task_contributions_rev_after_',
  agent_profiles: 'agent_profiles_rev_after_',
  task_report_exports: 'task_report_exports_rev_after_',
  project_members: 'project_members_rev_after_',
  external_subject_mappings: 'external_mappings_rev_after_',
  task_candidates: 'task_candidates_rev_after_',
  admission_snapshots: 'admission_snapshots_rev_after_',
  candidate_gate_events: 'candidate_gate_events_rev_after_',
  task_mandates: 'task_mandates_rev_after_',
  decisions: 'decisions_rev_after_',
  decision_evidence: 'decision_evidence_rev_after_',
  decision_note_artifacts: 'decision_note_artifacts_rev_after_',
  decision_relations: 'decision_relations_rev_after_',
  decision_audit: 'decision_audit_rev_after_',
  admission_snapshot_selected_decisions: 'snapshot_selected_decisions_rev_after_',
  task_decision_links: 'task_decision_links_rev_after_',
  decision_note_sync_outbox: 'decision_sync_outbox_rev_after_',
  migration_cutovers: 'migration_cutovers_rev_after_',
  migration_audit_journal: 'migration_journal_rev_after_',
}

/** Tables that never bump global_revision. */
export const TASK_NON_REVISION_TABLES = ['global_revision'] as const

/** Append-only tables: UPDATE and DELETE are rejected by triggers. */
export const APPEND_ONLY_TABLES = [
  'admission_snapshots',
  'candidate_gate_events',
  'decision_evidence',
  'decision_note_artifacts',
  'decision_audit',
  'admission_snapshot_selected_decisions',
  'migration_audit_journal',
] as const

/** Name of the recursive parent-cycle guard trigger. */
export const PARENT_CYCLE_TRIGGER = 'task_relations_prevent_parent_cycle'

/** Task relation and cache guards. */
export const TASK_RELATION_TRIGGERS = {
  insert: PARENT_CYCLE_TRIGGER,
  update: 'task_relations_prevent_update',
  afterInsert: 'task_relations_sync_parent_after_insert',
  afterDelete: 'task_relations_sync_parent_after_delete',
  taskInsertParent: 'tasks_prevent_parent_cache_insert',
  taskUpdateParent: 'tasks_prevent_parent_cache_update',
} as const

/** Identity and admission guards that are not revision triggers. */
export const BUSINESS_TRIGGER_NAMES = [
  'candidate_gate_events_require_matching_snapshot',
  'tasks_require_gated_candidate',
  TASK_RELATION_TRIGGERS.insert,
  'tasks_prevent_insert_or_replace',
  'tasks_prevent_project_move',
  'tasks_prevent_candidate_rebind',
  TASK_RELATION_TRIGGERS.taskInsertParent,
  TASK_RELATION_TRIGGERS.taskUpdateParent,
  TASK_RELATION_TRIGGERS.update,
  TASK_RELATION_TRIGGERS.afterInsert,
  TASK_RELATION_TRIGGERS.afterDelete,
  'task_candidates_require_gate_for_conversion',
  'task_candidates_require_selected_links_on_conversion',
  'task_decision_links_require_selected_decision',
  'decisions_prevent_invalid_status_transition',
  'decisions_prevent_implement_without_evidence',
  'decisions_freeze_approval_fields',
] as const

/** Trigger names for append-only UPDATE/DELETE rejection. */
export function appendOnlyTriggerNames(): string[] {
  const names: string[] = []
  for (const table of APPEND_ONLY_TABLES) {
    names.push(table + '_append_only_update', table + '_append_only_delete')
  }
  return names
}

/** One named index. */
export interface TaskIndex {
  readonly name: string
  readonly definition: string
}

/** Named indexes: the 24 legacy task-domain indexes plus 2 run guards. */
export const TASK_INDEXES: readonly TaskIndex[] = [
  { name: 'idx_tasks_project', definition: 'tasks(project_id)' },
  { name: 'idx_tasks_status', definition: 'tasks(status)' },
  { name: 'idx_tasks_thread', definition: 'tasks(thread_id)' },
  { name: 'idx_tasks_parent', definition: 'tasks(parent_task_id)' },
  { name: 'idx_stages_task', definition: 'task_stages(task_id)' },
  { name: 'idx_ideas_project', definition: 'ideas(project_id)' },
  { name: 'idx_ideas_status', definition: 'ideas(status)' },
  { name: 'idx_task_rel_source', definition: 'task_relations(source_task_id)' },
  { name: 'idx_task_rel_target', definition: 'task_relations(target_task_id)' },
  { name: 'idx_task_events_task', definition: 'task_events(task_id, created_at)' },
  { name: 'idx_task_activities_task', definition: 'task_activities(task_id, created_at)' },
  { name: 'idx_task_artifacts_task', definition: 'task_artifacts(task_id)' },
  { name: 'idx_task_reports_task', definition: 'task_reports(task_id, submitted_at DESC)' },
  { name: 'idx_task_comments_task', definition: 'task_comments(task_id, created_at)' },
  { name: 'idx_acceptance_task', definition: 'acceptance_criteria(task_id)' },
  { name: 'idx_design_docs_project', definition: 'design_docs(project_id)' },
  { name: 'idx_doc_proposals_task', definition: 'doc_change_proposals(task_id, status)' },
  { name: 'idx_doc_changes_doc', definition: 'design_doc_changes(doc_id, changed_at DESC)' },
  { name: 'idx_task_runs_task', definition: 'task_runs(task_id)' },
  { name: 'idx_task_leases_task_status', definition: 'task_leases(task_id, status, expires_at)' },
  { name: 'idx_task_leases_session', definition: 'task_leases(session_id, status)' },
  { name: 'idx_task_leases_one_active', definition: "UNIQUE task_leases(task_id) WHERE status = 'active'" },
  { name: 'idx_design_notes_task', definition: 'design_notes(task_id)' },
  { name: 'idx_design_notes_project', definition: 'design_notes(project_id)' },
  { name: 'idx_contributions_task', definition: 'task_contributions(task_id)' },
  { name: 'idx_contributions_agent', definition: 'task_contributions(agent_id)' },
  { name: 'idx_task_report_exports_report', definition: 'task_report_exports(report_id, exported_at DESC)' },
  {
    name: 'idx_ideas_capture',
    definition: "UNIQUE ideas(channel, source_system, source_ref, content_hash) WHERE channel IN ('connector','agent_extract')",
  },
  {
    name: 'idx_task_runs_one_active',
    definition: "UNIQUE task_runs(task_id) WHERE status IN ('pending','running')",
  },
  {
    name: 'idx_task_runs_idempotency',
    definition: 'UNIQUE task_runs(task_id, idempotency_key) WHERE idempotency_key IS NOT NULL',
  },
  { name: 'idx_tasks_candidate', definition: 'tasks(source_candidate_id)' },
  { name: 'idx_projects_ownership', definition: 'projects(ownership_state, updated_at DESC)' },
  { name: 'idx_task_rel_type_source', definition: 'task_relations(relation_type, source_task_id)' },
  {
    name: 'idx_task_rel_one_parent',
    definition: "UNIQUE task_relations(source_task_id) WHERE relation_type = 'parent'",
  },
  { name: 'idx_project_members_project', definition: 'project_members(project_id, revoked_at)' },
  { name: 'idx_external_mappings_principal', definition: 'external_subject_mappings(principal_type, principal_id)' },
  { name: 'idx_candidates_project_status', definition: 'task_candidates(project_id, status, updated_at DESC)' },
  { name: 'idx_candidates_source', definition: 'task_candidates(source_type, source_system, source_ref)' },
  { name: 'idx_snapshots_candidate_version', definition: 'admission_snapshots(candidate_id, candidate_version DESC)' },
  { name: 'idx_gate_candidate_version', definition: 'candidate_gate_events(candidate_id, candidate_version DESC)' },
  { name: 'idx_mandates_task_status', definition: 'task_mandates(task_id, status)' },
  { name: 'idx_decisions_project_status', definition: 'decisions(project_id, status, decision_key)' },
  { name: 'idx_decisions_authority_key', definition: 'decisions(authority_scope, authority_level, project_id)' },
  {
    name: 'idx_decisions_authoritative',
    definition: "UNIQUE decisions(project_id, workspace_id, repository_ref, subject_type, subject_id, authority_scope, environment, branch_key, rollout_key, tenant_key, region_key, decision_key) WHERE status = 'implemented'",
  },
  { name: 'idx_gate_idempotency', definition: 'UNIQUE candidate_gate_events(candidate_id, idempotency_key)' },
  {
    name: 'idx_gate_one_approve',
    definition: "UNIQUE candidate_gate_events(candidate_id, candidate_version) WHERE action = 'approve'",
  },
  { name: 'idx_decision_evidence_decision', definition: 'decision_evidence(decision_id, created_at)' },
  { name: 'idx_decision_artifacts_decision', definition: 'decision_note_artifacts(decision_id, decision_version DESC)' },
  { name: 'idx_decision_relations_source', definition: 'decision_relations(source_decision_id)' },
  { name: 'idx_decision_relations_target', definition: 'decision_relations(target_decision_id)' },
  { name: 'idx_decision_audit_decision', definition: 'decision_audit(decision_id, created_at DESC)' },
  { name: 'idx_selected_decisions_snapshot', definition: 'admission_snapshot_selected_decisions(snapshot_id, collection_type, selected_rank)' },
  {
    name: 'idx_task_decision_links_one_active',
    definition: 'UNIQUE task_decision_links(task_id, decision_id) WHERE active = 1',
  },
  { name: 'idx_task_decision_links_snapshot', definition: 'task_decision_links(admission_snapshot_id, active)' },
  { name: 'idx_decision_outbox_status', definition: 'decision_note_sync_outbox(job_status, available_at)' },
  { name: 'idx_migration_journal_cutover', definition: 'migration_audit_journal(cutover_id, created_at)' },
]

/** One HTTP route in the migrated surface. */
export interface TaskRoute {
  readonly method: 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'PUT'
  readonly path: string
}

const route = (method: TaskRoute['method'], path: string): TaskRoute => ({ method, path })

/** The 45 migrated routes, in registration order (static paths precede dynamic ids). */
export const TASK_MIGRATED_ROUTES: readonly TaskRoute[] = [
  route('POST', '/api/agentops/candidates'),
  route('POST', '/api/agentops/candidates/{candidate_id}/analyze'),
  route('POST', '/api/agentops/candidates/{candidate_id}/preflight-search'),
  route('POST', '/api/agentops/candidates/{candidate_id}/gate'),
  route('GET', '/api/agentops/candidates/{candidate_id}'),
  route('GET', '/api/agentops/decisions/search'),
  route('POST', '/api/agentops/decisions'),
  route('GET', '/api/agentops/decisions/{decision_id}'),
  route('POST', '/api/agentops/decisions/{decision_id}/revise'),
  route('POST', '/api/agentops/decisions/{decision_id}/implement'),
  route('POST', '/api/agentops/decisions/{decision_id}/reject'),
  route('POST', '/api/agentops/decisions/{decision_id}/archive'),
  route('POST', '/api/agentops/decisions/{decision_id}/supersede'),
  route('GET', '/api/agentops/tasks/projects'),
  route('GET', '/api/agentops/tasks/workspaces'),
  route('POST', '/api/agentops/tasks/projects'),
  route('GET', '/api/agentops/tasks/ideas'),
  route('POST', '/api/agentops/tasks/ideas'),
  route('GET', '/api/agentops/tasks/relations'),
  route('POST', '/api/agentops/tasks/relations'),
  route('GET', '/api/agentops/tasks/proposals'),
  route('GET', '/api/agentops/tasks/revision'),
  route('GET', '/api/agentops/tasks'),
  route('GET', '/api/agentops/tasks/search'),
  route('GET', '/api/agentops/tasks/graph'),
  route('GET', '/api/agentops/tasks/dashboard'),
  route('POST', '/api/agentops/tasks'),
  route('GET', '/api/agentops/tasks/{task_id}'),
  route('PATCH', '/api/agentops/tasks/{task_id}'),
  route('POST', '/api/agentops/tasks/{task_id}/advance'),
  route('GET', '/api/agentops/tasks/{task_id}/transitions'),
  route('POST', '/api/agentops/tasks/{task_id}/claim'),
  route('POST', '/api/agentops/tasks/{task_id}/rollback'),
  route('POST', '/api/agentops/tasks/{task_id}/close'),
  route('GET', '/api/agentops/tasks/{task_id}/reports'),
  route('POST', '/api/agentops/tasks/{task_id}/reports'),
  route('POST', '/api/agentops/tasks/{task_id}/reports/{report_id}/export'),
  route('GET', '/api/agentops/tasks/{task_id}/reports/{report_id}/export'),
  route('GET', '/api/agentops/tasks/{task_id}/reports/{report_id}/exports'),
  route('POST', '/api/agentops/tasks/{task_id}/reports/{report_id}/review'),
  route('POST', '/api/agentops/tasks/{task_id}/design-notes/{note_id}/status'),
  route('GET', '/api/agentops/tasks/{task_id}/comments'),
  route('POST', '/api/agentops/tasks/{task_id}/comments'),
  route('GET', '/api/agentops/tasks/{task_id}/relations'),
  route('GET', '/api/agentops/tasks/{task_id}/runs'),
  route('GET', '/api/agentops/tasks/{task_id}/leases'),
  route('POST', '/api/agentops/tasks/{task_id}/leases/{lease_id}/heartbeat'),
  route('POST', '/api/agentops/tasks/{task_id}/leases/{lease_id}/release'),
  route('POST', '/api/agentops/tasks/{task_id}/runs/{run_id}/finish'),
  route('POST', '/api/agentops/tasks/{task_id}/execute'),
  route('GET', '/api/agentops/tasks/{task_id}/criteria'),
  route('POST', '/api/agentops/tasks/{task_id}/criteria'),
  route('POST', '/api/agentops/tasks/{task_id}/criteria/{criterion_id}/status'),
  route('POST', '/api/agentops/tasks/{task_id}/ideas/{idea_id}/confirm'),
  route('POST', '/api/agentops/tasks/{task_id}/ideas/{idea_id}/convert'),
  route('POST', '/api/agentops/tasks/proposals/{proposal_id}/apply'),
  route('GET', '/api/agentops/tasks/{task_id}/activities'),
  route('GET', '/api/agentops/tasks/{task_id}/artifacts'),
]

/** Canonical inbox routes that do not repeat `{task_id}`. */
export const TASK_CANONICAL_ROUTES: readonly TaskRoute[] = [
  route('POST', '/api/agentops/tasks/ideas/{idea_id}/confirm'),
  route('POST', '/api/agentops/tasks/ideas/{idea_id}/convert'),
  route('POST', '/api/agentops/tasks/ideas/{idea_id}/triage'),
  route('GET', '/api/agentops/tasks/activities'),
]

/** One lifecycle edge in the snapshot. */
export interface LifecycleEdge {
  readonly from: string
  readonly to: string
  readonly action: string
  readonly requiresUser: boolean
}

/** The complete machine-readable snapshot. */
export interface TaskContractSnapshot {
  readonly contractVersion: number
  readonly tables: readonly string[]
  readonly revisionTables: readonly string[]
  readonly nonRevisionTables: readonly string[]
  readonly triggerPrefixes: Readonly<Record<string, string>>
  readonly triggers: readonly string[]
  readonly indexes: readonly TaskIndex[]
  readonly routes: readonly TaskRoute[]
  readonly canonicalRoutes: readonly TaskRoute[]
  readonly p0: {
    readonly statuses: readonly string[]
    readonly edges: readonly LifecycleEdge[]
    readonly terminal: readonly string[]
  }
  readonly v1: {
    readonly statuses: readonly string[]
    readonly edges: readonly LifecycleEdge[]
    readonly terminal: readonly string[]
  }
  readonly counts: {
    readonly tables: number
    readonly revisionTables: number
    readonly indexes: number
    readonly triggers: number
    readonly routes: number
    readonly canonicalRoutes: number
    readonly p0Edges: number
    readonly v1Edges: number
  }
}

/**
 * Every revision trigger name: three per revision table plus the cycle guard.
 * @returns trigger names in stable table order.
 */
export function revisionTriggerNames(): string[] {
  const names: string[] = []
  for (const table of TASK_REVISION_TABLES) {
    const prefix = REVISION_TRIGGER_PREFIXES[table]
    names.push(`${prefix}insert`, `${prefix}update`, `${prefix}delete`)
  }
  names.push(...appendOnlyTriggerNames(), ...BUSINESS_TRIGGER_NAMES)
  return names
}

const toEdges = (edges: readonly { from: string; to: string; action: string; requiresUser: boolean }[]): LifecycleEdge[] =>
  edges.map(edge => ({ from: edge.from, to: edge.to, action: edge.action, requiresUser: edge.requiresUser }))

/**
 * Build the snapshot. Derived counts are computed here so the artifact and the
 * tests share one definition.
 * @returns the complete contract snapshot.
 */
export function buildTaskContractSnapshot(): TaskContractSnapshot {
  const triggers = revisionTriggerNames()
  const p0Edges = toEdges(P0_TRANSITIONS)
  const v1Edges = toEdges(TRANSITIONS)
  return {
    contractVersion: TASK_CONTRACT_VERSION,
    tables: [...TASK_TABLES],
    revisionTables: [...TASK_REVISION_TABLES],
    nonRevisionTables: [...TASK_NON_REVISION_TABLES],
    triggerPrefixes: { ...REVISION_TRIGGER_PREFIXES },
    triggers,
    indexes: TASK_INDEXES.map(index => ({ ...index })),
    routes: TASK_MIGRATED_ROUTES.map(item => ({ ...item })),
    canonicalRoutes: TASK_CANONICAL_ROUTES.map(item => ({ ...item })),
    p0: { statuses: [...P0_STATUSES], edges: p0Edges, terminal: [...P0_TERMINAL].sort() },
    v1: {
      statuses: [...TASK_STATUSES],
      edges: v1Edges,
      terminal: [...TERMINAL].sort(),
    },
    counts: {
      tables: TASK_TABLES.length,
      revisionTables: TASK_REVISION_TABLES.length,
      indexes: TASK_INDEXES.length,
      triggers: triggers.length,
      routes: TASK_MIGRATED_ROUTES.length,
      canonicalRoutes: TASK_CANONICAL_ROUTES.length,
      p0Edges: p0Edges.length,
      v1Edges: v1Edges.length,
    },
  }
}
