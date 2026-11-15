/**
 * Agent and workflow definitions shared by the AgentOps migration packages.
 *
 * The YAML files remain the source of truth; these types are the in-memory
 * model that every reader and writer must agree on. Fields are `readonly`
 * because a parsed definition is treated as an immutable snapshot.
 *
 * @module @agentops/dsh-contracts/types
 */

/** Permission tier. Higher tiers may call tools whose own tier is lower or equal. */
export type Tier = 'T0' | 'T1' | 'T2' | 'T3'

/** Legacy migration label. New execution selection lives in {@link ExecutionBackend}. */
export type Harness = 'local_llm' | 'claude_sdk' | 'codex' | 'opencode' | 'deterministic'

/** Real execution backend for one Agent; `auto` lets DSH choose a capable provider. */
export type ExecutionBackend = 'dsh_native' | 'codex' | 'claude_code' | 'auto'

/**
 * How one Agent executes a task.
 *
 * `skill` agents carry the procedure themselves: a skill manual plus the
 * business tools it needs, free to order the steps. `workflow` agents own
 * exactly one workflow and hand the steps to its nodes, which inherit this
 * Agent's permissions. The mode is declared here instead of being chosen per
 * conversation, so a dispatcher never has to guess and a workflow can never be
 * driven by an Agent that does not own it.
 */
export type AgentExecution = 'skill' | 'workflow'

/** Model selection stored on an agent definition. */
export interface AgentModel {
  readonly provider: string
  readonly id: string
}

/** Tool access declared on an agent definition. */
export interface AgentPermissions {
  readonly allowedTools: readonly string[]
  readonly deniedTools: readonly string[]
}

/**
 * One Agent as the Agent management page sees it.
 *
 * `tier` is a security gate, not a label: the loader rejects an agent whose
 * tier is below a granted tool's required tier. Dropping it on write silently
 * demotes or promotes the agent, which is why every field round-trips here.
 */
export interface AgentDefinition {
  readonly agentId: string
  readonly displayName: string
  readonly domain: string
  /** Human-readable purpose shown in the catalogue. */
  readonly description?: string
  readonly harness: Harness
  /** Real backend used to execute this Agent; legacy `harness` remains metadata. */
  readonly executionBackend: ExecutionBackend
  readonly model: AgentModel | 'auto'
  /** Instructions prepended to the agent's task prompt. */
  readonly systemPrompt?: string
  readonly tier: Tier
  /**
   * How this Agent executes a task. A definition without the field parses as
   * `skill`, so every existing Agent file stays valid.
   */
  readonly execution: AgentExecution
  /**
   * Workflow id this Agent owns; required when `execution` is `workflow` and
   * rejected otherwise.
   *
   * Ownership is declared only here — a workflow file never names its Agent —
   * so the reverse index (`workflow id -> agent id`) is derived from the Agent
   * catalogue and every inconsistency is reported rather than resolved.
   */
  readonly workflow?: string
  readonly permissions: AgentPermissions
  /** Knowledge-base identifiers available to this agent. */
  readonly knowledgeBases?: readonly string[]
  /** Maximum wall-clock duration for one run, in seconds. */
  readonly timeoutSeconds?: number
  /** Maximum number of runs that may execute concurrently. */
  readonly maxConcurrentRuns?: number
  /** Maximum cost for one run; `null` explicitly disables the limit. */
  readonly costLimitPerRun?: number | null
  /**
   * Artifact path templates keyed by artifact name.
   *
   * Values are business-relative paths only. A template never carries an
   * absolute prefix, a drive letter, or a `..` segment; the workspace layout
   * resolves the absolute location.
   */
  readonly outputFiles: Readonly<Record<string, string>>
}

/** Agent settings embedded in one workflow node instead of a global catalogue file. */
export interface InlineAgent {
  readonly rolePrompt: string
  readonly harness?: Harness
  readonly model?: AgentModel | 'auto'
  readonly domain?: string
  readonly allowedTools?: readonly string[]
  readonly deniedTools?: readonly string[]
  readonly timeoutSeconds?: number
}

/** Node primitives supported by the legacy AgentOps workflow engine. */
export type WorkflowNodeType =
  | 'agent'
  | 'command'
  | 'await_command'
  | 'gateway'
  | 'parallel_branch'
  | 'while'

/** Value accepted by one workflow run input. */
export type WorkflowRunInputType = 'string' | 'integer' | 'number' | 'boolean' | 'array'

/** One top-level workflow input declared by the YAML source. */
export interface WorkflowRunInputDefinition {
  readonly name: string
  readonly type: WorkflowRunInputType
  readonly required: boolean
  readonly default?: unknown
  readonly description?: string
}

/**
 * Configuration for the `await_command` primitive.
 *
 * Missing YAML fields resolve to the legacy defaults before the value reaches
 * the workflow compiler or the visual editor.
 */
export interface AwaitCommandConfig {
  readonly targetActors: readonly string[]
  readonly commandPort: string
  readonly expirySeconds: number
  readonly maxCommands: number
}

/**
 * One workflow node.
 *
 * Agent nodes reference the global catalogue or carry an inline definition.
 * The other node types preserve their execution configuration in typed fields;
 * fields the editor does not model yet remain in `rawFields` so a visual save
 * cannot erase them.
 */
