/**
 * Public surface of the AgentOps migration contracts package.
 *
 * @module @agentops/dsh-contracts
 */

export type {
  ActorSurfaceField,
  ActorSurfaceView,
  ActorVisualProfile,
  AgentDefinition,
  AgentExecution,
  AgentModel,
  AgentPermissions,
  AwaitCommandConfig,
  DomainDefinition,
  Harness,
  InlineAgent,
  Tier,
  ValidationIssue,
  ValidationResult,
  WorkflowDefinition,
  WorkflowGraphResult,
  WorkflowNode,
  WorkflowNodeLevel,
  WorkflowNodeType,
  WorkflowRunInputDefinition,
  WorkflowRunInputType,
  WorkflowWidgetDefinition,
} from './types.js'

export type { WorkflowOwnership, WorkflowOwnershipIssueKind } from './ownership.js'

export { buildWorkflowOwnership } from './ownership.js'

export {
  loadActorVisualProfile,
  loadDomainDefinition,
  parseActorVisualProfile,
  parseDomainDefinition,
} from './catalog.js'

export {
  WorkflowCycleError,
  dataEdges,
  isRelativeArtifactPath,
  isSafeAgentId,
  loadAgentDefinition,
  loadWorkflowDefinition,
  loadWorkflowGraph,
  parseAgentDefinition,
  parseWorkflowDefinition,
  parseWorkflowGraph,
  scheduleDependencies,
  serializeAgentDefinition,
  topoLevelsLenient,
  topoLayers,
} from './schema.js'
