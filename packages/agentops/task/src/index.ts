export {
  TASK_STATUSES,
  TRANSITIONS,
  TERMINAL,
  PAUSABLE,
  allowedTransitions,
  canTransition,
  isStatus,
  isTerminal,
  resolveDecomposeStrategy,
  resolveReviewGate,
} from './status.ts'
export type { TaskStatus, Transition } from './status.ts'
export {
  P0_STATUSES,
  P0_TRANSITIONS,
  P0_TERMINAL,
  P0_PAUSABLE,
  allowedP0Transitions,
  canP0Transition,
  isP0Status,
  isP0Terminal,
} from './lifecycle/p0.ts'
export type { P0Status, P0Transition } from './lifecycle/p0.ts'
export {
  PARENT_CYCLE_TRIGGER,
  TASK_CANONICAL_ROUTES,
  TASK_CONTRACT_VERSION,
  TASK_INDEXES,
  TASK_MIGRATED_ROUTES,
  TASK_NON_REVISION_TABLES,
  TASK_REVISION_TABLES,
  TASK_TABLES,
  buildTaskContractSnapshot,
  revisionTriggerNames,
} from './contracts.ts'
export type { LifecycleEdge, TaskContractSnapshot, TaskIndex, TaskRoute } from './contracts.ts'
export {
  SCHEMA_VERSION,
  TASK_SCHEMA_SQL,
  assertSchemaVersion,
  buildSchemaStatements,
  buildTriggerDdl,
  createTaskSchema,
  readUserVersion,
} from './schema.ts'
export { applyMigration, detectShape, planMigration } from './migrate.ts'
export type { CopiedTable, MigrationManifest, MigrationPlan, MigrationResult, SourceShape } from './migrate.ts'
export { MENTION_TARGETS, TaskService, TaskServiceError } from './service.ts'
export type { TaskPatch } from './service.ts'
export { selectAgentForTask, assertAgentPresetCapable, DEFAULT_AGENT_CAPABILITIES } from './agent-dispatch.ts'
export type { AgentCapability, AgentDispatchDecision } from './agent-dispatch.ts'
export { setTaskToolExecutionContext, getTaskToolExecutionContext, clearTaskToolExecutionContext } from './execution-context.ts'
export type { TaskToolExecutionContext } from './execution-context.ts'
export { TaskHttpApi } from './http.ts'
export type { TaskHttpRequest, TaskHttpResponse } from './http.ts'
export { AGENT_ACTOR, createServiceTaskTools } from './tools-v1.ts'
export { listExports, loadReportForExport, renderReport, verifyExport, writeExport, exportPath } from './reports.ts'
export type { ExportFormat, ExportResult, RenderedReport, ReportExportInput } from './reports.ts'
export type {
  Actor,
  ActorType,
  AllowedTransition,
  ArchiveDecisionInput,
  DecisionAuditRecord,
  DecisionDetail,
  DecisionEvidenceInput,
  DecisionEvidenceRecord,
  DecisionRecord,
  DecisionRelationRecord,
  DecisionSearchResult,
  DecisionStatus,
  ImplementDecisionInput,
  ProposeDecisionInput,
  RejectDecisionInput,
  ReviseDecisionInput,
  SearchDecisionsInput,
  SupersedeDecisionInput,
  CommentRecord,
  CommentType,
  CreateProjectInput,
  CreateTaskInput,
  CriteriaRecord,
  DesignNoteRecord,
  DesignProposalRecord,
  IdeaRecord,
  MentionTarget,
  MutationInput,
  ReportDecision,
  ProjectRecord,
  ReportRecord,
  RunRecord,
  TaskExecutionContext,
  TaskDetail,
  TaskRecord as ServiceTaskRecord,
  TaskServiceErrorCode,
} from './service.ts'
export { name, inject, apply, resolveTaskDbPath, DEFAULT_CONFIG } from './dsh.ts'
export type { TaskPluginConfig } from './dsh.ts'