export interface WorkflowNode {
  readonly id: string
  readonly type: WorkflowNodeType
  readonly displayName?: string
  /** Reference into `config/agents/<id>.yaml`. Mutually exclusive with `inlineAgent`. */
  readonly agentRef?: string
  /** Inline definition for a workflow-local role that is never registered globally. */
  readonly inlineAgent?: InlineAgent
  readonly rolePrompt: string
  readonly businessRole?: string
  readonly harness?: string
  readonly model?: string | AgentModel
  /** Dependency edges. The only input to scheduling. */
  readonly after: readonly string[]
  readonly inputs: readonly string[]
  /**
   * Output port name to target node ids. Carries data flow only, never
   * scheduling. Multiple targets are normalized as an array even when the
   * legacy YAML declared one string.
   */
  readonly outputs: Readonly<Record<string, readonly string[]>>
  readonly timeoutMs?: number
  readonly condition?: string
  readonly branches?: readonly string[]
  readonly body?: readonly string[]
  readonly continueIf?: string
  readonly maxIterations?: number
  readonly skipIf?: string
  readonly joinStrategy?: string
  readonly cancelOnFirstFail?: boolean
  readonly gatewayKind?: string
  readonly commandConfig?: Readonly<Record<string, unknown>>
  readonly awaitCommandConfig?: AwaitCommandConfig
  readonly whileConfig?: Readonly<Record<string, unknown>>
  /** Unmodelled node fields retained for lossless visual edits. */
  readonly rawFields?: Readonly<Record<string, unknown>>
}

/** One widget emitted by a workflow run. */
export interface WorkflowWidgetDefinition {
  readonly id: string
  readonly type: string
  readonly title: string
  readonly emitOnNode: string
  readonly emitOnEvent: string
  readonly props?: Readonly<Record<string, unknown>>
}

/** A whole workflow as the workflow management page sees it. */
export interface WorkflowDefinition {
  readonly workflowId: string
  readonly name: string
  readonly description?: string
  readonly version: number
  /** Business-relative prefix used by the workspace layout. */
  readonly businessId?: string
  readonly inputs: readonly WorkflowRunInputDefinition[]
  readonly nodes: readonly WorkflowNode[]
  readonly widgets: readonly WorkflowWidgetDefinition[]
}

/** One validation problem, addressed to a field path inside the parsed input. */
export interface ValidationIssue {
  readonly path: string
  readonly message: string
  /** Stable machine-readable category, such as `yaml` or `cycle`. */
  readonly kind?: string
  /** One-based source line when the issue came from YAML text. */
  readonly line?: number
  /** One-based source column when the issue came from YAML text. */
  readonly column?: number
  /** Nodes participating in a cycle, without the repeated closing node. */
  readonly nodeIds?: readonly string[]
  /** Stable cycle path, including the repeated closing node. */
  readonly cycle?: readonly string[]
}

/**
 * Result of parsing one definition.
 *
 * `value` is present only when `ok` is true. Successful results still carry
 * `issues` for non-fatal coercions, such as falling back to `T2` when `tier`
 * is missing or unknown.
 */
export type ValidationResult<T> =
  | { readonly ok: true; readonly value: T; readonly issues: readonly ValidationIssue[] }
  | { readonly ok: false; readonly issues: readonly ValidationIssue[] }

/**
 * Best-effort result for graph editing.
 *
 * `value` is present whenever the YAML root was an object, even when one or
 * more semantic issues make the strict workflow parser reject the definition.
 * A YAML syntax failure has no recoverable candidate.
 */
export interface WorkflowGraphResult {
  readonly value?: WorkflowDefinition
  readonly issues: readonly ValidationIssue[]
}

/** One node's execution level in a best-effort topology. */
export interface WorkflowNodeLevel {
  readonly id: string
  /** Zero-based schedule level, or `-1` when a cycle prevents assignment. */
  readonly level: number
}

/**
 * Business-domain defaults an Agent inherits when it joins the domain.
 *
 * A domain is a registry entry, not a constraint: the Agent definition still
 * carries its own harness, model, and permissions. The domain supplies the
 * starting point the editor pre-fills.
 */
export interface DomainDefinition {
  readonly domain: string
  readonly displayName: string
  readonly description: string
  readonly defaultPermissions: AgentPermissions
  readonly defaultKnowledgeBases: readonly string[]
  readonly costLimitPerRun: number
}

/** Type constraint on one field of a published surface view. */
export interface ActorSurfaceField {
  readonly type: string
  readonly required: boolean
  readonly maxLength?: number
  readonly min?: number
  readonly max?: number
  readonly enumValues?: readonly string[]
}

/** One surface view an Actor is allowed to publish. */
export interface ActorSurfaceView {
  readonly viewId: string
  readonly outputContract: string
  readonly description: string
  readonly requiredPhases: readonly string[]
  readonly fields: Readonly<Record<string, ActorSurfaceField>>
}

/**
 * An Actor's publishable surface whitelist.
 *
 * The profile follows the Actor, not the Agent: two Agents that share an
 * Actor id publish the same set of views.
 */
export interface ActorVisualProfile {
  readonly actorId: string
  readonly description: string
  readonly allowedSurfaceViews: readonly ActorSurfaceView[]
}
