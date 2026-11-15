/**
 * `TaskService` — the only writer for task state.
 *
 * Every mutation runs in one `BEGIN IMMEDIATE` transaction and follows the same
 * order: read the row, check `if_version`, check the lifecycle edge for that
 * task's mode, apply the business rule, bump the row version, append the event,
 * commit. Callers get a typed `TaskServiceError` instead of a partially applied
 * change, and `global_revision` moves once per committed mutation through the
 * schema triggers.
 *
 * The service deliberately does not open files or create schemas: the caller
 * opens a database at `SCHEMA_VERSION` (see `schema.ts`) and passes the handle.
 *
 * @module @agentops/dsh-task/service
 */

import { realpathSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

import { P0_STATUSES, P0_TERMINAL, P0_TRANSITIONS } from './lifecycle/p0.ts'
import { assertSchemaVersion } from './schema.ts'
import { TASK_STATUSES, TERMINAL, TRANSITIONS } from './status.ts'

/** Who performed a mutation; only `user` may satisfy a `requires_user` edge. */
export type ActorType = 'user' | 'agent'

/** The acting identity recorded on events. */
export interface Actor {
  readonly type: ActorType
  readonly id?: string
  readonly name?: string
}

/** Stable error codes; the HTTP layer maps them to status codes. */
export type TaskServiceErrorCode =
  | 'task_not_found'
  | 'project_not_found'
  | 'candidate_not_found'
  | 'decision_not_found'
  | 'version_conflict'
  | 'invalid_transition'
  | 'user_approval_required'
  | 'admission_required'
  | 'candidate_state_conflict'
  | 'admission_snapshot_invalid'
  | 'decision_validation_failed'
  | 'thread_conflict'
  | 'close_blocked'
  | 'invalid_request'
  | 'report_not_found'
  | 'relation_cycle'
  | 'active_run_conflict'
  | 'workspace_invalid'
  | 'workspace_not_bound'
  | 'workspace_context_mismatch'
  | 'project_not_active'
  | 'project_has_active_tasks'
  | 'execution_scope_missing'
  | 'no_capable_agent'
  | 'lease_not_found'
  | 'lease_conflict'
  | 'lease_expired'
  | 'rollback_failed'
  | 'exporter_unavailable'

/** One rejected mutation, with the details a caller needs to recover. */
export class TaskServiceError extends Error {
  /**
   * @param code - stable error code.
   * @param message - human-readable English message.
   * @param details - machine-readable context (latest row, blockers, ...).
   * @param httpStatus - status code the HTTP layer must use.
   */
  constructor(
    readonly code: TaskServiceErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {},
    readonly httpStatus = 400,
  ) {
    super(message)
    this.name = 'TaskServiceError'
  }
}

/** One stored task as the service returns it. */
export interface TaskRecord {
  readonly taskId: string
  readonly projectId: string
  readonly sourceCandidateId: string
  readonly ownerUserId: string
  readonly mandateId: string | null
  readonly workspaceId: string | null
  readonly repositoryRef: string | null
  readonly branchRef: string | null
  readonly lifecycleMode: 'p0' | 'v1'
  readonly title: string
  readonly description: string
  readonly status: string
  readonly taskType: string
  readonly riskLevel: string
  readonly parentTaskId: string | null
  readonly threadId: string | null
  readonly assigneeName: string | null
  readonly version: number
  readonly createdAt: string
  readonly updatedAt: string
  readonly closedAt: string | null
}

/** One allowed next action for a task. */
export interface AllowedTransition {
  readonly to: string
  readonly action: string
  readonly requiresUser: boolean
}

/** One stored project with its execution workspace. */
export interface ProjectRecord {
  readonly projectId: string
  readonly name: string
  readonly type: 'code' | 'knowledge' | 'hybrid'
  readonly localPath: string | null
  readonly githubUrl: string | null
  readonly feishuDocToken: string | null
  readonly workspaceId: string | null
  readonly ownershipState: 'active' | 'ownership_pending'
  readonly version: number
  readonly createdAt: string
  readonly updatedAt: string
}

/** Input for changing only a project's execution workspace binding. */
export interface RebindProjectInput {
  readonly projectId: string
  readonly ifVersion: number
  readonly workspaceId?: string
  readonly localPath?: string
  readonly actor: Actor
}

/** The resolved execution workspace for one task. */
export interface TaskExecutionContext {
  readonly taskId: string
  readonly projectId: string
  readonly workspaceId: string
  readonly localPath: string | null
  readonly workspaceSource: 'workspace_id' | 'local_path'
  readonly ownershipState: 'active' | 'ownership_pending'
  readonly scopeId: string
  readonly workspaceBound: boolean
  readonly executionBackend: 'dsh_native' | 'codex' | 'claude_code' | 'auto'
}

/** Candidate lifecycle states from the admission design. */
export type CandidateStatus =
  | 'captured'
  | 'analyzing'
  | 'awaiting_gate'
  | 'converted'
  | 'rejected'
  | 'deferred'
  | 'merged'

/** Accepted provenance classes for a Candidate. */
export type CandidateSourceType = 'manual' | 'idea' | 'agent' | 'connector' | 'external' | 'legacy_task'

/** One Candidate as returned by the service. */
export interface CandidateRecord {
  readonly candidateId: string
  readonly sourceIdeaId: string | null
  readonly sourceType: CandidateSourceType
  readonly sourceSystem: string
  readonly sourceRef: string
  readonly projectId: string
  readonly workspaceId: string
  readonly repositoryRef: string
  readonly branchRef: string
  readonly title: string
  readonly description: string
  readonly status: CandidateStatus
  readonly analysisProblem: string
  readonly analysisNonGoals: string
  readonly analysisDeliverables: string
  readonly acceptanceCriteria: readonly unknown[]
  readonly dependencies: readonly unknown[]
  readonly riskLevel: 'low' | 'medium' | 'high'
  readonly riskReason: string
  readonly complexity: 'simple' | 'medium' | 'complex'
  readonly ownerUserId: string
  readonly proposedAssignee: string
  readonly mandateScope: Record<string, unknown>
  readonly decisionChangeRequired: boolean
  readonly admissionSnapshotId: string | null
  readonly admissionSnapshotHash: string | null
  readonly convertedTaskId: string | null
  readonly latestGateEventId: string | null
  readonly deferredUntil: string
  readonly deferReason: string
  readonly version: number
  readonly createdAt: string
  readonly updatedAt: string
}

/** One immutable admission snapshot as returned by the service. */
export interface AdmissionSnapshotRecord {
  readonly snapshotId: string
  readonly candidateId: string
  readonly candidateVersion: number
  readonly projectId: string
  readonly searchQuery: unknown
  readonly searchCoverage: unknown
  readonly activeWork: readonly unknown[]
  readonly proposedDecisions: readonly unknown[]
  readonly authoritativeDecisions: readonly unknown[]
  readonly historicalDecisions: readonly unknown[]
  readonly selectedDecisionIds: readonly string[]
  readonly decisionLinkCount: number
  readonly conflicts: readonly unknown[]
  readonly requiredActions: readonly unknown[]
  readonly residualRisk: string
  readonly snapshotVersion: number
  readonly snapshotHash: string
  readonly createdBy: string
  readonly createdAt: string
}

/** Input for capturing a Candidate before analysis. */
export interface CaptureCandidateInput {
  readonly projectId: string
  readonly title: string
  readonly description?: string
  readonly sourceType?: CandidateSourceType
  readonly sourceSystem?: string
  readonly sourceRef?: string
  readonly sourceIdeaId?: string | null
  readonly workspaceId?: string
  readonly repositoryRef?: string
  readonly branchRef?: string
  readonly ownerUserId?: string
  readonly proposedAssignee?: string
  readonly mandateScope?: Record<string, unknown>
  readonly riskLevel?: 'low' | 'medium' | 'high'
  readonly riskReason?: string
  readonly complexity?: 'simple' | 'medium' | 'complex'
  readonly decisionChangeRequired?: boolean
  readonly candidateId?: string
  readonly actor: Actor
}

/** Structured analysis input for a Candidate. */
export interface AnalyzeCandidateInput {
  readonly candidateId: string
  readonly ifVersion: number
  readonly actor: Actor
  readonly title?: string
  readonly description?: string
  readonly analysisProblem?: string
  readonly analysisNonGoals?: string
  readonly analysisDeliverables?: string
  readonly acceptanceCriteria?: readonly unknown[]
  readonly dependencies?: readonly unknown[]
  readonly riskLevel?: 'low' | 'medium' | 'high'
  readonly riskReason?: string
  readonly complexity?: 'simple' | 'medium' | 'complex'
  readonly ownerUserId?: string
  readonly proposedAssignee?: string
  readonly mandateScope?: Record<string, unknown>
  readonly decisionChangeRequired?: boolean
}

/** Input for recording an immutable preflight search snapshot. */
export interface CreateAdmissionSnapshotInput {
  readonly candidateId: string
  readonly ifVersion: number
  readonly query: unknown
  readonly searchCoverage: 'complete' | 'partial' | 'failed'
  readonly activeWork?: readonly Record<string, unknown>[]
  readonly proposedDecisionIds?: readonly string[]
  readonly authoritativeDecisionIds?: readonly string[]
  readonly historicalDecisionIds?: readonly string[]
  readonly selectedDecisionIds?: readonly string[]
  readonly conflicts?: readonly Record<string, unknown>[]
  readonly requiredActions?: readonly string[]
  readonly residualRisk?: string
  readonly actor: Actor
}

/** Input for the only public Task creation path: an approved Candidate gate. */
export interface ApprovedCandidateGateInput {
  readonly candidateId: string
  readonly ifVersion: number
  readonly actor: Actor
  readonly idempotencyKey?: string
  readonly taskType?: 'code' | 'knowledge' | 'design' | 'hybrid'
  /** Internal/test compatibility only; HTTP callers always admit V1 tasks. */
  readonly lifecycleMode?: 'p0' | 'v1'
}

/** Result of one Candidate admission transaction. */
export interface CandidateAdmissionResult {
  readonly candidate: CandidateRecord
  readonly snapshot: AdmissionSnapshotRecord
  readonly gateEventId: string
  readonly task: TaskRecord
  readonly mandateId: string
  readonly decisionLinkIds: readonly string[]
}

/** The four persisted Decision lifecycle states. */
export type DecisionStatus = 'proposed' | 'implemented' | 'rejected' | 'archived'

/** Authority scopes a Decision can constrain. */
export type DecisionAuthorityScope = 'project' | 'workspace' | 'repository' | 'branch' | 'environment' | 'task'

/** Strength of a Decision's authority. */
export type DecisionAuthorityLevel = 'hard_constraint' | 'policy' | 'implementation' | 'local_default'

/** Subject classes a Decision can address. */
export type DecisionSubjectType = 'project' | 'task' | 'module' | 'service' | 'api' | 'process' | 'data' | 'security'

/** DSH note classes accepted for the file projection. */
export type DecisionNoteClass = 'feature' | 'bug-fix' | 'simplification' | 'architecture' | 'process' | 'testing'

/** Reasons an implemented Decision may enter `archived`. */
export type DecisionArchiveReason = 'superseded' | 'invalidated' | 'obsolete' | 'project_archived'

/** Evidence kinds accepted for a Decision. */
export type DecisionEvidenceKind = 'pull_request' | 'commit' | 'deployment' | 'document' | 'approval' | 'test' | 'manual'

/** One evidence record supplied with a Decision command. */
export interface DecisionEvidenceInput {
  readonly kind: DecisionEvidenceKind
  readonly ref: string
  readonly contentHash?: string
}

/** One stored Decision evidence row. */
export interface DecisionEvidenceRecord {
  readonly evidenceId: string
  readonly decisionId: string
  readonly kind: DecisionEvidenceKind
  readonly ref: string
  readonly verifiedBy: string
  readonly verifiedAt: string
  readonly contentHash: string
  readonly createdAt: string
}

/** One stored Decision relation row. */
export interface DecisionRelationRecord {
  readonly relationId: string
  readonly sourceDecisionId: string
  readonly targetDecisionId: string
  readonly relationType: 'supersedes' | 'amends' | 'conflicts_with' | 'related'
  readonly evidenceRef: string
  readonly createdBy: string
  readonly createdAt: string
}

/** One stored immutable Decision audit row. */
export interface DecisionAuditRecord {
  readonly auditId: string
  readonly decisionId: string
  readonly eventType: string
  readonly actorType: 'user' | 'agent' | 'service'
  readonly actorId: string
  readonly decisionVersion: number
  readonly candidateGateEventId: string | null
  readonly payload: Record<string, unknown>
  readonly createdAt: string
}

/** One Decision as returned by list/search commands. */
export interface DecisionRecord {
  readonly decisionId: string
  readonly projectId: string
  readonly workspaceId: string
  readonly repositoryRef: string
  readonly decisionKey: string
  readonly title: string
  readonly status: DecisionStatus
  readonly subjectType: DecisionSubjectType
  readonly subjectId: string
  readonly authorityScope: DecisionAuthorityScope
  readonly authorityLevel: DecisionAuthorityLevel
  readonly relaxesDecisionId: string | null
  readonly relaxesEvidenceId: string | null
  readonly environment: string
  readonly branchKey: string
  readonly rolloutKey: string
  readonly tenantKey: string
  readonly regionKey: string
  readonly problem: string
  readonly proposal: string
  readonly rationale: string
  readonly alternatives: string
  readonly acceptanceCriteria: string
  readonly proposedBy: string
  readonly proposedAt: string
  readonly approvedBy: string
  readonly approvedAt: string
  readonly effectiveFrom: string
  readonly effectiveTo: string
  readonly rejectReason: string
  readonly archiveReason: string
  readonly predecessorId: string | null
  readonly supersedesId: string | null
  readonly sourceTaskId: string | null
  readonly sourceCandidateId: string | null
  readonly sourceRun: string
  readonly notePath: string
  readonly noteClass: DecisionNoteClass
  readonly noteDate: string
  readonly contentHash: string
  readonly baseContentHash: string
  readonly syncState: string
  readonly version: number
  readonly createdAt: string
  readonly updatedAt: string
}

/** One Decision plus its immutable evidence, relations and audit trail. */
export interface DecisionDetail {
  readonly decision: DecisionRecord
  readonly evidence: readonly DecisionEvidenceRecord[]
  readonly relations: readonly DecisionRelationRecord[]
  readonly audit: readonly DecisionAuditRecord[]
}

/** Input for proposing a new Decision. */
export interface ProposeDecisionInput {
  readonly decisionId?: string
  readonly projectId: string
  readonly workspaceId?: string
  readonly repositoryRef?: string
  readonly decisionKey: string
  readonly title: string
  readonly subjectType: DecisionSubjectType
  readonly subjectId?: string
  readonly authorityScope: DecisionAuthorityScope
  readonly authorityLevel: DecisionAuthorityLevel
  readonly relaxesDecisionId?: string
  readonly relaxesEvidenceId?: string
  readonly environment?: string
  readonly branchKey?: string
  readonly rolloutKey?: string
  readonly tenantKey?: string
  readonly regionKey?: string
  readonly problem: string
  readonly proposal: string
  readonly rationale: string
  readonly alternatives?: string
  readonly acceptanceCriteria?: string
  readonly predecessorId?: string
  readonly supersedesId?: string
  readonly sourceTaskId?: string
  readonly sourceCandidateId?: string
  readonly sourceRun?: string
  readonly notePath?: string
  readonly noteClass: DecisionNoteClass
  readonly noteDate?: string
  readonly contentHash?: string
  readonly baseContentHash?: string
  readonly evidence?: readonly DecisionEvidenceInput[]
  readonly actor: Actor
}

/** Editable fields on a proposed Decision. */
export interface ReviseDecisionInput {
  readonly decisionId: string
  readonly ifVersion: number
  readonly actor: Actor
  readonly workspaceId?: string
  readonly repositoryRef?: string
  readonly decisionKey?: string
  readonly title?: string
  readonly subjectType?: DecisionSubjectType
  readonly subjectId?: string
  readonly authorityScope?: DecisionAuthorityScope
  readonly authorityLevel?: DecisionAuthorityLevel
  readonly relaxesDecisionId?: string | null
  readonly relaxesEvidenceId?: string | null
  readonly environment?: string
  readonly branchKey?: string
  readonly rolloutKey?: string
  readonly tenantKey?: string
  readonly regionKey?: string
  readonly problem?: string
  readonly proposal?: string
  readonly rationale?: string
  readonly alternatives?: string
  readonly acceptanceCriteria?: string
  readonly predecessorId?: string | null
  readonly supersedesId?: string | null
  readonly sourceTaskId?: string | null
  readonly sourceCandidateId?: string | null
  readonly sourceRun?: string
  readonly notePath?: string
  readonly noteClass?: DecisionNoteClass
  readonly noteDate?: string
  readonly contentHash?: string
  readonly baseContentHash?: string
  readonly evidence?: readonly DecisionEvidenceInput[]
}

/** Input for implementing a proposed Decision. */
export interface ImplementDecisionInput {
  readonly decisionId: string
  readonly ifVersion: number
  readonly actor: Actor
  readonly effectiveFrom?: string
  readonly evidence: readonly DecisionEvidenceInput[]
}

/** Input for rejecting a proposed Decision. */
export interface RejectDecisionInput {
  readonly decisionId: string
  readonly ifVersion: number
  readonly actor: Actor
  readonly reason: string
}

/** Input for archiving an implemented Decision. */
export interface ArchiveDecisionInput {
  readonly decisionId: string
  readonly ifVersion: number
  readonly actor: Actor
  readonly reason: DecisionArchiveReason
}

/** Input for superseding one Decision with an existing proposal. */
export interface SupersedeDecisionInput {
  readonly decisionId: string
  readonly ifVersion: number
  readonly actor: Actor
  readonly successorDecisionId: string
}

/** Optional filters for Decision search. */
export interface SearchDecisionsInput {
  readonly projectId: string
  readonly q?: string
  readonly collection?: 'proposed' | 'authoritative' | 'historical' | 'all'
  readonly status?: DecisionStatus
  readonly authorityScope?: DecisionAuthorityScope
  readonly authorityLevel?: DecisionAuthorityLevel
  readonly subjectType?: DecisionSubjectType
  readonly subjectId?: string
  readonly decisionKey?: string
  readonly limit?: number
}

/** Result of a Decision search. */
export interface DecisionSearchResult {
  readonly decisions: readonly DecisionRecord[]
  readonly total: number
  readonly searchCoverage: 'partial'
}

/** Task plus its allowed actions. */
export interface TaskDetail {
  readonly task: TaskRecord
  readonly allowed: readonly AllowedTransition[]
  readonly comments: readonly CommentRecord[]
  readonly criteria: readonly CriteriaRecord[]
  readonly reports: readonly ReportRecord[]
}

/** Input for creating a project. */
export interface CreateProjectInput {
  readonly name: string
  readonly type?: 'code' | 'knowledge' | 'hybrid'
  readonly projectId?: string
  readonly workspaceId?: string
  readonly localPath?: string
  readonly githubUrl?: string
  readonly branchRef?: string
  readonly feishuDocToken?: string
  readonly actor?: Actor
}

/** Input for creating a task. */
export interface CreateTaskInput {
  readonly projectId: string
  readonly title: string
  readonly description?: string
  readonly lifecycleMode?: 'p0' | 'v1'
  readonly status?: string
  readonly taskType?: string
  readonly riskLevel?: 'low' | 'medium' | 'high'
  readonly parentTaskId?: string | null
  readonly threadId?: string | null
  readonly taskId?: string
  readonly actor?: Actor
}

/** Input shared by every state-changing command. */
export interface MutationInput {
  readonly taskId: string
  readonly ifVersion: number
  readonly actor: Actor
}

/** Comment kinds accepted by {@link TaskService.addComment}. */
export type CommentType = 'report' | 'review' | 'discussion'

/** Review decisions accepted on a report. */
export type ReportDecision = 'approve' | 'request_changes'

/** Roles a comment may mention. */
export const MENTION_TARGETS = ['coding_agent', 'task_planner', 'quality_inspector', 'task_conductor'] as const

/** One mentionable role. */
export type MentionTarget = typeof MENTION_TARGETS[number]

/** Editable task fields; anything else is rejected by {@link TaskService.updateTask}. */
export interface TaskPatch {
  readonly title?: string
  readonly description?: string | null
  readonly task_type?: string
  readonly risk_level?: 'low' | 'medium' | 'high'
  readonly assignee_name?: string | null
  readonly sort_order?: number
  readonly style_id?: string | null
  readonly parent_task_id?: string | null
}

/** One stored comment. */
export interface CommentRecord {
  readonly commentId: string
  readonly taskId: string
  readonly reportId: string | null
  readonly commentType: string
  readonly decision: string | null
  readonly body: string
  readonly authorName: string | null
  readonly createdAt: string
}

/** One stored acceptance criterion. */
export interface CriteriaRecord {
  readonly criteriaId: string
  readonly taskId: string
  readonly description: string
  readonly checkType: string
  readonly status: string
  readonly checkedAt: string | null
}

/** One stored report. */
export interface ReportRecord {
  readonly reportId: string
  readonly taskId: string
  readonly agentId: string | null
  readonly sessionId: string | null
  readonly content: string
  readonly artifactIds: readonly string[] | null
  readonly acceptanceSelfCheck: Record<string, unknown> | null
  readonly status: string
  readonly version: number
  readonly submittedAt: string
}

/** One execution binding. */
export interface RunRecord {
  readonly linkId: string
  readonly taskId: string
  readonly runId: string | null
  readonly sessionId: string | null
  readonly role: string
  readonly status: string
  readonly idempotencyKey: string | null
  readonly linkedAt: string
}

/** One active or historical execution lease. */
export interface LeaseRecord {
  readonly leaseId: string
  readonly taskId: string
  readonly linkId: string
  readonly holderType: 'agent' | 'session' | 'service'
  readonly holderId: string
  readonly sessionId: string
  readonly leaseToken: string
  readonly authorityEpoch: number
  readonly status: 'active' | 'released' | 'expired' | 'revoked'
  readonly acquiredAt: string
  readonly heartbeatAt: string
  readonly expiresAt: string
  readonly releasedAt: string
  readonly version: number
}

/** A run plus the lease acquired with it. */
export interface ExecutionRunRecord extends RunRecord {
  readonly lease: LeaseRecord
}

/** One design-document change proposal. */
export interface DesignProposalRecord {
  readonly proposalId: string
  readonly docId: string
  readonly taskId: string
  readonly changeType: string
  readonly status: string
  readonly version: number
  readonly appliedAt: string | null
}

/** One design note. */
export interface DesignNoteRecord {
  readonly noteId: string
  readonly taskId: string
  readonly projectId: string
  readonly status: string
  readonly content: string
  readonly version: number
}

/** One inbox record. */
export interface IdeaRecord {
  readonly ideaId: string
  readonly projectId: string | null
  readonly channel: string
  readonly sourceSystem: string | null
  readonly kind: string
  readonly title: string | null
  readonly content: string
  readonly status: string
  readonly revision: number
  readonly convertedTaskId: string | null
  readonly convertedIdeaId: string | null
  readonly sourceRef: string | null
  readonly createdAt: string
  readonly version: number
}

interface DesignProposalRow {
  proposal_id: string
  doc_id: string
  task_id: string
  change_type: string
  status: string
  version: number
  applied_at: string | null
  section_path: string | null
  old_content_hash: string | null
  new_content: string | null
}

interface DesignNoteRow {
  note_id: string
  task_id: string
  project_id: string
  status: string
  content: string
  version: number
}

interface IdeaRow {
  idea_id: string
  project_id: string | null
  channel: string
  source_system: string | null
  kind: string
  title: string | null
  content: string
  status: string
  revision: number
  converted_task_id: string | null
  converted_idea_id: string | null
  source_ref: string | null
  created_at: string
  version: number
}

interface CandidateRow {
  candidate_id: string
  source_idea_id: string | null
  source_type: CandidateSourceType
  source_system: string
  source_ref: string
  project_id: string
  workspace_id: string
  repository_ref: string
  branch_ref: string
  title: string
  description: string
  status: CandidateStatus
  analysis_problem: string
  analysis_non_goals: string
  analysis_deliverables: string
  acceptance_criteria_json: string
  dependencies_json: string
  risk_level: 'low' | 'medium' | 'high'
  risk_reason: string
  complexity: 'simple' | 'medium' | 'complex'
  owner_user_id: string
  proposed_assignee: string
  mandate_scope_json: string
  decision_change_required: number
  admission_snapshot_id: string | null
  admission_snapshot_hash: string
  converted_task_id: string | null
  latest_gate_event_id: string | null
  deferred_until: string
  defer_reason: string
  version: number
  created_at: string
  updated_at: string
}

interface AdmissionSnapshotRow {
  snapshot_id: string
  candidate_id: string
  candidate_version: number
  project_id: string
  search_query_json: string
  search_coverage_json: string
  active_work_json: string
  proposed_decisions_json: string
  authoritative_decisions_json: string
  historical_decisions_json: string
  selected_decision_ids_json: string
  decision_link_count: number
  conflicts_json: string
  required_actions_json: string
  residual_risk: string
  snapshot_version: number
  canonical_json: string
  snapshot_hash: string
  created_by: string
  created_at: string
}

interface DecisionRow {
  decision_id: string
  project_id: string
  workspace_id: string
  repository_ref: string
  decision_key: string
  title: string
  status: DecisionStatus
  subject_type: DecisionSubjectType
  subject_id: string
  authority_scope: DecisionAuthorityScope
  authority_level: DecisionAuthorityLevel
  relaxes_decision_id: string | null
  relaxes_evidence_id: string | null
  environment: string
  branch_key: string
  rollout_key: string
  tenant_key: string
  region_key: string
  problem: string
  proposal: string
  rationale: string
  alternatives: string
  acceptance_criteria: string
  proposed_by: string
  proposed_at: string
  approved_by: string
  approved_at: string
  effective_from: string
  effective_to: string
  reject_reason: string
  archive_reason: string
  predecessor_id: string | null
  supersedes_id: string | null
  source_task_id: string | null
  source_candidate_id: string | null
  source_run: string
  note_path: string
  note_class: DecisionNoteClass
  note_date: string
  content_hash: string
  base_content_hash: string
  sync_state: string
  version: number
  created_at: string
  updated_at: string
}

interface DecisionEvidenceRow {
  evidence_id: string
  decision_id: string
  kind: DecisionEvidenceKind
  ref: string
  verified_by: string
  verified_at: string
  content_hash: string
  created_at: string
}

interface DecisionRelationRow {
  relation_id: string
  source_decision_id: string
  target_decision_id: string
  relation_type: DecisionRelationRecord['relationType']
  evidence_ref: string
  created_by: string
  created_at: string
}

interface DecisionAuditRow {
  audit_id: string
  decision_id: string
  event_type: string
  actor_type: 'user' | 'agent' | 'service'
  actor_id: string
  decision_version: number
  candidate_gate_event_id: string | null
  payload_json: string
  created_at: string
}

interface CommentRow {
  comment_id: string
  task_id: string
  report_id: string | null
  comment_type: string
  decision: string | null
  body: string
  author_name: string | null
  created_at: string
}

interface CriteriaRow {
  criteria_id: string
  task_id: string
  description: string
  check_type: string
  status: string
  checked_at: string | null
}

interface ReportRow {
  report_id: string
  task_id: string
  agent_id: string | null
  session_id: string | null
  content: string
  artifact_ids: string | null
  acceptance_self_check: string | null
  status: string
  version: number
  submitted_at: string
}

interface LeaseRow {
  lease_id: string
  task_id: string
  link_id: string
  holder_type: 'agent' | 'session' | 'service'
  holder_id: string
  session_id: string
  lease_token: string
  authority_epoch: number
  status: 'active' | 'released' | 'expired' | 'revoked'
  acquired_at: string
  heartbeat_at: string
  expires_at: string
  released_at: string
  version: number
}

interface ProjectRow {
  project_id: string
  name: string
  type: 'code' | 'knowledge' | 'hybrid'
  local_path: string | null
  github_url: string | null
  feishu_doc_token: string | null
  workspace_id: string | null
  ownership_state: 'active' | 'ownership_pending'
  version: number
  created_at: string
  updated_at: string
}

interface RunRow {
  link_id: string
  task_id: string
  run_id: string | null
  session_id: string | null
  role: string
  status: string
  idempotency_key: string | null
  linked_at: string
}

/**
 * Map a run row to the public record.
 * @param row - raw row.
 * @returns the public record.
 */
function toLease(row: LeaseRow): LeaseRecord {
  return {
    leaseId: row.lease_id,
    taskId: row.task_id,
    linkId: row.link_id,
    holderType: row.holder_type,
    holderId: row.holder_id,
    sessionId: row.session_id,
    leaseToken: row.lease_token,
    authorityEpoch: row.authority_epoch,
    status: row.status,
    acquiredAt: row.acquired_at,
    heartbeatAt: row.heartbeat_at,
    expiresAt: row.expires_at,
    releasedAt: row.released_at,
    version: row.version,
  }
}

function toRun(row: RunRow): RunRecord {
  return {
    linkId: row.link_id,
    taskId: row.task_id,
    runId: row.run_id,
    sessionId: row.session_id,
    role: row.role,
    status: row.status,
    idempotencyKey: row.idempotency_key,
    linkedAt: row.linked_at,
  }
}

function parseJson(value: string): unknown {
  return JSON.parse(value) as unknown
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(item => canonicalize(item))
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map(key => [key, canonicalize((value as Record<string, unknown>)[key])]),
    )
  }
  return value
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value))
}

function snapshotHash(canonical: string): string {
  return `sha256:${createHash('sha256').update(canonical, 'utf8').digest('hex')}`
}

function uniqueIds(ids: readonly string[] | undefined): string[] {
  if (ids === undefined) return []
  const seen = new Set<string>()
  for (const id of ids) {
    const trimmed = id.trim()
    if (trimmed === '') {
      throw new TaskServiceError('invalid_request', 'decision ids cannot be empty', {}, 400)
    }
    if (seen.has(trimmed)) {
      throw new TaskServiceError('decision_validation_failed', `duplicate decision id ${trimmed}`, { decisionId: trimmed }, 400)
    }
    seen.add(trimmed)
  }
  return [...seen].sort()
}

/**
 * Map a Candidate row to the public record.
 * @param row - raw row.
 * @returns the public Candidate.
 */
function toCandidate(row: CandidateRow): CandidateRecord {
  return {
    candidateId: row.candidate_id,
    sourceIdeaId: row.source_idea_id,
    sourceType: row.source_type,
    sourceSystem: row.source_system,
    sourceRef: row.source_ref,
    projectId: row.project_id,
    workspaceId: row.workspace_id,
    repositoryRef: row.repository_ref,
    branchRef: row.branch_ref,
    title: row.title,
    description: row.description,
    status: row.status,
    analysisProblem: row.analysis_problem,
    analysisNonGoals: row.analysis_non_goals,
    analysisDeliverables: row.analysis_deliverables,
    acceptanceCriteria: parseJson(row.acceptance_criteria_json) as readonly unknown[],
    dependencies: parseJson(row.dependencies_json) as readonly unknown[],
    riskLevel: row.risk_level,
    riskReason: row.risk_reason,
    complexity: row.complexity,
    ownerUserId: row.owner_user_id,
    proposedAssignee: row.proposed_assignee,
    mandateScope: parseJson(row.mandate_scope_json) as Record<string, unknown>,
    decisionChangeRequired: row.decision_change_required === 1,
    admissionSnapshotId: row.admission_snapshot_id,
    admissionSnapshotHash: row.admission_snapshot_hash,
    convertedTaskId: row.converted_task_id,
    latestGateEventId: row.latest_gate_event_id,
    deferredUntil: row.deferred_until,
    deferReason: row.defer_reason,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/**
 * Map a snapshot row to the public record.
 * @param row - raw row.
 * @returns the public snapshot.
 */
function toSnapshot(row: AdmissionSnapshotRow): AdmissionSnapshotRecord {
  return {
    snapshotId: row.snapshot_id,
    candidateId: row.candidate_id,
    candidateVersion: row.candidate_version,
    projectId: row.project_id,
    searchQuery: parseJson(row.search_query_json),
    searchCoverage: parseJson(row.search_coverage_json),
    activeWork: parseJson(row.active_work_json) as readonly unknown[],
    proposedDecisions: parseJson(row.proposed_decisions_json) as readonly unknown[],
    authoritativeDecisions: parseJson(row.authoritative_decisions_json) as readonly unknown[],
    historicalDecisions: parseJson(row.historical_decisions_json) as readonly unknown[],
    selectedDecisionIds: parseJson(row.selected_decision_ids_json) as readonly string[],
    decisionLinkCount: row.decision_link_count,
    conflicts: parseJson(row.conflicts_json) as readonly unknown[],
    requiredActions: parseJson(row.required_actions_json) as readonly unknown[],
    residualRisk: row.residual_risk,
    snapshotVersion: row.snapshot_version,
    snapshotHash: row.snapshot_hash,
    createdBy: row.created_by,
    createdAt: row.created_at,
  }
}

/**
 * Map a Decision row to the public record.
 * @param row - raw row.
 * @returns the public Decision.
 */
function toDecision(row: DecisionRow): DecisionRecord {
  return {
    decisionId: row.decision_id,
    projectId: row.project_id,
    workspaceId: row.workspace_id,
    repositoryRef: row.repository_ref,
    decisionKey: row.decision_key,
    title: row.title,
    status: row.status,
    subjectType: row.subject_type,
    subjectId: row.subject_id,
    authorityScope: row.authority_scope,
    authorityLevel: row.authority_level,
    relaxesDecisionId: row.relaxes_decision_id,
    relaxesEvidenceId: row.relaxes_evidence_id,
    environment: row.environment,
    branchKey: row.branch_key,
    rolloutKey: row.rollout_key,
    tenantKey: row.tenant_key,
    regionKey: row.region_key,
    problem: row.problem,
    proposal: row.proposal,
    rationale: row.rationale,
    alternatives: row.alternatives,
    acceptanceCriteria: row.acceptance_criteria,
    proposedBy: row.proposed_by,
    proposedAt: row.proposed_at,
    approvedBy: row.approved_by,
    approvedAt: row.approved_at,
    effectiveFrom: row.effective_from,
    effectiveTo: row.effective_to,
    rejectReason: row.reject_reason,
    archiveReason: row.archive_reason,
    predecessorId: row.predecessor_id,
    supersedesId: row.supersedes_id,
    sourceTaskId: row.source_task_id,
    sourceCandidateId: row.source_candidate_id,
    sourceRun: row.source_run,
    notePath: row.note_path,
    noteClass: row.note_class,
    noteDate: row.note_date,
    contentHash: row.content_hash,
    baseContentHash: row.base_content_hash,
    syncState: row.sync_state,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/**
 * Map a Decision evidence row to the public record.
 * @param row - raw row.
 * @returns the public evidence.
 */
function toDecisionEvidence(row: DecisionEvidenceRow): DecisionEvidenceRecord {
  return {
    evidenceId: row.evidence_id,
    decisionId: row.decision_id,
    kind: row.kind,
    ref: row.ref,
    verifiedBy: row.verified_by,
    verifiedAt: row.verified_at,
    contentHash: row.content_hash,
    createdAt: row.created_at,
  }
}

/**
 * Map a Decision relation row to the public record.
 * @param row - raw row.
 * @returns the public relation.
 */
function toDecisionRelation(row: DecisionRelationRow): DecisionRelationRecord {
  return {
    relationId: row.relation_id,
    sourceDecisionId: row.source_decision_id,
    targetDecisionId: row.target_decision_id,
    relationType: row.relation_type,
    evidenceRef: row.evidence_ref,
    createdBy: row.created_by,
    createdAt: row.created_at,
  }
}

/**
 * Map a Decision audit row to the public record.
 * @param row - raw row.
 * @returns the public audit entry.
 */
function toDecisionAudit(row: DecisionAuditRow): DecisionAuditRecord {
  return {
    auditId: row.audit_id,
    decisionId: row.decision_id,
    eventType: row.event_type,
    actorType: row.actor_type,
    actorId: row.actor_id,
    decisionVersion: row.decision_version,
    candidateGateEventId: row.candidate_gate_event_id,
    payload: parseJson(row.payload_json) as Record<string, unknown>,
    createdAt: row.created_at,
  }
}

function actorIdentity(actor: Actor): string {
  return actor.id?.trim() || actor.name?.trim() || actor.type
}

function requireText(value: string, field: string): string {
  const trimmed = value.trim()
  if (trimmed === '') {
    throw new TaskServiceError('decision_validation_failed', `${field} is required`, { field }, 400)
  }
  return trimmed
}

function nullableText(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? ''
  return trimmed === '' ? null : trimmed
}

function safeJsonObject(value: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(value)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

function canonicalProjectLocalPath(value: string): string {
  if (value === '' || value.includes('\0') || !isAbsolute(value)) {
    throw new TaskServiceError('workspace_invalid', `project local path must be an absolute directory: ${value}`, { localPath: value }, 400)
  }
  try {
    return realpathSync(value)
  } catch (error) {
    throw new TaskServiceError('workspace_invalid', `project local path is not an existing directory: ${value}`, {
      localPath: value,
      cause: error instanceof Error ? error.message : String(error),
    }, 400)
  }
}

function isProjectExecutionReady(
  type: 'code' | 'knowledge' | 'hybrid',
  localPath: string | null,
  feishuDocToken: string,
  workspaceId = '',
): boolean {
  if (type === 'knowledge') return feishuDocToken.trim() !== ''
  return workspaceId.trim() !== '' || localPath !== null
}

function expectedProjectWorkspace(project: Pick<ProjectRow, 'workspace_id' | 'local_path'>): string {
  return project.workspace_id?.trim() || project.local_path?.trim() || ''
}

function toProject(row: ProjectRow): ProjectRecord {
  return {
    projectId: row.project_id,
    name: row.name,
    type: row.type,
    localPath: row.local_path,
    githubUrl: row.github_url,
    feishuDocToken: row.feishu_doc_token,
    workspaceId: row.workspace_id,
    ownershipState: row.ownership_state,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function textOrEmpty(value: string | null | undefined): string {
  return value?.trim() ?? ''
}

function assertEnum<T extends string>(value: string, allowed: readonly T[], field: string): T {
  if (!(allowed as readonly string[]).includes(value)) {
    throw new TaskServiceError(
      'decision_validation_failed',
      `${field} must be one of ${allowed.join(', ')}`,
      { field, value },
      400,
    )
  }
  return value as T
}

function decisionContentHash(value: string): string {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

interface TaskRow {
  task_id: string
  project_id: string
  source_candidate_id: string
  owner_user_id: string
  mandate_id: string | null
  workspace_override: string | null
  repository_ref: string | null
  branch_ref: string | null
  lifecycle_mode: 'p0' | 'v1'
  title: string
  description: string | null
  status: string
  task_type: string
  risk_level: string
  parent_task_id: string | null
  thread_id: string | null
  assignee_name: string | null
  version: number
  created_at: string
  updated_at: string
  closed_at: string | null
}

const ROLLBACK_ALIASES: Readonly<Record<string, string>> = {
  local: 'in_progress',
  partial: 'decomposing',
  global: 'discussing',
}

/** Source systems accepted when a deployment does not configure its own list. */
export const DEFAULT_SOURCE_SYSTEMS = ['github', 'feishu', 'wecom', 'oa', 'web', 'internal'] as const

const DECISION_STATUSES = ['proposed', 'implemented', 'rejected', 'archived'] as const
const DECISION_AUTHORITY_SCOPES = ['project', 'workspace', 'repository', 'branch', 'environment', 'task'] as const
const DECISION_AUTHORITY_LEVELS = ['hard_constraint', 'policy', 'implementation', 'local_default'] as const
const DECISION_SUBJECT_TYPES = ['project', 'task', 'module', 'service', 'api', 'process', 'data', 'security'] as const
const DECISION_NOTE_CLASSES = ['feature', 'bug-fix', 'simplification', 'architecture', 'process', 'testing'] as const
const DECISION_ARCHIVE_REASONS = ['superseded', 'invalidated', 'obsolete', 'project_archived'] as const
const DECISION_EVIDENCE_KINDS = ['pull_request', 'commit', 'deployment', 'document', 'approval', 'test', 'manual'] as const

/**
 * The task domain's single write entry.
 */
export class TaskService {
  readonly #db: DatabaseSync
  readonly #now: () => string
  readonly #newId: () => string
  readonly #allowedSourceSystems: ReadonlySet<string>

  /**
   * @param db - open handle whose `user_version` is `SCHEMA_VERSION`.
   * @param options - clock, id generator and the source-system allowlist.
   */
  constructor(
    db: DatabaseSync,
    options: { now?: () => string; newId?: () => string; allowedSourceSystems?: readonly string[] } = {},
  ) {
    assertSchemaVersion(db)
    this.#db = db
    this.#now = options.now ?? (() => new Date().toISOString())
    this.#newId = options.newId ?? (() => randomUUID())
    this.#allowedSourceSystems = new Set(options.allowedSourceSystems ?? DEFAULT_SOURCE_SYSTEMS)
  }

  /** Read one project and its execution workspace. */
  getProject(projectId: string): ProjectRecord {
    return toProject(this.#loadProject(projectId))
  }

  /** Resolve the project workspace and active execution scope for one task. */
  getTaskExecutionContext(taskId: string): TaskExecutionContext {
    return this.#assertExecutionReady(taskId)
  }

  /**
   * Create a project row with one owner and its optional execution workspace.
   * @param input - project identity, type, workspace binding and governing actor.
   * @returns the new project id.
   */
  createProject(input: CreateProjectInput): string {
    const projectId = input.projectId ?? `proj_${this.#newId()}`
    const now = this.#now()
    const type = input.type ?? 'code'
    const workspaceId = input.workspaceId?.trim() ?? ''
    const localPath = input.localPath?.trim() === undefined || input.localPath?.trim() === ''
      ? null
      : canonicalProjectLocalPath(input.localPath.trim())
    const githubUrl = input.githubUrl?.trim() ?? ''
    const feishuDocToken = input.feishuDocToken?.trim() ?? ''
    const actorId = input.actor?.id ?? input.actor?.name ?? 'system'
    if (workspaceId !== '' && localPath !== null) {
      throw new TaskServiceError('workspace_invalid', 'workspaceId and localPath are mutually exclusive', {}, 400)
    }
    const ownershipState = isProjectExecutionReady(type, localPath, feishuDocToken, workspaceId) ? 'active' : 'ownership_pending'
    this.#transaction(() => {
      this.#db
        .prepare(
          `INSERT INTO projects(
             project_id, name, type, local_path, github_url, feishu_doc_token,
             workspace_id, ownership_state, version, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
        )
        .run(projectId, input.name, type, localPath, githubUrl, feishuDocToken, workspaceId, ownershipState, now, now)
      this.#db
        .prepare(
          `INSERT INTO project_members(
             membership_id, project_id, principal_type, principal_id, role,
             granted_by, granted_at, version)
           VALUES (?, ?, 'user', ?, 'owner', ?, ?, 0)`,
        )
        .run(`member_${this.#newId()}`, projectId, actorId, actorId, now)
    })
    return projectId
  }

  /**
   * Change only a project's execution workspace. Existing active tasks keep
   * their admitted mandate; therefore a project with active work may not be
   * moved underneath them. The update is user-owned and optimistic.
   * @param input - project, expected version, exactly one workspace source and actor.
   * @returns the updated project.
   */
  rebindProject(input: RebindProjectInput): ProjectRecord {
    if (input.actor.type !== 'user') {
      throw new TaskServiceError('user_approval_required', 'only a user may rebind a project workspace', {}, 403)
    }
    const workspaceId = input.workspaceId?.trim() ?? ''
    const localPath = input.localPath?.trim() === undefined || input.localPath?.trim() === ''
      ? null
      : canonicalProjectLocalPath(input.localPath.trim())
    if ((workspaceId === '' && localPath === null) || (workspaceId !== '' && localPath !== null)) {
      throw new TaskServiceError('workspace_invalid', 'exactly one of workspaceId or localPath is required', {}, 400)
    }
    return this.#transaction(() => {
      const project = this.#loadProject(input.projectId)
      if (project.version !== input.ifVersion) {
        throw new TaskServiceError('version_conflict', `expected version ${input.ifVersion}, current version is ${project.version}`, {
          latest: toProject(project),
          currentVersion: project.version,
        }, 409)
      }
      const previousWorkspace = expectedProjectWorkspace(project)
      const requestedWorkspace = workspaceId !== '' ? workspaceId : localPath ?? ''
      const active = this.#db.prepare(
        "SELECT COUNT(*) AS n FROM tasks WHERE project_id = ? AND status IN ('discussing','decomposing','in_progress','validating','closing','blocked','paused')",
      ).get(project.project_id) as { n: number }
      if (previousWorkspace !== '' && previousWorkspace !== requestedWorkspace && active.n > 0) {
        throw new TaskServiceError('project_has_active_tasks', 'a bound project cannot move to another workspace while active tasks exist', {
          projectId: project.project_id,
          activeTasks: active.n,
          previousWorkspace,
          requestedWorkspace,
        }, 409)
      }
      const ownershipState: 'active' | 'ownership_pending' = isProjectExecutionReady(project.type, localPath, project.feishu_doc_token ?? '', workspaceId) ? 'active' : 'ownership_pending'
      this.#db.prepare(
        `UPDATE projects
         SET workspace_id = ?, local_path = ?, ownership_state = ?, version = version + 1, updated_at = ?
         WHERE project_id = ?`,
      ).run(workspaceId, localPath, ownershipState, this.#now(), project.project_id)
      const actorId = input.actor.id ?? input.actor.name ?? 'user'
      this.#db.prepare(
        `INSERT INTO project_members(membership_id, project_id, principal_type, principal_id, role, granted_by, granted_at, version)
         VALUES (?, ?, 'user', ?, 'owner', ?, ?, 0)`,
      ).run(`member_${this.#newId()}`, project.project_id, actorId, actorId, this.#now())
      return toProject(this.#loadProject(project.project_id))
    })
  }

  /**
   * Legacy direct-task creation is deliberately closed. A task can only be
   * created by approving a Candidate gate, so old callers fail loudly instead
   * of relying on a database trigger to reject a half-built row.
   * @param input - rejected legacy input.
   * @returns never; callers must use the Candidate admission flow.
   */
  createTask(input: CreateTaskInput): TaskRecord {
    throw new TaskServiceError(
      'admission_required',
      'tasks can only be created by approving a Candidate admission gate',
      { projectId: input.projectId },
      410,
    )
  }

  /**
   * Capture a Candidate before analysis. Nothing enters the task lifecycle yet.
   *
   * Workspace, repository and branch always inherit from Project unless the
   * supplied values exactly match; callers cannot redirect work to another root.
   * @param input - source, project and initial descriptive fields.
   * @returns the captured Candidate.
   */
  captureCandidate(input: CaptureCandidateInput): CandidateRecord {
    const now = this.#now()
    const candidateId = input.candidateId ?? `cand_${this.#newId()}`
    const project = this.#loadProject(input.projectId)
    const expectedWorkspace = expectedProjectWorkspace(project)
    const requestedWorkspace = input.workspaceId?.trim() ?? ''
    if (requestedWorkspace !== '' && requestedWorkspace !== expectedWorkspace) {
      throw new TaskServiceError('workspace_context_mismatch', 'candidate workspace does not match the project', {
        projectId: input.projectId,
        requested: requestedWorkspace,
        expected: expectedWorkspace,
      }, 400)
    }
    const existing = this.#db
      .prepare('SELECT * FROM task_candidates WHERE candidate_id = ?')
      .get(candidateId) as unknown as CandidateRow | undefined
    if (existing !== undefined) return toCandidate(existing)
    const ownerUserId = input.ownerUserId
      ?? (input.actor.type === 'user' ? (input.actor.id ?? input.actor.name ?? 'unknown') : 'unknown')
    const repositoryRef = input.repositoryRef?.trim() || project.github_url || ''
    const branchRef = input.branchRef?.trim() ?? ''
    const mandateScope = {
      project_id: project.project_id,
      workspace_id: expectedWorkspace,
      repository_ref: repositoryRef,
      branch_ref: branchRef,
      ...(safeJsonObject(canonicalJson(input.mandateScope ?? {})) ?? {}),
    }
    this.#transaction(() => {
      this.#db
        .prepare(
          `INSERT INTO task_candidates(
             candidate_id, source_idea_id, source_type, source_system, source_ref, project_id,
             workspace_id, repository_ref, branch_ref, title, description, status,
             risk_level, risk_reason, complexity, owner_user_id, proposed_assignee,
             mandate_scope_json, decision_change_required, version, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'captured', ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
        )
        .run(
          candidateId,
          input.sourceIdeaId ?? null,
          input.sourceType ?? 'manual',
          input.sourceSystem ?? 'internal',
          input.sourceRef ?? `candidate:${candidateId}`,
          input.projectId,
          expectedWorkspace,
          repositoryRef,
          branchRef,
          input.title,
          input.description ?? '',
          input.riskLevel ?? 'medium',
          input.riskReason ?? '',
          input.complexity ?? 'medium',
          ownerUserId,
          input.proposedAssignee ?? '',
          canonicalJson(mandateScope),
          input.decisionChangeRequired === true ? 1 : 0,
          now,
          now,
        )
    })
    return this.#loadCandidate(candidateId)
  }

  /**
   * Record structured analysis. The first call moves captured -> analyzing;
   * the next call moves analyzing -> awaiting_gate.
   * @param input - analyzed fields and optimistic version.
   * @returns the updated Candidate.
   */
  analyzeCandidate(input: AnalyzeCandidateInput): CandidateRecord {
    return this.#transaction(() => {
      const candidate = this.#loadCandidate(input.candidateId)
      this.#checkCandidateVersion(candidate, input.ifVersion)
      if (candidate.status !== 'captured' && candidate.status !== 'analyzing') {
        throw new TaskServiceError(
          'candidate_state_conflict',
          `candidate ${candidate.candidateId} is ${candidate.status}, not analyzable`,
          { candidateId: candidate.candidateId, status: candidate.status, version: candidate.version },
          409,
        )
      }
      const nextStatus: CandidateStatus = candidate.status === 'captured' ? 'analyzing' : 'awaiting_gate'
      const now = this.#now()
      this.#db
        .prepare(
          `UPDATE task_candidates SET
             title = ?, description = ?, analysis_problem = ?, analysis_non_goals = ?,
             analysis_deliverables = ?, acceptance_criteria_json = ?, dependencies_json = ?,
             risk_level = ?, risk_reason = ?, complexity = ?, owner_user_id = ?,
             proposed_assignee = ?, mandate_scope_json = ?, decision_change_required = ?,
             status = ?, version = version + 1, updated_at = ?
           WHERE candidate_id = ?`,
        )
        .run(
          input.title ?? candidate.title,
          input.description ?? candidate.description,
          input.analysisProblem ?? candidate.analysisProblem,
          input.analysisNonGoals ?? candidate.analysisNonGoals,
          input.analysisDeliverables ?? candidate.analysisDeliverables,
          canonicalJson(input.acceptanceCriteria ?? candidate.acceptanceCriteria),
          canonicalJson(input.dependencies ?? candidate.dependencies),
          input.riskLevel ?? candidate.riskLevel,
          input.riskReason ?? candidate.riskReason,
          input.complexity ?? candidate.complexity,
          input.ownerUserId ?? candidate.ownerUserId,
          input.proposedAssignee ?? candidate.proposedAssignee,
          canonicalJson(input.mandateScope ?? candidate.mandateScope),
          (input.decisionChangeRequired ?? candidate.decisionChangeRequired) ? 1 : 0,
          nextStatus,
          now,
          candidate.candidateId,
        )
      return this.#loadCandidate(candidate.candidateId)
    })
  }

  /**
   * Persist the immutable four-channel preflight snapshot and move the
   * Candidate to awaiting_gate.
   * @param input - search coverage and mutually exclusive decision collections.
   * @returns the stored snapshot.
   */
  createAdmissionSnapshot(input: CreateAdmissionSnapshotInput): AdmissionSnapshotRecord {
    return this.#transaction(() => {
      const candidate = this.#loadCandidate(input.candidateId)
      this.#checkCandidateVersion(candidate, input.ifVersion)
      if (candidate.status !== 'analyzing' && candidate.status !== 'awaiting_gate') {
        throw new TaskServiceError(
          'candidate_state_conflict',
          `candidate ${candidate.candidateId} is ${candidate.status}, not ready for preflight`,
          { candidateId: candidate.candidateId, status: candidate.status, version: candidate.version },
          409,
        )
      }
      const proposed = this.#decisionCollection(candidate, input.proposedDecisionIds, ['proposed'], 'proposed')
      const authoritative = this.#decisionCollection(
        candidate,
        input.authoritativeDecisionIds,
        ['implemented'],
        'authoritative',
      )
      const historical = this.#decisionCollection(
        candidate,
        input.historicalDecisionIds,
        ['rejected', 'archived'],
        'historical',
      )
      const seen = new Set<string>()
      for (const decisionId of [...proposed.ids, ...authoritative.ids, ...historical.ids]) {
        if (seen.has(decisionId)) {
          throw new TaskServiceError(
            'decision_validation_failed',
            `decision ${decisionId} appears in more than one snapshot collection`,
            { decisionId },
            400,
          )
        }
        seen.add(decisionId)
      }
      const selectedIds = uniqueIds(input.selectedDecisionIds)
      for (const decisionId of selectedIds) {
        if (!seen.has(decisionId)) {
          throw new TaskServiceError(
            'decision_validation_failed',
            `selected decision ${decisionId} is not in a snapshot collection`,
            { decisionId },
            400,
          )
        }
      }
      const now = this.#now()
      const snapshotId = `snap_${this.#newId()}`
      const selectedRank = new Map(selectedIds.map((id, index) => [id, index]))
      const collectionFor = (decisionId: string): 'proposed' | 'authoritative' | 'historical' => {
        if (proposed.ids.includes(decisionId)) return 'proposed'
        if (authoritative.ids.includes(decisionId)) return 'authoritative'
        return 'historical'
      }
      const decisionById = new Map(
        [...proposed.rows, ...authoritative.rows, ...historical.rows].map(row => [row.decision_id, row]),
      )
      const searchCoverage = { status: input.searchCoverage }
      const canonical = canonicalJson({
        candidateId: candidate.candidateId,
        candidateVersion: candidate.version,
        projectId: candidate.projectId,
        searchQuery: input.query,
        searchCoverage,
        activeWork: input.activeWork ?? [],
        proposedDecisions: proposed.records,
        authoritativeDecisions: authoritative.records,
        historicalDecisions: historical.records,
        selectedDecisionIds: selectedIds,
        decisionLinkCount: selectedIds.length,
        conflicts: input.conflicts ?? [],
        requiredActions: input.requiredActions ?? [],
        residualRisk: input.residualRisk ?? '',
        snapshotVersion: 1,
      })
      const hash = snapshotHash(canonical)
      const createdBy = input.actor.name ?? input.actor.id ?? input.actor.type
      this.#db
        .prepare(
          `INSERT INTO admission_snapshots(
             snapshot_id, candidate_id, candidate_version, project_id, search_query_json,
             search_coverage_json, active_work_json, proposed_decisions_json,
             authoritative_decisions_json, historical_decisions_json, selected_decision_ids_json,
             decision_link_count, conflicts_json, required_actions_json, residual_risk,
             snapshot_version, canonical_json, snapshot_hash, created_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
        )
        .run(
          snapshotId,
          candidate.candidateId,
          candidate.version,
          candidate.projectId,
          canonicalJson(input.query),
          canonicalJson(searchCoverage),
          canonicalJson(input.activeWork ?? []),
          canonicalJson(proposed.records),
          canonicalJson(authoritative.records),
          canonicalJson(historical.records),
          canonicalJson(selectedIds),
          selectedIds.length,
          canonicalJson(input.conflicts ?? []),
          canonicalJson(input.requiredActions ?? []),
          input.residualRisk ?? '',
          canonical,
          hash,
          createdBy,
          now,
        )
      const insertSelected = this.#db.prepare(
        `INSERT INTO admission_snapshot_selected_decisions(
           snapshot_id, decision_id, decision_status, collection_type, decision_version, selected_rank)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      for (const decisionId of selectedIds) {
        const decision = decisionById.get(decisionId)
        if (decision === undefined) throw new TaskServiceError('decision_validation_failed', `decision ${decisionId} disappeared`, {}, 409)
        insertSelected.run(
          snapshotId,
          decisionId,
          decision.status,
          collectionFor(decisionId),
          decision.version,
          selectedRank.get(decisionId) ?? 0,
        )
      }
      this.#db
        .prepare(
          `UPDATE task_candidates
           SET admission_snapshot_id = ?, admission_snapshot_hash = ?, status = 'awaiting_gate',
               version = version + 1, updated_at = ?
           WHERE candidate_id = ?`,
        )
        .run(snapshotId, hash, now, candidate.candidateId)
      return this.#loadSnapshot(snapshotId)
    })
  }

  /**
   * Approve a Candidate gate and create the discussing Task, mandate and
   * decision links in one transaction. Repeating the same approval is
   * idempotent and returns the original Task.
   * @param input - Candidate, optimistic version and the human approver.
   * @returns the complete admission result.
   */
  approveCandidateGate(input: ApprovedCandidateGateInput): CandidateAdmissionResult {
    return this.#transaction(() => {
      const candidate = this.#loadCandidate(input.candidateId)
      if (candidate.status === 'converted') {
        if (candidate.convertedTaskId === null || candidate.admissionSnapshotId === null || candidate.latestGateEventId === null) {
          throw new TaskServiceError('candidate_state_conflict', 'converted Candidate is missing its task or gate', {
            candidateId: candidate.candidateId,
          }, 409)
        }
        const mandate = this.#db
          .prepare('SELECT mandate_id FROM task_mandates WHERE task_id = ? AND status = \'active\' LIMIT 1')
          .get(candidate.convertedTaskId) as { mandate_id: string } | undefined
        if (mandate === undefined) {
          throw new TaskServiceError('candidate_state_conflict', 'converted Candidate is missing its active mandate', {
            candidateId: candidate.candidateId,
          }, 409)
        }
        return {
          candidate,
          snapshot: this.#loadSnapshot(candidate.admissionSnapshotId),
          gateEventId: candidate.latestGateEventId,
          task: this.#loadTask(candidate.convertedTaskId),
          mandateId: mandate.mandate_id,
          decisionLinkIds: this.#decisionLinkIds(candidate.convertedTaskId, candidate.admissionSnapshotId),
        }
      }
      if (input.actor.type !== 'user') {
        throw new TaskServiceError('user_approval_required', 'only a user can approve a Candidate gate', {}, 403)
      }
      this.#checkCandidateVersion(candidate, input.ifVersion)
      if (candidate.status !== 'awaiting_gate') {
        throw new TaskServiceError(
          'candidate_state_conflict',
          `candidate ${candidate.candidateId} is ${candidate.status}, not awaiting_gate`,
          { candidateId: candidate.candidateId, status: candidate.status, version: candidate.version },
          409,
        )
      }
      const admissionSnapshotHash = candidate.admissionSnapshotHash
      if (candidate.admissionSnapshotId === null || admissionSnapshotHash === null || admissionSnapshotHash.trim() === '') {
        throw new TaskServiceError('admission_snapshot_invalid', 'Candidate has no admission snapshot', {
          candidateId: candidate.candidateId,
        }, 409)
      }
      const project = this.#loadProject(candidate.projectId)
      this.#assertCandidateWorkspace(project, candidate)
      const snapshot = this.#loadSnapshot(candidate.admissionSnapshotId)
      if (
        snapshot.candidateId !== candidate.candidateId
        || snapshot.projectId !== candidate.projectId
        || snapshot.snapshotHash !== admissionSnapshotHash
      ) {
        throw new TaskServiceError('admission_snapshot_invalid', 'admission snapshot does not match the Candidate', {
          candidateId: candidate.candidateId,
          snapshotId: snapshot.snapshotId,
        }, 409)
      }
      const now = this.#now()
      const actorId = input.actor.id ?? input.actor.name ?? 'user'
      const idempotencyKey = input.idempotencyKey ?? `approve:${candidate.candidateId}:${candidate.admissionSnapshotId}`
      const lifecycleMode = input.lifecycleMode ?? 'v1'
      const initialStatus = lifecycleMode === 'p0' ? 'idea' : 'discussing'
      const gateEventId = `gate_${this.#newId()}`
      const taskId = `task_${this.#newId()}`
      const mandateId = `mandate_${this.#newId()}`
      const payloadHash = snapshotHash(canonicalJson({
        candidateId: candidate.candidateId,
        candidateVersion: snapshot.candidateVersion,
        snapshotId: snapshot.snapshotId,
        snapshotHash: snapshot.snapshotHash,
        action: 'approve',
      }))
      this.#db
        .prepare(
          `INSERT INTO candidate_gate_events(
             event_id, candidate_id, candidate_version, snapshot_id, snapshot_hash, action,
             actor_type, actor_id, decided_at, request_id, idempotency_key, payload_hash)
           VALUES (?, ?, ?, ?, ?, 'approve', 'user', ?, ?, ?, ?, ?)`,
        )
        .run(
          gateEventId,
          candidate.candidateId,
          snapshot.candidateVersion,
          snapshot.snapshotId,
          snapshot.snapshotHash,
          actorId,
          now,
          `req_${this.#newId()}`,
          idempotencyKey,
          payloadHash,
        )
      this.#db
        .prepare(
          `INSERT INTO tasks(
             task_id, project_id, source_candidate_id, owner_user_id, mandate_id,
             workspace_override, repository_ref, branch_ref, lifecycle_mode, title, description, status,
             task_type, risk_level, version, created_at, updated_at)
           VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
        )
        .run(
          taskId,
          candidate.projectId,
          candidate.candidateId,
          candidate.ownerUserId || actorId,
          candidate.workspaceId === '' ? null : candidate.workspaceId,
          candidate.repositoryRef === '' ? null : candidate.repositoryRef,
          candidate.branchRef === '' ? null : candidate.branchRef,
          lifecycleMode,
          candidate.title,
          candidate.description,
          initialStatus,
          input.taskType ?? 'code',
          candidate.riskLevel,
          now,
          now,
        )
      this.#db
        .prepare(
          `INSERT INTO task_mandates(
             mandate_id, candidate_id, task_id, source_gate_event_id, issued_by,
             scope_json, status, effective_from, version, created_at)
           VALUES (?, ?, ?, ?, ?, ?, 'active', ?, 0, ?)`,
        )
        .run(
          mandateId,
          candidate.candidateId,
          taskId,
          gateEventId,
          actorId,
          canonicalJson({
            task_id: taskId,
            project_id: project.project_id,
            workspace_id: candidate.workspaceId,
            repository_ref: candidate.repositoryRef,
            branch_ref: candidate.branchRef,
            risk_ceiling: candidate.riskLevel,
            allowed_paths: [],
            allowed_tools: [],
            ...(safeJsonObject(canonicalJson(candidate.mandateScope)) ?? {}),
          }),
          now,
          now,
        )
      this.#db.prepare('UPDATE tasks SET mandate_id = ?, updated_at = ? WHERE task_id = ?').run(mandateId, now, taskId)
      const selectionRows = this.#db
        .prepare(
          `SELECT decision_id, collection_type FROM admission_snapshot_selected_decisions
           WHERE snapshot_id = ? ORDER BY selected_rank`,
        )
        .all(snapshot.snapshotId) as { decision_id: string; collection_type: 'proposed' | 'authoritative' | 'historical' }[]
      const insertLink = this.#db.prepare(
        `INSERT INTO task_decision_links(
           link_id, task_id, decision_id, admission_snapshot_id, link_type, evidence_kind,
           evidence_ref, authority_epoch, active, version, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, 'gate_event', ?, 0, 1, 1, ?, ?)`,
      )
      const decisionLinkIds: string[] = []
      for (const row of selectionRows) {
        const linkId = `link_${this.#newId()}`
        const linkType = row.collection_type === 'authoritative'
          ? 'constrains'
          : row.collection_type === 'proposed' ? 'implements' : 'references'
        insertLink.run(linkId, taskId, row.decision_id, snapshot.snapshotId, linkType, gateEventId, actorId, now)
        decisionLinkIds.push(linkId)
      }
      this.#db
        .prepare(
          `UPDATE task_candidates SET
             status = 'converted', converted_task_id = ?, latest_gate_event_id = ?,
             version = version + 1, updated_at = ?
           WHERE candidate_id = ?`,
        )
        .run(taskId, gateEventId, now, candidate.candidateId)
      this.#appendEvent(taskId, 'admitted', input.actor, {
        candidateId: candidate.candidateId,
        snapshotId: snapshot.snapshotId,
        gateEventId,
        mandateId,
        decisionIds: snapshot.selectedDecisionIds,
      })
      return {
        candidate: this.#loadCandidate(candidate.candidateId),
        snapshot,
        gateEventId,
        task: this.#loadTask(taskId),
        mandateId,
        decisionLinkIds,
      }
    })
  }

  /**
   * Read one Candidate.
   * @param candidateId - Candidate id.
   * @returns the stored Candidate.
   */
  getCandidate(candidateId: string): CandidateRecord {
    return this.#loadCandidate(candidateId)
  }

  /**
   * Propose a Decision. A proposal is memory under discussion, not authority.
   * @param input - scope, content and optional evidence.
   * @returns the stored proposed Decision.
   */
  decisionPropose(input: ProposeDecisionInput): DecisionRecord {
    const projectId = requireText(input.projectId, 'projectId')
    if (this.#db.prepare('SELECT 1 AS ok FROM projects WHERE project_id = ?').get(projectId) === undefined) {
      throw new TaskServiceError('project_not_found', `project ${projectId} does not exist`, { projectId }, 404)
    }
    const decisionId = input.decisionId?.trim() || `dec_${this.#newId()}`
    const now = this.#now()
    const authorityLevel = assertEnum(input.authorityLevel, DECISION_AUTHORITY_LEVELS, 'authorityLevel')
    const relaxesDecisionId = nullableText(input.relaxesDecisionId)
    const relaxesEvidenceId = nullableText(input.relaxesEvidenceId)
    this.#validateDecisionRelaxation(
      projectId,
      authorityLevel,
      relaxesDecisionId,
      relaxesEvidenceId,
    )
    const title = requireText(input.title, 'title')
    const proposal = requireText(input.proposal, 'proposal')
    const rationale = requireText(input.rationale, 'rationale')
    try {
      return this.#transaction(() => {
        this.#db
          .prepare(
            `INSERT INTO decisions(
               decision_id, project_id, workspace_id, repository_ref, decision_key, title, status,
               subject_type, subject_id, authority_scope, authority_level, relaxes_decision_id,
               relaxes_evidence_id, environment, branch_key, rollout_key, tenant_key, region_key,
               problem, proposal, rationale, alternatives, acceptance_criteria, proposed_by, proposed_at,
               predecessor_id, supersedes_id, source_task_id, source_candidate_id, source_run,
               note_path, note_class, note_date, content_hash, base_content_hash, sync_state,
               version, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, 'proposed', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                     ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)`,
          )
          .run(
            decisionId,
            projectId,
            textOrEmpty(input.workspaceId),
            textOrEmpty(input.repositoryRef),
            requireText(input.decisionKey, 'decisionKey'),
            title,
            assertEnum(input.subjectType, DECISION_SUBJECT_TYPES, 'subjectType'),
            textOrEmpty(input.subjectId),
            assertEnum(input.authorityScope, DECISION_AUTHORITY_SCOPES, 'authorityScope'),
            authorityLevel,
            relaxesDecisionId,
            relaxesEvidenceId,
            textOrEmpty(input.environment),
            textOrEmpty(input.branchKey),
            textOrEmpty(input.rolloutKey) || 'stable',
            textOrEmpty(input.tenantKey),
            textOrEmpty(input.regionKey),
            requireText(input.problem, 'problem'),
            proposal,
            rationale,
            textOrEmpty(input.alternatives),
            textOrEmpty(input.acceptanceCriteria),
            actorIdentity(input.actor),
            now,
            nullableText(input.predecessorId),
            nullableText(input.supersedesId),
            nullableText(input.sourceTaskId),
            nullableText(input.sourceCandidateId),
            textOrEmpty(input.sourceRun),
            textOrEmpty(input.notePath),
            assertEnum(input.noteClass, DECISION_NOTE_CLASSES, 'noteClass'),
            textOrEmpty(input.noteDate) || now.slice(0, 10),
            textOrEmpty(input.contentHash) || decisionContentHash(`${title}\n${proposal}\n${rationale}`),
            textOrEmpty(input.baseContentHash),
            now,
            now,
          )
        this.#insertDecisionEvidence(decisionId, input.evidence, input.actor, now)
        this.#appendDecisionAudit(decisionId, 'decision_proposed', input.actor, 0, {
          decisionKey: requireText(input.decisionKey, 'decisionKey'),
          authorityScope: input.authorityScope,
          authorityLevel,
        })
        return this.#loadDecision(decisionId)
      })
    } catch (error) {
      this.#throwDecisionConstraint(error)
    }
  }

  /**
   * Revise a proposed Decision only. Implemented, rejected and archived rows are immutable history.
   * @param input - expected version, editable fields and optional new evidence.
   * @returns the updated proposed Decision.
   */
  decisionRevise(input: ReviseDecisionInput): DecisionRecord {
    try {
      return this.#transaction(() => {
        const current = this.#loadDecision(input.decisionId)
        this.#checkDecisionVersion(current, input.ifVersion)
        if (current.status !== 'proposed') {
          throw new TaskServiceError(
            'decision_validation_failed',
            `only proposed decisions may be revised; current status is ${current.status}`,
            { decisionId: current.decisionId, status: current.status, version: current.version },
            409,
          )
        }

        const fields: Record<string, string | null> = {}
        if (input.workspaceId !== undefined) fields.workspace_id = textOrEmpty(input.workspaceId)
        if (input.repositoryRef !== undefined) fields.repository_ref = textOrEmpty(input.repositoryRef)
        if (input.decisionKey !== undefined) fields.decision_key = requireText(input.decisionKey, 'decisionKey')
        if (input.title !== undefined) fields.title = requireText(input.title, 'title')
        if (input.subjectType !== undefined) {
          fields.subject_type = assertEnum(input.subjectType, DECISION_SUBJECT_TYPES, 'subjectType')
        }
        if (input.subjectId !== undefined) fields.subject_id = textOrEmpty(input.subjectId)
        if (input.authorityScope !== undefined) {
          fields.authority_scope = assertEnum(input.authorityScope, DECISION_AUTHORITY_SCOPES, 'authorityScope')
        }
        if (input.authorityLevel !== undefined) {
          fields.authority_level = assertEnum(input.authorityLevel, DECISION_AUTHORITY_LEVELS, 'authorityLevel')
        }
        if (input.relaxesDecisionId !== undefined) fields.relaxes_decision_id = nullableText(input.relaxesDecisionId)
        if (input.relaxesEvidenceId !== undefined) fields.relaxes_evidence_id = nullableText(input.relaxesEvidenceId)
        if (input.environment !== undefined) fields.environment = textOrEmpty(input.environment)
        if (input.branchKey !== undefined) fields.branch_key = textOrEmpty(input.branchKey)
        if (input.rolloutKey !== undefined) fields.rollout_key = textOrEmpty(input.rolloutKey) || 'stable'
        if (input.tenantKey !== undefined) fields.tenant_key = textOrEmpty(input.tenantKey)
        if (input.regionKey !== undefined) fields.region_key = textOrEmpty(input.regionKey)
        if (input.problem !== undefined) fields.problem = requireText(input.problem, 'problem')
        if (input.proposal !== undefined) fields.proposal = requireText(input.proposal, 'proposal')
        if (input.rationale !== undefined) fields.rationale = requireText(input.rationale, 'rationale')
        if (input.alternatives !== undefined) fields.alternatives = textOrEmpty(input.alternatives)
        if (input.acceptanceCriteria !== undefined) fields.acceptance_criteria = textOrEmpty(input.acceptanceCriteria)
        if (input.predecessorId !== undefined) fields.predecessor_id = nullableText(input.predecessorId)
        if (input.supersedesId !== undefined) fields.supersedes_id = nullableText(input.supersedesId)
        if (input.sourceTaskId !== undefined) fields.source_task_id = nullableText(input.sourceTaskId)
        if (input.sourceCandidateId !== undefined) fields.source_candidate_id = nullableText(input.sourceCandidateId)
        if (input.sourceRun !== undefined) fields.source_run = textOrEmpty(input.sourceRun)
        if (input.notePath !== undefined) fields.note_path = textOrEmpty(input.notePath)
        if (input.noteClass !== undefined) fields.note_class = assertEnum(input.noteClass, DECISION_NOTE_CLASSES, 'noteClass')
        if (input.noteDate !== undefined) fields.note_date = requireText(input.noteDate, 'noteDate')
        if (input.contentHash !== undefined) fields.content_hash = textOrEmpty(input.contentHash)
        if (input.baseContentHash !== undefined) fields.base_content_hash = textOrEmpty(input.baseContentHash)

        const relaxesDecisionId = fields.relaxes_decision_id === undefined
          ? current.relaxesDecisionId
          : fields.relaxes_decision_id
        const relaxesEvidenceId = fields.relaxes_evidence_id === undefined
          ? current.relaxesEvidenceId
          : fields.relaxes_evidence_id
        const authorityLevel = assertEnum(
          (fields.authority_level ?? current.authorityLevel) as DecisionAuthorityLevel,
          DECISION_AUTHORITY_LEVELS,
          'authorityLevel',
        )
        this.#validateDecisionRelaxation(current.projectId, authorityLevel, relaxesDecisionId, relaxesEvidenceId)

        const keys = Object.keys(fields)
        const assignments = keys.map(key => `${key} = ?`).join(', ')
        const now = this.#now()
        this.#db
          .prepare(
            `UPDATE decisions SET ${assignments}${assignments === '' ? '' : ', '}
               version = version + 1, updated_at = ? WHERE decision_id = ?`,
          )
          .run(...keys.map(key => fields[key] as string | null), now, current.decisionId)
        this.#insertDecisionEvidence(current.decisionId, input.evidence, input.actor, now)
        this.#appendDecisionAudit(current.decisionId, 'decision_revised', input.actor, current.version + 1, {
          changedFields: keys,
          evidenceAdded: input.evidence?.length ?? 0,
        })
        return this.#loadDecision(current.decisionId)
      })
    } catch (error) {
      this.#throwDecisionConstraint(error)
    }
  }

  /**
   * Promote a proposal into authoritative memory. Only a user may approve it.
   * @param input - expected version, effective time and non-empty evidence.
   * @returns the implemented Decision.
   */
  decisionImplement(input: ImplementDecisionInput): DecisionRecord {
    this.#requireDecisionUser(input.actor, 'implement')
    try {
      return this.#transaction(() => {
        const current = this.#loadDecision(input.decisionId)
        this.#checkDecisionVersion(current, input.ifVersion)
        if (current.status !== 'proposed') {
          throw new TaskServiceError(
            'invalid_transition',
            `cannot implement a decision in status ${current.status}`,
            { decisionId: current.decisionId, status: current.status, version: current.version },
            409,
          )
        }
        if ((input.evidence?.length ?? 0) === 0) {
          throw new TaskServiceError(
            'decision_validation_failed',
            'implement requires at least one evidence item',
            { decisionId: current.decisionId, field: 'evidence' },
            400,
          )
        }
        const now = this.#now()
        const effectiveFrom = textOrEmpty(input.effectiveFrom) || now
        if (Number.isNaN(Date.parse(effectiveFrom)) || Date.parse(effectiveFrom) > Date.parse(now)) {
          throw new TaskServiceError(
            'decision_validation_failed',
            'effectiveFrom must be a valid time not later than now',
            { field: 'effectiveFrom', value: effectiveFrom, now },
            400,
          )
        }
        this.#insertDecisionEvidence(current.decisionId, input.evidence, input.actor, now)
        this.#db
          .prepare(
            `UPDATE decisions SET status = 'implemented', approved_by = ?, approved_at = ?,
               effective_from = ?, reject_reason = '', archive_reason = '',
               version = version + 1, updated_at = ? WHERE decision_id = ?`,
          )
          .run(actorIdentity(input.actor), now, effectiveFrom, now, current.decisionId)
        this.#appendDecisionAudit(current.decisionId, 'decision_implemented', input.actor, current.version + 1, {
          effectiveFrom,
          evidenceCount: input.evidence.length,
        })
        return this.#loadDecision(current.decisionId)
      })
    } catch (error) {
      this.#throwDecisionConstraint(error)
    }
  }

  /**
   * Reject a proposal. Rejected Decisions are terminal and cannot be revived in place.
   * @param input - expected version and required reason.
   * @returns the rejected Decision.
   */
  decisionReject(input: RejectDecisionInput): DecisionRecord {
    this.#requireDecisionUser(input.actor, 'reject')
    try {
      return this.#transaction(() => {
        const current = this.#loadDecision(input.decisionId)
        this.#checkDecisionVersion(current, input.ifVersion)
        if (current.status !== 'proposed') {
          throw new TaskServiceError(
            'invalid_transition',
            `cannot reject a decision in status ${current.status}`,
            { decisionId: current.decisionId, status: current.status, version: current.version },
            409,
          )
        }
        const reason = requireText(input.reason, 'reason')
        const now = this.#now()
        this.#db
          .prepare(
            `UPDATE decisions SET status = 'rejected', reject_reason = ?,
               version = version + 1, updated_at = ? WHERE decision_id = ?`,
          )
          .run(reason, now, current.decisionId)
        this.#appendDecisionAudit(current.decisionId, 'decision_rejected', input.actor, current.version + 1, { reason })
        return this.#loadDecision(current.decisionId)
      })
    } catch (error) {
      this.#throwDecisionConstraint(error)
    }
  }

  /**
   * Archive an implemented Decision without rewriting its approval evidence.
   * @param input - expected version and archive reason.
   * @returns the archived Decision.
   */
  decisionArchive(input: ArchiveDecisionInput): DecisionRecord {
    this.#requireDecisionUser(input.actor, 'archive')
    try {
      return this.#transaction(() => {
        const current = this.#loadDecision(input.decisionId)
        this.#checkDecisionVersion(current, input.ifVersion)
        if (current.status !== 'implemented') {
          throw new TaskServiceError(
            'invalid_transition',
            `cannot archive a decision in status ${current.status}`,
            { decisionId: current.decisionId, status: current.status, version: current.version },
            409,
          )
        }
        const reason = assertEnum(input.reason, DECISION_ARCHIVE_REASONS, 'reason')
        const now = this.#now()
        this.#db
          .prepare(
            `UPDATE decisions SET status = 'archived', archive_reason = ?,
               version = version + 1, updated_at = ? WHERE decision_id = ?`,
          )
          .run(reason, now, current.decisionId)
        this.#appendDecisionAudit(current.decisionId, 'decision_archived', input.actor, current.version + 1, { reason })
        return this.#loadDecision(current.decisionId)
      })
    } catch (error) {
      this.#throwDecisionConstraint(error)
    }
  }

  /**
   * Archive an implemented Decision because an existing proposal supersedes it.
   * @param input - old Decision version and the proposed successor id.
   * @returns the archived old Decision and the revised successor.
   */
  decisionSupersede(input: SupersedeDecisionInput): { archived: DecisionRecord; successor: DecisionRecord } {
    this.#requireDecisionUser(input.actor, 'supersede')
    try {
      return this.#transaction(() => {
        const current = this.#loadDecision(input.decisionId)
        this.#checkDecisionVersion(current, input.ifVersion)
        if (current.status !== 'implemented') {
          throw new TaskServiceError(
            'invalid_transition',
            `cannot supersede a decision in status ${current.status}`,
            { decisionId: current.decisionId, status: current.status, version: current.version },
            409,
          )
        }
        const successorId = requireText(input.successorDecisionId, 'successorDecisionId')
        if (successorId === current.decisionId) {
          throw new TaskServiceError('decision_validation_failed', 'a decision cannot supersede itself', {
            decisionId: current.decisionId,
          }, 400)
        }
        const successor = this.#loadDecision(successorId)
        if (successor.projectId !== current.projectId) {
          throw new TaskServiceError('decision_validation_failed', 'successor belongs to another project', {
            decisionId: current.decisionId,
            successorDecisionId: successorId,
          }, 400)
        }
        if (successor.status !== 'proposed') {
          throw new TaskServiceError('decision_validation_failed', 'successor must still be proposed', {
            successorDecisionId: successorId,
            status: successor.status,
          }, 409)
        }
        if (successor.supersedesId !== null && successor.supersedesId !== current.decisionId) {
          throw new TaskServiceError('decision_validation_failed', 'successor already targets another decision', {
            successorDecisionId: successorId,
            supersedesId: successor.supersedesId,
          }, 409)
        }
        const now = this.#now()
        this.#db
          .prepare(
            `UPDATE decisions SET supersedes_id = ?, version = version + 1, updated_at = ?
             WHERE decision_id = ?`,
          )
          .run(current.decisionId, now, successor.decisionId)
        this.#db
          .prepare(
            `UPDATE decisions SET status = 'archived', archive_reason = 'superseded',
               version = version + 1, updated_at = ? WHERE decision_id = ?`,
          )
          .run(now, current.decisionId)
        this.#db
          .prepare(
            `INSERT INTO decision_relations(
               relation_id, source_decision_id, target_decision_id, relation_type,
               evidence_ref, created_by, created_at)
             VALUES (?, ?, ?, 'supersedes', '', ?, ?)`,
          )
          .run(`rel_${this.#newId()}`, successor.decisionId, current.decisionId, actorIdentity(input.actor), now)
        this.#appendDecisionAudit(current.decisionId, 'decision_superseded', input.actor, current.version + 1, {
          successorDecisionId: successor.decisionId,
        })
        this.#appendDecisionAudit(successor.decisionId, 'decision_marked_successor', input.actor, successor.version + 1, {
          supersedesDecisionId: current.decisionId,
        })
        return {
          archived: this.#loadDecision(current.decisionId),
          successor: this.#loadDecision(successor.decisionId),
        }
      })
    } catch (error) {
      this.#throwDecisionConstraint(error)
    }
  }

  /**
   * Search Decisions with mutually exclusive proposed, authoritative and historical collections.
   * @param input - project, filters and bounded limit.
   * @returns matching Decisions and explicit partial coverage.
   */
  decisionSearch(input: SearchDecisionsInput): DecisionSearchResult {
    const projectId = requireText(input.projectId, 'projectId')
    if (this.#db.prepare('SELECT 1 AS ok FROM projects WHERE project_id = ?').get(projectId) === undefined) {
      throw new TaskServiceError('project_not_found', `project ${projectId} does not exist`, { projectId }, 404)
    }
    const clauses = ['project_id = ?']
    const params: Array<string | number> = [projectId]
    const collection = input.collection ?? 'all'
    if (collection === 'proposed') clauses.push("status = 'proposed'")
    if (collection === 'authoritative') clauses.push("status = 'implemented'")
    if (collection === 'historical') clauses.push("status IN ('rejected','archived')")
    if (input.status !== undefined) {
      clauses.push('status = ?')
      params.push(assertEnum(input.status, DECISION_STATUSES, 'status'))
    }
    if (input.authorityScope !== undefined) {
      clauses.push('authority_scope = ?')
      params.push(assertEnum(input.authorityScope, DECISION_AUTHORITY_SCOPES, 'authorityScope'))
    }
    if (input.authorityLevel !== undefined) {
      clauses.push('authority_level = ?')
      params.push(assertEnum(input.authorityLevel, DECISION_AUTHORITY_LEVELS, 'authorityLevel'))
    }
    if (input.subjectType !== undefined) {
      clauses.push('subject_type = ?')
      params.push(assertEnum(input.subjectType, DECISION_SUBJECT_TYPES, 'subjectType'))
    }
    if (input.subjectId !== undefined) {
      clauses.push('subject_id = ?')
      params.push(textOrEmpty(input.subjectId))
    }
    if (input.decisionKey !== undefined) {
      clauses.push('decision_key = ?')
      params.push(textOrEmpty(input.decisionKey))
    }
    if (input.q !== undefined && input.q.trim() !== '') {
      clauses.push('(title LIKE ? OR decision_key LIKE ? OR problem LIKE ? OR proposal LIKE ? OR rationale LIKE ?)')
      const like = `%${input.q.trim()}%`
      params.push(like, like, like, like, like)
    }
    const where = clauses.join(' AND ')
    const limit = Math.min(Math.max(Math.trunc(input.limit ?? 50), 1), 200)
    const rows = this.#db
      .prepare(`SELECT * FROM decisions WHERE ${where} ORDER BY updated_at DESC, decision_id LIMIT ?`)
      .all(...params, limit) as unknown as DecisionRow[]
    const count = this.#db.prepare(`SELECT COUNT(*) AS n FROM decisions WHERE ${where}`).get(...params) as { n: number }
    return { decisions: rows.map(toDecision), total: count.n, searchCoverage: 'partial' }
  }

  /**
   * Read one Decision with immutable evidence, relations and audit history.
   * @param decisionId - Decision id.
   * @returns the Decision detail.
   */
  decisionGet(decisionId: string): DecisionDetail {
    const decision = this.#loadDecision(decisionId)
    const evidence = this.#db
      .prepare('SELECT * FROM decision_evidence WHERE decision_id = ? ORDER BY created_at, evidence_id')
      .all(decision.decisionId) as unknown as DecisionEvidenceRow[]
    const relations = this.#db
      .prepare(
        `SELECT * FROM decision_relations
         WHERE source_decision_id = ? OR target_decision_id = ?
         ORDER BY created_at, relation_id`,
      )
      .all(decision.decisionId, decision.decisionId) as unknown as DecisionRelationRow[]
    const audit = this.#db
      .prepare('SELECT * FROM decision_audit WHERE decision_id = ? ORDER BY created_at, audit_id')
      .all(decision.decisionId) as unknown as DecisionAuditRow[]
    return {
      decision,
      evidence: evidence.map(toDecisionEvidence),
      relations: relations.map(toDecisionRelation),
      audit: audit.map(toDecisionAudit),
    }
  }

  /**
   * Read a task and its allowed actions.
   * @param taskId - task id.
   * @returns the task and the transitions its mode and status allow.
   */
  getTask(taskId: string): TaskDetail {
    const task = this.#loadTask(taskId)
    return {
      task,
      allowed: this.#allowedTransitions(task),
      comments: this.#listComments(taskId),
      criteria: this.#listCriteria(taskId),
      reports: this.#listReports(taskId),
    }
  }

  /**
   * Advance a task along one edge of its lifecycle.
   * @param input - target status, expected version and actor.
   * @returns the updated task.
   */
  advance(input: MutationInput & { to: string; comment?: string }): TaskRecord {
    return this.#transaction(() => {
      const task = this.#loadTask(input.taskId)
      this.#checkVersion(task, input.ifVersion)
      const edge = this.#edge(task.lifecycleMode, task.status, input.to)
      if (edge === undefined) {
        throw new TaskServiceError(
          'invalid_transition',
          `cannot move ${task.status} to ${input.to} in ${task.lifecycleMode}`,
          { from: task.status, to: input.to, mode: task.lifecycleMode, version: task.version },
        )
      }
      if (edge.requiresUser && input.actor.type !== 'user') {
        throw new TaskServiceError(
          'user_approval_required',
          `transition ${task.status} -> ${input.to} requires a user`,
          { action: edge.action, version: task.version },
          403,
        )
      }
      this.#applyTransition(task, input.to, input.actor, {
        from: task.status,
        to: input.to,
        action: edge.action,
        ...(input.comment === undefined ? {} : { comment: input.comment }),
      })
      return this.#loadTask(input.taskId)
    })
  }

  /**
   * Bind a task to the caller's thread.
   * @param input - thread to bind and expected version.
   * @returns the task; an already-bound identical thread is idempotent.
   */
  claim(input: MutationInput & { threadId: string }): TaskRecord {
    if (input.threadId.trim() === '') {
      throw new TaskServiceError('invalid_request', 'threadId is required', {}, 400)
    }
    return this.#transaction(() => {
      const task = this.#loadTask(input.taskId)
      if (task.threadId === input.threadId) return task
      if (task.threadId !== null) {
        throw new TaskServiceError(
          'thread_conflict',
          'task is already bound to another thread',
          { currentThreadId: task.threadId, version: task.version },
          409,
        )
      }
      this.#checkVersion(task, input.ifVersion)
      this.#bump(task.taskId, { thread_id: input.threadId })
      this.#appendEvent(task.taskId, 'claimed', input.actor, { threadId: input.threadId })
      return this.#loadTask(input.taskId)
    })
  }

  /**
   * Return a task to an earlier stage.
   * @param input - alias (`local`/`partial`/`global`) or explicit target status.
   * @returns the updated task.
   */
  rollback(input: MutationInput & { alias?: 'local' | 'partial' | 'global'; targetStatus?: string; reason: string }): TaskRecord {
    const target = input.targetStatus ?? (input.alias === undefined ? undefined : ROLLBACK_ALIASES[input.alias])
    if (target === undefined) {
      throw new TaskServiceError('invalid_request', 'rollback needs targetStatus or an alias', {}, 400)
    }
    return this.#transaction(() => {
      const task = this.#loadTask(input.taskId)
      this.#checkVersion(task, input.ifVersion)
      const edge = this.#edge(task.lifecycleMode, task.status, target)
      if (edge === undefined) {
        throw new TaskServiceError(
          'invalid_transition',
          `cannot roll back ${task.status} to ${target}`,
          { from: task.status, to: target, version: task.version },
        )
      }
      if (edge.requiresUser && input.actor.type !== 'user') {
        throw new TaskServiceError('user_approval_required', 'rollback requires a user', { action: edge.action }, 403)
      }
      this.#applyTransition(task, target, input.actor, {
        from: task.status,
        to: target,
        action: edge.action,
        reason: input.reason,
        ...(input.alias === undefined ? {} : { alias: input.alias }),
      }, 'rolled_back')
      return this.#loadTask(input.taskId)
    })
  }

  /**
   * Close a task after the acceptance and proposal gates pass.
   * @param input - expected version and the acting user.
   * @returns the closed task.
   */
  close(input: MutationInput & { comment?: string }): TaskRecord {
    return this.#transaction(() => {
      const task = this.#loadTask(input.taskId)
      this.#checkVersion(task, input.ifVersion)
      if (task.lifecycleMode === 'p0') {
        throw new TaskServiceError('invalid_request', 'P0 tasks close through advance()', {}, 400)
      }
      if (task.status === 'closed') {
        throw new TaskServiceError('invalid_transition', 'task is already closed', { version: task.version })
      }
      if (task.status !== 'validating' && task.status !== 'closing') {
        throw new TaskServiceError(
          'invalid_transition',
          `close starts from validating, not ${task.status}`,
          { from: task.status, version: task.version },
        )
      }
      if (input.actor.type !== 'user') {
        throw new TaskServiceError('user_approval_required', 'closing requires a user', {}, 403)
      }
      const blockers = this.#closeBlockers(task.taskId)
      if (blockers.length > 0) {
        throw new TaskServiceError('close_blocked', 'close gates are not satisfied', { blockers }, 400)
      }
      const now = this.#now()
      const steps = task.status === 'validating' ? ['closing', 'closed'] : ['closed']
      for (const step of steps) {
        this.#db
          .prepare('UPDATE tasks SET status = ?, closed_at = ? WHERE task_id = ?')
          .run(step, step === 'closed' ? now : task.closedAt, task.taskId)
      }
      this.#db
        .prepare('UPDATE tasks SET version = version + 1, updated_at = ? WHERE task_id = ?')
        .run(now, task.taskId)
      for (const step of steps) {
        this.#appendEvent(task.taskId, 'advanced', input.actor, {
          from: step === 'closed' && steps.length === 2 ? 'closing' : task.status,
          to: step,
          action: step === 'closed' ? 'close' : 'accept',
          ...(input.comment === undefined ? {} : { comment: input.comment }),
        })
      }
      return this.#loadTask(task.taskId)
    })
  }

  /**
   * Update the editable task fields.
   * @param input - field patch and expected version.
   * @returns the updated task.
   */
  updateTask(input: MutationInput & { patch: TaskPatch }): TaskRecord {
    const allowed = new Set([
      'title',
      'description',
      'task_type',
      'risk_level',
      'assignee_name',
      'sort_order',
      'style_id',
      'parent_task_id',
    ])
    const entries = Object.entries(input.patch).filter(([, value]) => value !== undefined)
    if (entries.length === 0) {
      throw new TaskServiceError('invalid_request', 'patch is empty', {}, 400)
    }
    for (const [key, value] of entries) {
      if (!allowed.has(key)) {
        throw new TaskServiceError('invalid_request', `field ${key} is not editable`, { field: key }, 400)
      }
      if (key === 'title' && (typeof value !== 'string' || value.trim() === '')) {
        throw new TaskServiceError('invalid_request', 'title cannot be empty', {}, 400)
      }
      if (key === 'task_type' && !['code', 'knowledge', 'design', 'hybrid'].includes(String(value))) {
        throw new TaskServiceError('invalid_request', `unknown task_type ${String(value)}`, {}, 400)
      }
      if (key === 'risk_level' && !['low', 'medium', 'high'].includes(String(value))) {
        throw new TaskServiceError('invalid_request', `unknown risk_level ${String(value)}`, {}, 400)
      }
    }
    return this.#transaction(() => {
      const task = this.#loadTask(input.taskId)
      this.#checkVersion(task, input.ifVersion)
      const parent = input.patch.parent_task_id
      if (typeof parent === 'string') {
        if (parent === input.taskId) {
          throw new TaskServiceError('invalid_request', 'a task cannot be its own parent', {}, 400)
        }
        this.#loadTask(parent)
        const cycle = this.#db
          .prepare(
            `WITH RECURSIVE ancestors(id) AS (
               SELECT ?
               UNION
               SELECT t.parent_task_id FROM tasks t JOIN ancestors a ON t.task_id = a.id
               WHERE t.parent_task_id IS NOT NULL
             )
             SELECT 1 AS ok FROM ancestors WHERE id = ?`,
          )
          .get(parent, input.taskId)
        if (cycle !== undefined) {
          throw new TaskServiceError('relation_cycle', 'reparenting would create a cycle', {}, 409)
        }
      }
      this.#db
        .prepare(
          `UPDATE tasks SET title = ?, description = ?, task_type = ?, risk_level = ?,
             assignee_name = ?, sort_order = ?, style_id = ?, parent_task_id = ? WHERE task_id = ?`,
        )
        .run(
          input.patch.title ?? task.title,
          input.patch.description ?? (task.description === '' ? null : task.description),
          input.patch.task_type ?? task.taskType,
          input.patch.risk_level ?? task.riskLevel,
          input.patch.assignee_name === undefined ? task.assigneeName : input.patch.assignee_name,
          input.patch.sort_order ?? 0,
          input.patch.style_id ?? null,
          input.patch.parent_task_id === undefined ? task.parentTaskId : input.patch.parent_task_id,
          input.taskId,
        )
      this.#touch(input.taskId, 'updated', input.actor, { fields: entries.map(([key]) => key) })
      return this.#loadTask(input.taskId)
    })
  }

  /**
   * Append a comment, optionally a review decision.
   * @param input - body, comment kind, optional decision and rollback target.
   * @returns the stored comment.
   */
  addComment(
    input: MutationInput & {
      body: string
      commentType?: CommentType
      decision?: ReportDecision
      rollbackTarget?: string
      threadId?: string
      mentions?: readonly string[]
      reportId?: string
    },
  ): CommentRecord {
    const body = input.body.trim()
    if (body === '') throw new TaskServiceError('invalid_request', 'comment body is empty', {}, 400)
    const commentType = input.commentType ?? 'discussion'
    if (input.decision !== undefined && commentType !== 'review') {
      throw new TaskServiceError('invalid_request', 'decision is only valid on review comments', {}, 400)
    }
    for (const mention of input.mentions ?? []) {
      if (!(MENTION_TARGETS as readonly string[]).includes(mention)) {
        throw new TaskServiceError('invalid_request', `unknown mention ${mention}`, { mention }, 400)
      }
    }
    const commentId = `cmt_${this.#newId()}`
    const task = this.#transaction(() => {
      const current = this.#loadTask(input.taskId)
      this.#checkVersion(current, input.ifVersion)
      this.#db
        .prepare(
          `INSERT INTO task_comments(comment_id, task_id, report_id, author_type, author_id, author_name,
             body, comment_type, decision, rollback_target, thread_id, mentions, version, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
        )
        .run(
          commentId,
          input.taskId,
          input.reportId ?? null,
          input.actor.type,
          input.actor.id ?? null,
          input.actor.name ?? null,
          body,
          commentType,
          input.decision ?? null,
          input.rollbackTarget ?? null,
          input.threadId ?? null,
          input.mentions === undefined ? null : JSON.stringify(input.mentions),
          this.#now(),
          this.#now(),
        )
      this.#touch(input.taskId, 'commented', input.actor, {
        commentId,
        commentType,
        ...(input.decision === undefined ? {} : { decision: input.decision }),
      })
      return current
    })

    if (input.decision === 'request_changes' && input.rollbackTarget !== undefined) {
      try {
        this.rollback({
          taskId: input.taskId,
          targetStatus: input.rollbackTarget,
          reason: body,
          ifVersion: task.version + 1,
          actor: input.actor,
        })
      } catch (error) {
        throw new TaskServiceError(
          'rollback_failed',
          'review comment was stored, but the rollback failed',
          { commentId, rollbackError: error instanceof Error ? error.message : String(error) },
          409,
        )
      }
    }
    return this.#loadComment(commentId)
  }

  /**
   * Add an acceptance criterion.
   * @param input - description and optional check type.
   * @returns the stored criterion.
   */
  addCriteria(input: MutationInput & { description: string; checkType?: 'auto' | 'manual' }): CriteriaRecord {
    const description = input.description.trim()
    if (description === '') throw new TaskServiceError('invalid_request', 'criteria description is empty', {}, 400)
    const criteriaId = `crit_${this.#newId()}`
    this.#transaction(() => {
      const task = this.#loadTask(input.taskId)
      this.#checkVersion(task, input.ifVersion)
      this.#db
        .prepare(
          `INSERT INTO acceptance_criteria(criteria_id, task_id, description, check_type, status, version)
           VALUES (?, ?, ?, ?, 'pending', 0)`,
        )
        .run(criteriaId, input.taskId, description, input.checkType ?? 'manual')
      this.#touch(input.taskId, 'criteria_added', input.actor, { criteriaId })
    })
    return this.#loadCriteria(criteriaId)
  }

  /**
   * Record the result of one acceptance criterion.
   * @param input - criterion id and its new status.
   * @returns the updated criterion.
   */
  setCriteriaStatus(input: MutationInput & { criteriaId: string; status: 'passed' | 'failed' }): CriteriaRecord {
    this.#transaction(() => {
      const task = this.#loadTask(input.taskId)
      this.#checkVersion(task, input.ifVersion)
      const changed = this.#db
        .prepare('UPDATE acceptance_criteria SET status = ?, checked_at = ?, version = version + 1 WHERE criteria_id = ? AND task_id = ?')
        .run(input.status, this.#now(), input.criteriaId, input.taskId)
      if (changed.changes === 0) {
        throw new TaskServiceError('invalid_request', `criteria ${input.criteriaId} not found on task`, {}, 404)
      }
      this.#touch(input.taskId, 'criteria_checked', input.actor, { criteriaId: input.criteriaId, status: input.status })
    })
    return this.#loadCriteria(input.criteriaId)
  }

  /**
   * Submit a formal report from an agent's run.
   * @param input - markdown body, optional artifacts and self-check.
   * @returns the stored report.
   */
  submitReport(
    input: MutationInput & {
      content: string
      agentId?: string
      sessionId?: string
      artifactIds?: readonly string[]
      acceptanceSelfCheck?: Record<string, unknown>
    },
  ): ReportRecord {
    const content = input.content.trim()
    if (content === '') throw new TaskServiceError('invalid_request', 'report content is empty', {}, 400)
    for (const artifactId of input.artifactIds ?? []) {
      const row = this.#db
        .prepare('SELECT 1 AS ok FROM task_artifacts WHERE artifact_id = ? AND task_id = ?')
        .get(artifactId, input.taskId)
      if (row === undefined) {
        throw new TaskServiceError('invalid_request', `artifact ${artifactId} does not belong to this task`, { artifactId }, 400)
      }
    }
    const reportId = `rep_${this.#newId()}`
    let shouldAdvance = false
    this.#transaction(() => {
      const task = this.#loadTask(input.taskId)
      this.#checkVersion(task, input.ifVersion)
      this.#db
        .prepare(
          `INSERT INTO task_reports(report_id, task_id, agent_id, session_id, content, artifact_ids,
             acceptance_self_check, status, version, submitted_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'submitted', 0, ?)`,
        )
        .run(
          reportId,
          input.taskId,
          input.agentId ?? input.actor.id ?? null,
          input.sessionId ?? null,
          content,
          input.artifactIds === undefined ? null : JSON.stringify(input.artifactIds),
          input.acceptanceSelfCheck === undefined ? null : JSON.stringify(input.acceptanceSelfCheck),
          this.#now(),
        )
      const activeRun = this.#db
        .prepare(
          `SELECT link_id FROM task_runs
           WHERE task_id = ? AND status IN ('pending','running')
           ORDER BY linked_at DESC LIMIT 1`,
        )
        .get(input.taskId) as { link_id: string } | undefined
      if (activeRun !== undefined) {
        this.#db.prepare("UPDATE task_runs SET status = 'succeeded' WHERE link_id = ?").run(activeRun.link_id)
      }
      shouldAdvance = task.status === 'in_progress'
      this.#touch(input.taskId, 'report_submitted', input.actor, { reportId })
    })
    if (shouldAdvance) {
      try {
        this.advance({
          taskId: input.taskId,
          to: 'validating',
          ifVersion: input.ifVersion,
          actor: input.actor,
          comment: '报告已提交，进入验收',
        })
      } catch {
        // The report is durable even if another writer won the version race.
        // The caller sees the successful report and can refresh the task.
      }
    }
    return this.#loadReport(reportId)
  }

  /**
   * Approve a report or request changes; only a user may review.
   * @param input - report, decision and the review comment.
   * @returns the updated report.
   */
  reviewReport(input: MutationInput & { reportId: string; decision: ReportDecision; comment: string }): ReportRecord {
    if (input.actor.type !== 'user') {
      throw new TaskServiceError('user_approval_required', 'only a user may review a report', {}, 403)
    }
    this.#transaction(() => {
      const task = this.#loadTask(input.taskId)
      this.#checkVersion(task, input.ifVersion)
      const report = this.#loadReport(input.reportId)
      if (report.taskId !== input.taskId) {
        throw new TaskServiceError('report_not_found', 'report does not belong to this task', {}, 404)
      }
      if (report.status !== 'submitted') {
        throw new TaskServiceError('invalid_request', `report is ${report.status}, not submitted`, {}, 409)
      }
      this.#db
        .prepare('UPDATE task_reports SET status = ?, version = version + 1 WHERE report_id = ?')
        .run(input.decision === 'approve' ? 'approved' : 'changes_requested', input.reportId)
      this.#db
        .prepare(
          `INSERT INTO task_comments(comment_id, task_id, report_id, author_type, author_id, author_name,
             body, comment_type, decision, version, created_at, updated_at)
           VALUES (?, ?, ?, 'user', ?, ?, ?, 'review', ?, 0, ?, ?)`,
        )
        .run(
          `cmt_${this.#newId()}`,
          input.taskId,
          input.reportId,
          input.actor.id ?? null,
          input.actor.name ?? null,
          input.comment,
          input.decision,
          this.#now(),
          this.#now(),
        )
      this.#touch(input.taskId, 'report_reviewed', input.actor, { reportId: input.reportId, decision: input.decision })
    })
    return this.#loadReport(input.reportId)
  }

  /**
   * Add a relation; a `parent` relation also updates `tasks.parent_task_id`.
   * @param input - relation kind and the other task.
   * @returns nothing; throws `relation_cycle` when the parent edge closes a loop.
   */
  addRelation(input: MutationInput & {
    relationType: 'parent' | 'blocks' | 'related'
    targetTaskId: string
  }): void {
    if (input.targetTaskId === input.taskId) {
      throw new TaskServiceError('invalid_request', 'a task cannot relate to itself', {}, 400)
    }
    this.#transaction(() => {
      const task = this.#loadTask(input.taskId)
      this.#checkVersion(task, input.ifVersion)
      this.#loadTask(input.targetTaskId)
      try {
        this.#db
          .prepare(
            `INSERT INTO task_relations(relation_id, relation_type, source_task_id, target_task_id, version, created_at)
             VALUES (?, ?, ?, ?, 0, ?)`,
          )
          .run(`rel_${this.#newId()}`, input.relationType, input.taskId, input.targetTaskId, this.#now())
      } catch (error) {
        if (error instanceof Error && error.message.includes('RELATION_CYCLE')) {
          throw new TaskServiceError('relation_cycle', 'parent relation would create a cycle', {}, 409)
        }
        throw error
      }
      this.#touch(input.taskId, 'relation_added', input.actor, {
        relationType: input.relationType,
        targetTaskId: input.targetTaskId,
      })
    })
  }

  /**
   * Start an execution binding and acquire one active lease for it.
   * @param input - optional idempotency key, session pointer and lease TTL.
   * @returns the run plus lease; a repeated key returns the same active binding.
   */
  execute(input: MutationInput & {
    role?: 'main_execution' | 'validation' | 'discussion'
    idempotencyKey?: string
    sessionId?: string
    runId?: string
    leaseTtlMs?: number
  }): ExecutionRunRecord {
    return this.#transaction(() => {
      const task = this.#loadTask(input.taskId)
      this.#assertExecutionReady(task.taskId)
      if (task.status !== 'backlog' && task.status !== 'in_progress') {
        throw new TaskServiceError(
          'invalid_transition',
          `only backlog or in_progress tasks can start a run, not ${task.status}`,
          { status: task.status },
        )
      }
      if (input.idempotencyKey !== undefined) {
        const existing = this.#db
          .prepare('SELECT * FROM task_runs WHERE task_id = ? AND idempotency_key = ?')
          .get(input.taskId, input.idempotencyKey) as unknown as RunRow | undefined
        if (existing !== undefined) {
          const run = toRun(existing)
          const lease = this.#loadLeaseByLink(run.linkId) ?? this.#createLease(run, input.leaseTtlMs)
          return { ...run, lease }
        }
      }
      this.#checkVersion(task, input.ifVersion)
      const active = this.#db
        .prepare("SELECT 1 AS ok FROM task_runs WHERE task_id = ? AND status IN ('pending','running')")
        .get(input.taskId)
      if (active !== undefined) {
        throw new TaskServiceError('active_run_conflict', 'task already has an active run', { taskId: input.taskId }, 409)
      }
      const linkId = `run_${this.#newId()}`
      this.#db
        .prepare(
          `INSERT INTO task_runs(link_id, task_id, run_id, session_id, role, status, idempotency_key, linked_at)
           VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
        )
        .run(
          linkId,
          input.taskId,
          input.runId ?? null,
          input.sessionId ?? null,
          input.role ?? 'main_execution',
          input.idempotencyKey ?? null,
          this.#now(),
        )
      const run = this.#loadRun(linkId)
      const lease = this.#createLease(run, input.leaseTtlMs)
      this.#touch(input.taskId, 'run_started', input.actor, { linkId, leaseId: lease.leaseId, expiresAt: lease.expiresAt })
      return { ...run, lease }
    })
  }

  /**
   * Mark a pending run as running once the agent turn has actually begun.
   * @param input - task and run identity.
   * @returns the updated run.
   */
  startRun(input: { taskId: string; linkId: string; actor: Actor }): RunRecord {
    return this.#transaction(() => {
      const run = this.#loadRun(input.linkId)
      if (run.taskId !== input.taskId) throw new TaskServiceError('invalid_request', 'run does not belong to this task', {}, 400)
      if (run.status === 'running') return run
      if (run.status !== 'pending') throw new TaskServiceError('invalid_request', `run is ${run.status}`, {}, 409)
      this.#db.prepare("UPDATE task_runs SET status = 'running' WHERE link_id = ?").run(input.linkId)
      this.#touch(input.taskId, 'run_running', input.actor, { linkId: input.linkId })
      return this.#loadRun(input.linkId)
    })
  }

  /**
   * Heartbeat an active lease. Expired leases are marked expired and rejected.
   * @param input - task, lease identity and optional TTL.
   * @returns the updated lease.
   */
  heartbeatLease(input: {
    taskId: string
    leaseId: string
    leaseToken: string
    actor: Actor
    ttlMs?: number
  }): LeaseRecord {
    return this.#transaction(() => {
      const lease = this.#loadLease(input.leaseId)
      if (lease.taskId !== input.taskId) throw new TaskServiceError('lease_not_found', 'lease does not belong to this task', {}, 404)
      if (lease.leaseToken !== input.leaseToken) throw new TaskServiceError('lease_conflict', 'lease token mismatch', {}, 409)
      if (lease.status !== 'active') throw new TaskServiceError('lease_conflict', `lease is ${lease.status}`, {}, 409)
      const now = this.#now()
      if (lease.expiresAt <= now) {
        this.#db.prepare("UPDATE task_leases SET status = 'expired', released_at = ?, version = version + 1 WHERE lease_id = ?").run(now, input.leaseId)
        throw new TaskServiceError('lease_expired', 'lease has expired', { leaseId: input.leaseId }, 409)
      }
      const ttl = Math.max(1_000, input.ttlMs ?? 15 * 60_000)
      const expiresAt = new Date(Date.parse(now) + ttl).toISOString()
      this.#db
        .prepare('UPDATE task_leases SET heartbeat_at = ?, expires_at = ?, version = version + 1 WHERE lease_id = ?')
        .run(now, expiresAt, input.leaseId)
      this.#touch(input.taskId, 'lease_heartbeat', input.actor, { leaseId: input.leaseId, expiresAt })
      return this.#loadLease(input.leaseId)
    })
  }

  /**
   * Release, revoke or expire one lease.
   * @param input - lease identity and terminal state.
   * @returns the updated lease.
   */
  releaseLease(input: {
    taskId: string
    leaseId: string
    leaseToken: string
    status: 'released' | 'revoked' | 'expired'
    actor: Actor
  }): LeaseRecord {
    return this.#transaction(() => {
      const lease = this.#loadLease(input.leaseId)
      if (lease.taskId !== input.taskId) throw new TaskServiceError('lease_not_found', 'lease does not belong to this task', {}, 404)
      if (lease.leaseToken !== input.leaseToken) throw new TaskServiceError('lease_conflict', 'lease token mismatch', {}, 409)
      if (lease.status !== 'active') return lease
      const now = this.#now()
      this.#db
        .prepare('UPDATE task_leases SET status = ?, released_at = ?, version = version + 1 WHERE lease_id = ?')
        .run(input.status, now, input.leaseId)
      this.#touch(input.taskId, `lease_${input.status}`, input.actor, { leaseId: input.leaseId })
      return this.#loadLease(input.leaseId)
    })
  }

  /**
   * Assert that a lease is active and has not expired.
   * @param input - task and opaque lease token.
   * @returns the active lease.
   */
  assertLease(input: { taskId: string; leaseId?: string; leaseToken: string }): LeaseRecord {
    const lease = input.leaseId === undefined
      ? this.#loadLeaseByTask(input.taskId)
      : this.#loadLease(input.leaseId)
    if (lease === undefined || lease.taskId !== input.taskId) {
      throw new TaskServiceError('lease_not_found', 'active lease was not found', { taskId: input.taskId }, 404)
    }
    if (lease.leaseToken !== input.leaseToken) throw new TaskServiceError('lease_conflict', 'lease token mismatch', {}, 409)
    if (lease.status !== 'active') throw new TaskServiceError('lease_conflict', `lease is ${lease.status}`, {}, 409)
    if (lease.expiresAt <= this.#now()) throw new TaskServiceError('lease_expired', 'lease has expired', { leaseId: lease.leaseId }, 409)
    return lease
  }

  /** List every lease for one task, newest first. */
  listLeases(taskId: string): LeaseRecord[] {
    return (this.#db.prepare('SELECT * FROM task_leases WHERE task_id = ? ORDER BY acquired_at DESC').all(taskId) as unknown as LeaseRow[])
      .map(toLease)
  }

  /**
   * Settle a run with a terminal status and release its active lease.
   * @param input - run link id and terminal status.
   * @returns the updated run.
   */
  finishRun(input: { taskId: string; linkId: string; status: 'succeeded' | 'failed' | 'canceled' | 'unknown'; actor: Actor }): RunRecord {
    this.#transaction(() => {
      const run = this.#loadRun(input.linkId)
      if (run.taskId !== input.taskId) {
        throw new TaskServiceError('invalid_request', 'run does not belong to this task', {}, 400)
      }
      if (run.status !== 'pending' && run.status !== 'running') {
        throw new TaskServiceError('invalid_request', `run is already ${run.status}`, {}, 409)
      }
      this.#db.prepare('UPDATE task_runs SET status = ? WHERE link_id = ?').run(input.status, input.linkId)
      this.#db
        .prepare("UPDATE task_leases SET status = 'released', released_at = ?, version = version + 1 WHERE link_id = ? AND status = 'active'")
        .run(this.#now(), input.linkId)
      this.#touch(input.taskId, 'run_finished', input.actor, { linkId: input.linkId, status: input.status })
    })
    return this.#loadRun(input.linkId)
  }

  /**
   * List the executions recorded for a task.
   * @param taskId - task id.
   * @returns runs newest first.
   */
  listRuns(taskId: string): RunRecord[] {
    return (this.#db.prepare('SELECT * FROM task_runs WHERE task_id = ? ORDER BY linked_at DESC').all(taskId) as unknown as RunRow[])
      .map(toRun)
  }

  #createLease(run: RunRecord, ttlMs?: number): LeaseRecord {
    const now = this.#now()
    const ttl = Math.max(1_000, ttlMs ?? 15 * 60_000)
    const leaseId = `lease_${this.#newId()}`
    const sessionId = run.sessionId ?? run.runId ?? run.linkId
    const leaseToken = `${randomUUID().replaceAll('-', '')}${randomUUID().replaceAll('-', '')}`
    this.#db
      .prepare(
        `INSERT INTO task_leases(
           lease_id, task_id, link_id, holder_type, holder_id, session_id, lease_token,
           authority_epoch, status, acquired_at, heartbeat_at, expires_at, released_at, version)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'active', ?, ?, ?, '', 0)`,
      )
      .run(
        leaseId,
        run.taskId,
        run.linkId,
        run.sessionId === null ? 'service' : 'session',
        run.sessionId ?? run.linkId,
        sessionId,
        leaseToken,
        now,
        now,
        new Date(Date.parse(now) + ttl).toISOString(),
      )
    return this.#loadLease(leaseId)
  }

  #loadLease(leaseId: string): LeaseRecord {
    const row = this.#db.prepare('SELECT * FROM task_leases WHERE lease_id = ?').get(leaseId) as unknown as LeaseRow | undefined
    if (row === undefined) throw new TaskServiceError('lease_not_found', `lease ${leaseId} does not exist`, { leaseId }, 404)
    return toLease(row)
  }

  #loadLeaseByTask(taskId: string): LeaseRecord | undefined {
    const row = this.#db
      .prepare("SELECT * FROM task_leases WHERE task_id = ? AND status = 'active' ORDER BY acquired_at DESC LIMIT 1")
      .get(taskId) as unknown as LeaseRow | undefined
    return row === undefined ? undefined : toLease(row)
  }

  #loadLeaseByLink(linkId: string): LeaseRecord | undefined {
    const row = this.#db
      .prepare("SELECT * FROM task_leases WHERE link_id = ? AND status = 'active' ORDER BY acquired_at DESC LIMIT 1")
      .get(linkId) as unknown as LeaseRow | undefined
    return row === undefined ? undefined : toLease(row)
  }

  /**
   * Apply an approved design-document proposal.
   * @param input - proposal id and expected task version.
   * @returns the applied proposal.
   */
  applyDesignProposal(input: { proposalId: string; ifVersion: number; actor: Actor }): DesignProposalRecord {
    return this.#transaction(() => {
      const proposal = this.#db
        .prepare('SELECT * FROM doc_change_proposals WHERE proposal_id = ?')
        .get(input.proposalId) as unknown as DesignProposalRow | undefined
      if (proposal === undefined) {
        throw new TaskServiceError('invalid_request', `proposal ${input.proposalId} not found`, {}, 404)
      }
      if (proposal.status !== 'approved') {
        throw new TaskServiceError('invalid_request', `proposal is ${proposal.status}, not approved`, {}, 409)
      }
      const task = this.#loadTask(proposal.task_id)
      this.#checkVersion(task, input.ifVersion)
      const now = this.#now()
      this.#db
        .prepare("UPDATE doc_change_proposals SET status = 'applied', applied_at = ?, version = version + 1 WHERE proposal_id = ?")
        .run(now, proposal.proposal_id)
      this.#db
        .prepare(
          `INSERT INTO design_doc_changes(change_id, doc_id, task_id, proposal_id, change_type, section_path,
             prev_hash, new_hash, changed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          `chg_${this.#newId()}`,
          proposal.doc_id,
          proposal.task_id,
          proposal.proposal_id,
          proposal.change_type,
          proposal.section_path,
          proposal.old_content_hash,
          proposal.new_content === null ? null : `sha256:${proposal.new_content.length}`,
          now,
        )
      this.#touch(task.taskId, 'proposal_applied', input.actor, { proposalId: proposal.proposal_id })
      return this.#loadProposal(proposal.proposal_id)
    })
  }

  /**
   * Change a design note's status.
   * @param input - note, new status and expected task version.
   * @returns the updated note row.
   */
  setDesignNoteStatus(input: MutationInput & {
    noteId: string
    status: 'proposed' | 'implemented' | 'rejected' | 'archived'
  }): DesignNoteRecord {
    return this.#transaction(() => {
      const task = this.#loadTask(input.taskId)
      this.#checkVersion(task, input.ifVersion)
      const changed = this.#db
        .prepare('UPDATE design_notes SET status = ?, version = version + 1, updated_at = ? WHERE note_id = ? AND task_id = ?')
        .run(input.status, this.#now(), input.noteId, input.taskId)
      if (changed.changes === 0) {
        throw new TaskServiceError('invalid_request', `design note ${input.noteId} not found on task`, {}, 404)
      }
      this.#touch(input.taskId, 'design_note_status', input.actor, { noteId: input.noteId, status: input.status })
      return this.#loadDesignNote(input.noteId)
    })
  }

  /**
   * List inbox records.
   * @param filter - optional status/channel/kind filter and row limit.
   * @returns matching records, newest first.
   */
  listIdeas(filter: { status?: string; channel?: string; kind?: string; projectId?: string; limit?: number } = {}): IdeaRecord[] {
    const clauses: string[] = []
    const params: string[] = []
    for (const key of ['status', 'channel', 'kind'] as const) {
      const value = filter[key]
      if (value !== undefined) {
        clauses.push(`${key} = ?`)
        params.push(value)
      }
    }
    if (filter.projectId !== undefined) {
      clauses.push('project_id = ?')
      params.push(filter.projectId)
    }
    const where = clauses.length === 0 ? '' : `WHERE ${clauses.join(' AND ')}`
    const limit = Math.min(Math.max(filter.limit ?? 100, 1), 500)
    return (this.#db
      .prepare(`SELECT * FROM ideas ${where} ORDER BY created_at DESC LIMIT ${limit}`)
      .all(...params) as unknown as IdeaRow[]).map(row => this.#toIdea(row))
  }

  /**
   * Capture one inbox record from any producer.
   * @param input - channel, optional source fields and content.
   * @returns the stored record; automatic channels are idempotent by content hash.
   */
  captureIdea(input: {
    channel: 'manual' | 'bot' | 'agent' | 'connector' | 'agent_extract'
    content: string
    kind?: 'requirement' | 'bug' | 'doc' | 'question' | 'idea'
    title?: string
    projectId?: string | null
    sourceSystem?: string
    connectorRef?: string
    sourceRef?: string
    rawRef?: string
    contentHash?: string
    priority?: 'P0' | 'P1' | 'P2'
    confidence?: 'high' | 'medium' | 'low'
    tags?: readonly string[]
    actor: Actor
  }): IdeaRecord {
    const content = input.content.trim()
    if (content === '') throw new TaskServiceError('invalid_request', 'content is empty', {}, 400)
    const kind = input.kind ?? 'idea'
    if (!['requirement', 'bug', 'doc', 'question', 'idea'].includes(kind)) {
      throw new TaskServiceError('invalid_request', `unknown kind ${kind}`, { kind }, 400)
    }
    if (input.sourceSystem !== undefined && !this.#allowedSourceSystems.has(input.sourceSystem)) {
      throw new TaskServiceError(
        'invalid_request',
        `source_system ${input.sourceSystem} is not configured`,
        { sourceSystem: input.sourceSystem, allowed: [...this.#allowedSourceSystems] },
        400,
      )
    }
    const automatic = input.channel === 'connector' || input.channel === 'agent_extract'
    const ideaId = `idea_${this.#newId()}`
    return this.#transaction(() => {
      if (automatic) {
        const existing = this.#db
          .prepare(
            `SELECT * FROM ideas WHERE channel = ? AND source_system IS ? AND source_ref IS ?
             AND content_hash IS ? LIMIT 1`,
          )
          .get(input.channel, input.sourceSystem ?? null, input.sourceRef ?? null, input.contentHash ?? null) as unknown as
          | IdeaRow
          | undefined
        if (existing !== undefined) return this.#toIdea(existing)
      }
      this.#db
        .prepare(
          `INSERT INTO ideas(idea_id, project_id, channel, source_system, connector_ref, source_ref, kind, title,
             content, tags, status, confidence, priority, raw_ref, content_hash, revision, captured_at,
             version, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'captured', ?, ?, ?, ?, 1, ?, 0, ?)`,
        )
        .run(
          ideaId,
          input.projectId ?? null,
          input.channel,
          input.sourceSystem ?? null,
          input.connectorRef ?? null,
          input.sourceRef ?? null,
          kind,
          input.title ?? null,
          content,
          input.tags === undefined ? null : JSON.stringify(input.tags),
          input.confidence ?? 'medium',
          input.priority ?? 'P2',
          input.rawRef ?? null,
          input.contentHash ?? null,
          this.#now(),
          this.#now(),
        )
      return this.#loadIdea(ideaId)
    })
  }

  /**
   * Advance one inbox record through the triage gates.
   * @param input - action plus optional classification fields.
   * @returns the updated record.
   */
  triageIdea(input: {
    ideaId: string
    action: 'classify' | 'ready' | 'ignore' | 'archive'
    kind?: 'requirement' | 'bug' | 'doc' | 'question' | 'idea'
    projectId?: string
    priority?: 'P0' | 'P1' | 'P2'
    actor: Actor
  }): IdeaRecord {
    return this.#transaction(() => {
      const idea = this.#loadIdea(input.ideaId)
      if (idea.status === 'converted') {
        throw new TaskServiceError('invalid_request', 'record is already converted', { ideaId: idea.ideaId }, 409)
      }
      if ((idea.channel === 'bot' || idea.channel === 'agent') && input.actor.type !== 'user') {
        throw new TaskServiceError('user_approval_required', 'bot and agent captures need a user to triage', {}, 403)
      }
      const kind = input.kind ?? idea.kind
      const projectId = input.projectId ?? idea.projectId
      if (input.action === 'ignore') {
        this.#db.prepare("UPDATE ideas SET status = 'ignored', version = version + 1 WHERE idea_id = ?").run(idea.ideaId)
        return this.#loadIdea(idea.ideaId)
      }
      if (input.action === 'archive') {
        this.#db.prepare("UPDATE ideas SET status = 'archived', version = version + 1 WHERE idea_id = ?").run(idea.ideaId)
        return this.#loadIdea(idea.ideaId)
      }
      if (input.action === 'classify') {
        this.#db
          .prepare('UPDATE ideas SET status = ?, kind = ?, project_id = ?, version = version + 1 WHERE idea_id = ?')
          .run('triaged', kind, projectId, idea.ideaId)
        return this.#loadIdea(idea.ideaId)
      }
      if (kind !== 'requirement' && kind !== 'bug') {
        throw new TaskServiceError('invalid_request', `kind ${kind} cannot become a task`, { kind }, 400)
      }
      if (projectId === null || projectId === '') {
        throw new TaskServiceError('invalid_request', 'ready needs a project', { ideaId: idea.ideaId }, 400)
      }
      if (input.actor.type !== 'user' && input.actor.name !== 'task_inbox') {
        throw new TaskServiceError('user_approval_required', 'only a user or task_inbox can mark ready', {}, 403)
      }
      this.#db
        .prepare("UPDATE ideas SET status = 'ready', kind = ?, project_id = ?, version = version + 1 WHERE idea_id = ?")
        .run(kind, projectId, idea.ideaId)
      return this.#loadIdea(idea.ideaId)
    })
  }

  /**
   * Confirm an inbox record may enter the task flow.
   * @param input - idea id and actor.
   * @returns the updated record.
   */
  confirmIdea(input: { ideaId: string; actor: Actor }): IdeaRecord {
    return this.triageIdea({ ideaId: input.ideaId, action: 'ready', actor: input.actor })
  }

  /**
   * Convert an inbox record into a Candidate; repeated calls return the same
   * Candidate. Task creation remains gated by `approveCandidateGate()`.
   * @param input - idea id and actor.
   * @returns the created (or previously created) Candidate.
   */
  convertIdea(input: { ideaId: string; actor: Actor }): CandidateRecord {
    return this.#transaction(() => {
      const idea = this.#loadIdea(input.ideaId)
      const existing = this.#db
        .prepare('SELECT * FROM task_candidates WHERE source_idea_id = ? ORDER BY created_at, candidate_id LIMIT 1')
        .get(idea.ideaId) as unknown as CandidateRow | undefined
      if (existing !== undefined) {
        if (idea.status !== 'converted' || idea.convertedIdeaId !== existing.candidate_id) {
          this.#db
            .prepare("UPDATE ideas SET status = 'converted', converted_task_id = NULL, converted_idea_id = ?, version = version + 1 WHERE idea_id = ?")
            .run(existing.candidate_id, idea.ideaId)
        }
        return toCandidate(existing)
      }
      if (idea.status !== 'ready') {
        throw new TaskServiceError('invalid_request', `record is ${idea.status}, not ready`, { ideaId: idea.ideaId }, 409)
      }
      if (idea.projectId === null) {
        throw new TaskServiceError('invalid_request', 'record has no project', { ideaId: idea.ideaId }, 400)
      }
      const candidateId = `cand_${this.#newId()}`
      const now = this.#now()
      const ownerUserId = input.actor.type === 'user'
        ? (input.actor.id ?? input.actor.name ?? 'unknown')
        : 'unknown'
      const title = idea.title ?? idea.content.split('\n')[0]?.slice(0, 80) ?? idea.content.slice(0, 80)
      this.#db
        .prepare(
          `INSERT INTO task_candidates(
             candidate_id, source_idea_id, source_type, source_system, source_ref, project_id,
             title, description, status, owner_user_id, version, created_at, updated_at)
           VALUES (?, ?, 'idea', ?, ?, ?, ?, ?, 'captured', ?, 0, ?, ?)`,
        )
        .run(
          candidateId,
          idea.ideaId,
          idea.sourceSystem ?? 'internal',
          `idea:${idea.ideaId}`,
          idea.projectId,
          title,
          idea.content,
          ownerUserId,
          now,
          now,
        )
      this.#db
        .prepare("UPDATE ideas SET status = 'converted', converted_task_id = NULL, converted_idea_id = ?, version = version + 1 WHERE idea_id = ?")
        .run(candidateId, idea.ideaId)
      return this.#loadCandidate(candidateId)
    })
  }

  #loadProposal(proposalId: string): DesignProposalRecord {
    const row = this.#db.prepare('SELECT * FROM doc_change_proposals WHERE proposal_id = ?').get(proposalId) as unknown as
      | DesignProposalRow
      | undefined
    if (row === undefined) throw new TaskServiceError('invalid_request', 'proposal disappeared', {}, 500)
    return {
      proposalId: row.proposal_id,
      docId: row.doc_id,
      taskId: row.task_id,
      changeType: row.change_type,
      status: row.status,
      version: row.version,
      appliedAt: row.applied_at,
    }
  }

  #loadDesignNote(noteId: string): DesignNoteRecord {
    const row = this.#db.prepare('SELECT * FROM design_notes WHERE note_id = ?').get(noteId) as unknown as
      | DesignNoteRow
      | undefined
    if (row === undefined) throw new TaskServiceError('invalid_request', 'design note disappeared', {}, 500)
    return {
      noteId: row.note_id,
      taskId: row.task_id,
      projectId: row.project_id,
      status: row.status,
      content: row.content,
      version: row.version,
    }
  }

  #loadIdea(ideaId: string): IdeaRecord {
    const row = this.#db.prepare('SELECT * FROM ideas WHERE idea_id = ?').get(ideaId) as unknown as IdeaRow | undefined
    if (row === undefined) throw new TaskServiceError('invalid_request', `idea ${ideaId} not found`, {}, 404)
    return this.#toIdea(row)
  }

  #toIdea(row: IdeaRow): IdeaRecord {
    return {
      ideaId: row.idea_id,
      projectId: row.project_id,
      channel: row.channel,
      sourceSystem: row.source_system,
      kind: row.kind,
      title: row.title,
      content: row.content,
      status: row.status,
      revision: row.revision,
      convertedTaskId: row.converted_task_id,
      convertedIdeaId: row.converted_idea_id,
      sourceRef: row.source_ref,
      createdAt: row.created_at,
      version: row.version,
    }
  }

  #listComments(taskId: string): CommentRecord[] {
    const rows = this.#db.prepare('SELECT * FROM task_comments WHERE task_id = ? ORDER BY created_at').all(taskId) as unknown as CommentRow[]
    return rows.map(row => ({
      commentId: row.comment_id,
      taskId: row.task_id,
      reportId: row.report_id,
      commentType: row.comment_type,
      decision: row.decision,
      body: row.body,
      authorName: row.author_name,
      createdAt: row.created_at,
    }))
  }

  #listCriteria(taskId: string): CriteriaRecord[] {
    const rows = this.#db
      .prepare('SELECT * FROM acceptance_criteria WHERE task_id = ? ORDER BY criteria_id')
      .all(taskId) as unknown as CriteriaRow[]
    return rows.map(row => ({
      criteriaId: row.criteria_id,
      taskId: row.task_id,
      description: row.description,
      checkType: row.check_type,
      status: row.status,
      checkedAt: row.checked_at,
    }))
  }

  #listReports(taskId: string): ReportRecord[] {
    const rows = this.#db
      .prepare('SELECT * FROM task_reports WHERE task_id = ? ORDER BY submitted_at DESC')
      .all(taskId) as unknown as ReportRow[]
    return rows.map(row => ({
      reportId: row.report_id,
      taskId: row.task_id,
      agentId: row.agent_id,
      sessionId: row.session_id,
      content: row.content,
      artifactIds: row.artifact_ids === null ? null : (JSON.parse(row.artifact_ids) as string[]),
      acceptanceSelfCheck: row.acceptance_self_check === null ? null : (JSON.parse(row.acceptance_self_check) as Record<string, unknown>),
      status: row.status,
      version: row.version,
      submittedAt: row.submitted_at,
    }))
  }

  #loadComment(commentId: string): CommentRecord {
    const row = this.#db.prepare('SELECT * FROM task_comments WHERE comment_id = ?').get(commentId) as unknown as
      | CommentRow
      | undefined
    if (row === undefined) throw new TaskServiceError('invalid_request', 'comment disappeared', {}, 500)
    return {
      commentId: row.comment_id,
      taskId: row.task_id,
      reportId: row.report_id,
      commentType: row.comment_type,
      decision: row.decision,
      body: row.body,
      authorName: row.author_name,
      createdAt: row.created_at,
    }
  }

  #loadCriteria(criteriaId: string): CriteriaRecord {
    const row = this.#db.prepare('SELECT * FROM acceptance_criteria WHERE criteria_id = ?').get(criteriaId) as unknown as
      | CriteriaRow
      | undefined
    if (row === undefined) throw new TaskServiceError('invalid_request', 'criteria disappeared', {}, 500)
    return {
      criteriaId: row.criteria_id,
      taskId: row.task_id,
      description: row.description,
      checkType: row.check_type,
      status: row.status,
      checkedAt: row.checked_at,
    }
  }

  #loadReport(reportId: string): ReportRecord {
    const row = this.#db.prepare('SELECT * FROM task_reports WHERE report_id = ?').get(reportId) as unknown as
      | ReportRow
      | undefined
    if (row === undefined) throw new TaskServiceError('report_not_found', `report ${reportId} not found`, {}, 404)
    return {
      reportId: row.report_id,
      taskId: row.task_id,
      agentId: row.agent_id,
      sessionId: row.session_id,
      content: row.content,
      artifactIds: row.artifact_ids === null ? null : (JSON.parse(row.artifact_ids) as string[]),
      acceptanceSelfCheck: row.acceptance_self_check === null ? null : (JSON.parse(row.acceptance_self_check) as Record<string, unknown>),
      status: row.status,
      version: row.version,
      submittedAt: row.submitted_at,
    }
  }

  #loadRun(linkId: string): RunRecord {
    const row = this.#db.prepare('SELECT * FROM task_runs WHERE link_id = ?').get(linkId) as unknown as RunRow | undefined
    if (row === undefined) throw new TaskServiceError('invalid_request', `run ${linkId} not found`, {}, 404)
    return toRun(row)
  }

  #touch(taskId: string, eventType: string, actor: Actor, payload: Record<string, unknown>): void {
    this.#db.prepare('UPDATE tasks SET version = version + 1, updated_at = ? WHERE task_id = ?').run(this.#now(), taskId)
    this.#appendEvent(taskId, eventType, actor, payload)
  }

  #closeBlockers(taskId: string): string[] {
    const blockers: string[] = []
    const criteria = this.#db
      .prepare("SELECT criteria_id, status FROM acceptance_criteria WHERE task_id = ? AND status <> 'passed'")
      .all(taskId) as { criteria_id: string; status: string }[]
    for (const row of criteria) blockers.push(`criteria:${row.criteria_id}:${row.status}`)
    const proposals = this.#db
      .prepare("SELECT proposal_id FROM doc_change_proposals WHERE task_id = ? AND status = 'pending'")
      .all(taskId) as { proposal_id: string }[]
    for (const row of proposals) blockers.push(`proposal:${row.proposal_id}:pending`)
    return blockers
  }

  /**
   * List tasks, newest update first.
   * @param filter - optional status/project filter and row limit.
   * @returns matching tasks.
   */
  listTasks(filter: { status?: string; projectId?: string; limit?: number } = {}): TaskRecord[] {
    const clauses: string[] = []
    const params: string[] = []
    if (filter.status !== undefined) {
      clauses.push('status = ?')
      params.push(filter.status)
    }
    if (filter.projectId !== undefined) {
      clauses.push('project_id = ?')
      params.push(filter.projectId)
    }
    const where = clauses.length === 0 ? '' : `WHERE ${clauses.join(' AND ')}`
    const limit = Math.min(Math.max(filter.limit ?? 100, 1), 500)
    return (this.#db
      .prepare(`SELECT * FROM tasks ${where} ORDER BY updated_at DESC LIMIT ${limit}`)
      .all(...params) as unknown as TaskRow[]).map(row => this.#toRecord(row))
  }

  #loadTask(taskId: string): TaskRecord {
    const row = this.#db.prepare('SELECT * FROM tasks WHERE task_id = ?').get(taskId) as unknown as TaskRow | undefined
    if (row === undefined) {
      throw new TaskServiceError('task_not_found', `task ${taskId} does not exist`, { taskId }, 404)
    }
    return this.#toRecord(row)
  }

  #loadCandidate(candidateId: string): CandidateRecord {
    const row = this.#db
      .prepare('SELECT * FROM task_candidates WHERE candidate_id = ?')
      .get(candidateId) as unknown as CandidateRow | undefined
    if (row === undefined) {
      throw new TaskServiceError('candidate_not_found', `candidate ${candidateId} does not exist`, { candidateId }, 404)
    }
    return toCandidate(row)
  }

  #loadDecision(decisionId: string): DecisionRecord {
    const row = this.#db
      .prepare('SELECT * FROM decisions WHERE decision_id = ?')
      .get(decisionId) as unknown as DecisionRow | undefined
    if (row === undefined) {
      throw new TaskServiceError('decision_not_found', `decision ${decisionId} does not exist`, { decisionId }, 404)
    }
    return toDecision(row)
  }

  #checkDecisionVersion(decision: DecisionRecord, ifVersion: number): void {
    if (decision.version !== ifVersion) {
      throw new TaskServiceError(
        'version_conflict',
        `expected version ${ifVersion}, current version is ${decision.version}`,
        { latest: decision, currentVersion: decision.version },
        409,
      )
    }
  }

  #validateDecisionRelaxation(
    projectId: string,
    authorityLevel: DecisionAuthorityLevel,
    relaxesDecisionId: string | null,
    relaxesEvidenceId: string | null,
  ): void {
    if (authorityLevel === 'hard_constraint' && relaxesDecisionId !== null) {
      throw new TaskServiceError(
        'decision_validation_failed',
        'hard_constraint decisions cannot relax another decision',
        { field: 'relaxesDecisionId', authorityLevel },
        400,
      )
    }
    if (relaxesDecisionId !== null && relaxesEvidenceId === null) {
      throw new TaskServiceError(
        'decision_validation_failed',
        'relaxesEvidenceId is required when relaxesDecisionId is set',
        { field: 'relaxesEvidenceId' },
        400,
      )
    }
    if (relaxesDecisionId === null && relaxesEvidenceId !== null) {
      throw new TaskServiceError(
        'decision_validation_failed',
        'relaxesDecisionId is required when relaxesEvidenceId is set',
        { field: 'relaxesDecisionId' },
        400,
      )
    }
    if (relaxesDecisionId === null || relaxesEvidenceId === null) return
    const evidence = this.#db
      .prepare(
        `SELECT e.evidence_id, e.decision_id, d.project_id
         FROM decision_evidence e
         JOIN decisions d ON d.decision_id = e.decision_id
         WHERE e.evidence_id = ?`,
      )
      .get(relaxesEvidenceId) as
        | { evidence_id: string; decision_id: string; project_id: string }
        | undefined
    if (evidence === undefined) {
      throw new TaskServiceError(
        'decision_validation_failed',
        `relaxation evidence ${relaxesEvidenceId} does not exist`,
        { field: 'relaxesEvidenceId', relaxesEvidenceId },
        400,
      )
    }
    if (evidence.decision_id !== relaxesDecisionId) {
      throw new TaskServiceError(
        'decision_validation_failed',
        'relaxation evidence does not belong to the referenced decision',
        { relaxesDecisionId, relaxesEvidenceId, evidenceDecisionId: evidence.decision_id },
        400,
      )
    }
    if (evidence.project_id !== projectId) {
      throw new TaskServiceError(
        'decision_validation_failed',
        'relaxation evidence belongs to another project',
        { projectId, evidenceProjectId: evidence.project_id },
        400,
      )
    }
  }

  #insertDecisionEvidence(
    decisionId: string,
    evidence: readonly DecisionEvidenceInput[] | undefined,
    actor: Actor,
    now: string,
  ): void {
    if (evidence === undefined || evidence.length === 0) return
    const insert = this.#db.prepare(
      `INSERT INTO decision_evidence(
         evidence_id, decision_id, kind, ref, verified_by, verified_at, content_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    for (const item of evidence) {
      const kind = assertEnum(item.kind, DECISION_EVIDENCE_KINDS, 'evidence.kind')
      const ref = requireText(item.ref, 'evidence.ref')
      const contentHash = requireText(item.contentHash ?? decisionContentHash(ref), 'evidence.contentHash')
      insert.run(`evd_${this.#newId()}`, decisionId, kind, ref, actorIdentity(actor), now, contentHash, now)
    }
  }

  #appendDecisionAudit(
    decisionId: string,
    eventType: string,
    actor: Actor,
    decisionVersion: number,
    payload: Record<string, unknown>,
  ): void {
    this.#db
      .prepare(
        `INSERT INTO decision_audit(
           audit_id, decision_id, event_type, actor_type, actor_id, decision_version,
           candidate_gate_event_id, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
      )
      .run(
        `aud_${this.#newId()}`,
        decisionId,
        eventType,
        actor.type,
        actorIdentity(actor),
        decisionVersion,
        JSON.stringify(payload),
        this.#now(),
      )
  }

  #requireDecisionUser(actor: Actor, action: string): void {
    if (actor.type !== 'user') {
      throw new TaskServiceError(
        'user_approval_required',
        `only a user may ${action} a decision`,
        { action },
        403,
      )
    }
  }

  #throwDecisionConstraint(error: unknown): never {
    if (error instanceof TaskServiceError) throw error
    const message = errorText(error)
    if (message.includes('DECISION_INVALID_TRANSITION')) {
      throw new TaskServiceError('invalid_transition', 'decision status transition is not allowed', { cause: message }, 409)
    }
    if (message.includes('DECISION_EVIDENCE_REQUIRED')) {
      throw new TaskServiceError(
        'decision_validation_failed',
        'implement requires at least one evidence item',
        { cause: message },
        400,
      )
    }
    if (message.includes('DECISION_APPROVAL_IMMUTABLE')) {
      throw new TaskServiceError(
        'decision_validation_failed',
        'approval fields are immutable after a decision is implemented',
        { cause: message },
        409,
      )
    }
    if (message.includes('APPEND_ONLY_TABLE')) {
      throw new TaskServiceError(
        'decision_validation_failed',
        'decision evidence and audit rows are append-only',
        { cause: message },
        409,
      )
    }
    if (
      message.includes('UNIQUE constraint failed: decisions.project_id') &&
      message.includes('decisions.decision_key')
    ) {
      throw new TaskServiceError(
        'decision_validation_failed',
        'another implemented decision already owns this scope and decisionKey',
        { cause: message },
        409,
      )
    }
    throw error
  }

  #loadSnapshot(snapshotId: string): AdmissionSnapshotRecord {
    const row = this.#db
      .prepare('SELECT * FROM admission_snapshots WHERE snapshot_id = ?')
      .get(snapshotId) as unknown as AdmissionSnapshotRow | undefined
    if (row === undefined) {
      throw new TaskServiceError('admission_snapshot_invalid', `snapshot ${snapshotId} does not exist`, { snapshotId }, 404)
    }
    return toSnapshot(row)
  }

  #checkCandidateVersion(candidate: CandidateRecord, ifVersion: number): void {
    if (candidate.version !== ifVersion) {
      throw new TaskServiceError(
        'version_conflict',
        `expected version ${ifVersion}, current version is ${candidate.version}`,
        { latest: candidate, currentVersion: candidate.version },
        409,
      )
    }
  }

  #decisionCollection(
    candidate: CandidateRecord,
    ids: readonly string[] | undefined,
    allowedStatuses: readonly DecisionRow['status'][],
    collectionType: 'proposed' | 'authoritative' | 'historical',
  ): { ids: string[]; rows: DecisionRow[]; records: Array<Record<string, unknown>> } {
    const normalized = uniqueIds(ids)
    if (normalized.length === 0) return { ids: [], rows: [], records: [] }
    const placeholders = normalized.map(() => '?').join(', ')
    const rows = this.#db
      .prepare(
        `SELECT decision_id, project_id, decision_key, title, status, authority_scope,
                authority_level, subject_type, subject_id, problem, proposal, version, updated_at
         FROM decisions WHERE decision_id IN (${placeholders})`,
      )
      .all(...normalized) as unknown as DecisionRow[]
    const byId = new Map(rows.map(row => [row.decision_id, row]))
    const ordered: DecisionRow[] = []
    for (const decisionId of normalized) {
      const row = byId.get(decisionId)
      if (row === undefined) {
        throw new TaskServiceError('decision_validation_failed', `decision ${decisionId} does not exist`, {
          decisionId,
          collectionType,
        }, 400)
      }
      if (row.project_id !== candidate.projectId) {
        throw new TaskServiceError('decision_validation_failed', `decision ${decisionId} belongs to another project`, {
          decisionId,
          expectedProjectId: candidate.projectId,
          actualProjectId: row.project_id,
        }, 400)
      }
      if (!allowedStatuses.includes(row.status)) {
        throw new TaskServiceError(
          'decision_validation_failed',
          `decision ${decisionId} has status ${row.status}, expected ${allowedStatuses.join('|')}`,
          { decisionId, status: row.status, collectionType },
          400,
        )
      }
      ordered.push(row)
    }
    return {
      ids: normalized,
      rows: ordered,
      records: ordered.map(row => ({
        decisionId: row.decision_id,
        decisionKey: row.decision_key,
        title: row.title,
        status: row.status,
        authorityScope: row.authority_scope,
        authorityLevel: row.authority_level,
        subjectType: row.subject_type,
        subjectId: row.subject_id,
        version: row.version,
      })),
    }
  }

  #decisionLinkIds(taskId: string, snapshotId: string): string[] {
    return (this.#db
      .prepare(
        `SELECT link_id FROM task_decision_links
         WHERE task_id = ? AND admission_snapshot_id = ? AND active = 1
         ORDER BY created_at, link_id`,
      )
      .all(taskId, snapshotId) as { link_id: string }[]).map(row => row.link_id)
  }

  #toRecord(row: TaskRow): TaskRecord {
    return {
      taskId: row.task_id,
      projectId: row.project_id,
      sourceCandidateId: row.source_candidate_id,
      ownerUserId: row.owner_user_id,
      mandateId: row.mandate_id,
      workspaceId: row.workspace_override,
      repositoryRef: row.repository_ref,
      branchRef: row.branch_ref,
      lifecycleMode: row.lifecycle_mode,
      title: row.title,
      description: row.description ?? '',
      status: row.status,
      taskType: row.task_type,
      riskLevel: row.risk_level,
      parentTaskId: row.parent_task_id,
      threadId: row.thread_id,
      assigneeName: row.assignee_name,
      version: row.version,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      closedAt: row.closed_at,
    }
  }

  #checkVersion(task: TaskRecord, ifVersion: number): void {
    if (task.version !== ifVersion) {
      throw new TaskServiceError(
        'version_conflict',
        `expected version ${ifVersion}, current version is ${task.version}`,
        { latest: task, currentVersion: task.version },
        409,
      )
    }
  }

  #allowedTransitions(task: TaskRecord): AllowedTransition[] {
    const edges: readonly { from: string; to: string; action: string; requiresUser: boolean }[] =
      task.lifecycleMode === 'p0' ? P0_TRANSITIONS : TRANSITIONS
    if (this.#isTerminal(task.lifecycleMode, task.status)) return []
    return edges
      .filter(edge => edge.from === task.status)
      .map(edge => ({ to: edge.to, action: edge.action, requiresUser: edge.requiresUser }))
  }

  #edge(mode: 'p0' | 'v1', from: string, to: string): { action: string; requiresUser: boolean } | undefined {
    const edges: readonly { from: string; to: string; action: string; requiresUser: boolean }[] =
      mode === 'p0' ? P0_TRANSITIONS : TRANSITIONS
    return edges.find(edge => edge.from === from && edge.to === to)
  }

  #isTerminal(mode: 'p0' | 'v1', status: string): boolean {
    if (mode === 'p0') return P0_TERMINAL.has(status as (typeof P0_STATUSES)[number])
    return TERMINAL.has(status as (typeof TASK_STATUSES)[number])
  }

  #loadProject(projectId: string): ProjectRow {
    const row = this.#db.prepare('SELECT * FROM projects WHERE project_id = ?').get(projectId) as unknown as ProjectRow | undefined
    if (row === undefined) {
      throw new TaskServiceError('project_not_found', `project ${projectId} does not exist`, { projectId }, 404)
    }
    return row
  }

  #assertCandidateWorkspace(project: ProjectRow, candidate: CandidateRow | CandidateRecord): void {
    const expected = expectedProjectWorkspace(project)
    const requested = 'workspace_id' in candidate ? candidate.workspace_id : candidate.workspaceId
    const candidateId = 'candidate_id' in candidate ? candidate.candidate_id : candidate.candidateId
    if (requested !== expected) {
      throw new TaskServiceError('workspace_context_mismatch', 'candidate workspace does not match the project', {
        projectId: project.project_id,
        candidateId,
        requested,
        expected,
      }, 400)
    }
  }

  #assertExecutionReady(taskId: string): TaskExecutionContext {
    const row = this.#db.prepare(`
      SELECT t.task_id, t.project_id, t.workspace_override, p.local_path, p.workspace_id,
             p.ownership_state, p.type
      FROM tasks t
      JOIN projects p ON p.project_id = t.project_id
      WHERE t.task_id = ?
    `).get(taskId) as unknown as {
      task_id: string
      project_id: string
      workspace_override: string | null
      local_path: string | null
      workspace_id: string | null
      ownership_state: 'active' | 'ownership_pending'
      type: 'code' | 'knowledge' | 'hybrid'
    } | undefined
    if (row === undefined) {
      throw new TaskServiceError('task_not_found', `task ${taskId} does not exist`, { taskId }, 404)
    }
    const workspaceId = row.workspace_id?.trim() ?? ''
    const localPath = row.local_path?.trim() ?? ''
    const workspaceBound = workspaceId !== '' || localPath !== ''
    if (!workspaceBound) {
      throw new TaskServiceError('workspace_not_bound', `project ${row.project_id} has no execution workspace`, {
        taskId,
        projectId: row.project_id,
      }, 400)
    }
    if (row.ownership_state !== 'active') {
      throw new TaskServiceError('project_not_active', `project ${row.project_id} is ${row.ownership_state}`, {
        taskId,
        projectId: row.project_id,
        ownershipState: row.ownership_state,
      }, 400)
    }
    const expectedWorkspace = workspaceId !== '' ? workspaceId : localPath
    if (row.workspace_override !== null && row.workspace_override.trim() !== '' && row.workspace_override.trim() !== expectedWorkspace) {
      throw new TaskServiceError('workspace_context_mismatch', 'task workspace does not match the project', {
        taskId,
        projectId: row.project_id,
        requested: row.workspace_override.trim(),
        expected: expectedWorkspace,
      }, 400)
    }
    const mandate = this.#db
      .prepare("SELECT mandate_id, scope_json FROM task_mandates WHERE task_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1")
      .get(taskId) as unknown as { mandate_id: string; scope_json: string } | undefined
    if (mandate === undefined) {
      throw new TaskServiceError('execution_scope_missing', `task ${taskId} has no active execution scope`, { taskId }, 400)
    }
    const scope = safeJsonObject(mandate.scope_json) ?? {}
    if (scope.project_id !== row.project_id || scope.workspace_id !== expectedWorkspace) {
      throw new TaskServiceError('workspace_context_mismatch', 'execution scope does not match the project workspace', {
        taskId,
        projectId: row.project_id,
        expectedWorkspace,
        scopeProjectId: scope.project_id ?? null,
        scopeWorkspaceId: scope.workspace_id ?? null,
      }, 400)
    }
    return {
      taskId,
      projectId: row.project_id,
      workspaceId: expectedWorkspace,
      localPath: workspaceId === '' ? localPath : null,
      workspaceSource: workspaceId !== '' ? 'workspace_id' : 'local_path',
      ownershipState: row.ownership_state,
      scopeId: mandate.mandate_id,
      workspaceBound,
      executionBackend: 'auto',
    }
  }

  #applyTransition(
    task: TaskRecord,
    to: string,
    actor: Actor,
    payload: Record<string, unknown>,
    eventType = 'advanced',
  ): void {
    const now = this.#now()
    const closedAt = to === 'closed' ? now : task.closedAt
    this.#db
      .prepare(
        'UPDATE tasks SET status = ?, version = version + 1, updated_at = ?, closed_at = ? WHERE task_id = ?',
      )
      .run(to, now, closedAt, task.taskId)
    this.#appendEvent(task.taskId, eventType, actor, payload)
  }

  #bump(taskId: string, fields: Record<string, string | number | null>): void {
    const keys = Object.keys(fields)
    const assignments = keys.map(key => `${key} = ?`).join(', ')
    this.#db
      .prepare(`UPDATE tasks SET ${assignments}, version = version + 1, updated_at = ? WHERE task_id = ?`)
      .run(...keys.map(key => fields[key] as string | number | null), this.#now(), taskId)
  }

  #appendEvent(taskId: string, type: string, actor: Actor, payload: Record<string, unknown>): void {
    this.#db
      .prepare(
        `INSERT INTO task_events(event_id, task_id, event_type, actor, payload, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        `evt_${this.#newId()}`,
        taskId,
        type,
        actor.name ?? actor.id ?? actor.type,
        JSON.stringify(payload),
        this.#now(),
      )
  }

  #transaction<T>(fn: () => T): T {
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      const value = fn()
      this.#db.exec('COMMIT')
      return value
    } catch (error) {
      this.#db.exec('ROLLBACK')
      throw error
    }
  }
}

/** Convenience for callers that only have a task title and a project. */
export type { TaskServiceErrorCode as ServiceErrorCode }
