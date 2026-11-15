/** DAG vocabulary mirroring the AgentOps workflow YAML, minus its Python eval. */

export type NodeType = 'agent' | 'command' | 'gateway' | 'parallel_branch' | 'while'

/** Value type accepted by one workflow run input. */
export type WorkflowRunInputType = 'string' | 'integer' | 'number' | 'boolean' | 'array'

/** One top-level workflow input declared by the YAML source. */
export interface WorkflowRunInputDefinition {
  /** Stable key used by the run form and the JSON prompt. */
  name: string
  type: WorkflowRunInputType
  /** Whether a value or a default is required before the run starts. */
  required: boolean
  /** Validated default value, already converted to {@link type}. */
  default?: unknown
  description?: string
}

/** One node of a workflow definition: its type, prompt fields, and dependencies. */
export interface WorkflowNode {
  id: string
  type: NodeType
  /** Human-readable label from the YAML `name` field. */
  displayName?: string
  /** Agent catalog reference from the YAML `agent` field. */
  agentRef?: string
  /** Business-facing role used to group collaboration lanes. */
  businessRole?: string
  /** Execution harness selected for this node. */
  harness?: string
  /** Requested model name or routing alias. */
  model?: string
  /** Node-specific execution instructions appended to the generated node prompt. */
  rolePrompt?: string
  /** Wall-clock limit for one executor invocation. */
  timeoutMs?: number
  /** Legacy command declaration, retained so validation can inspect it. */
  commandConfig?: Readonly<Record<string, unknown>>
  /** Legacy command-wait declaration, retained without executing Python eval. */
  awaitCommandConfig?: Readonly<Record<string, unknown>>
  /** Full legacy while declaration retained alongside its normalized fields. */
  whileConfig?: Readonly<Record<string, unknown>>
  /** Upstream nodes that must finish before this one starts. */
  after: readonly string[]
  /**
   * Output port → target(s). Gateway ports are the decision branches; every
   * other node's ports feed downstream `after` checks.
   */
  outputs?: Readonly<Record<string, string | readonly string[]>>
  /** Gateway decision expression; required for `gateway`. */
  condition?: string
  /** `parallel_branch`: nodes aggregated by this node. */
  branches?: readonly string[]
  /** `while`: body nodes executed in order per iteration. */
  body?: readonly string[]
  /** `while`: continuation expression evaluated before each iteration. */
  continueIf?: string
  /** `while`: hard iteration cap; required for `while`. */
  maxIterations?: number
  /** Skip the node (and record it as skipped) when this expression is truthy. */
  skipIf?: string
}

/** A parsed workflow: identity, declared run inputs, and its nodes. */
export interface WorkflowDefinition {
  id: string
  /** Human-readable workflow name from the YAML `name` field. */
  name?: string
  /** Business-facing purpose from the YAML `description` field. */
  description?: string
  /** Top-level run inputs in YAML declaration order. */
  inputs: readonly WorkflowRunInputDefinition[]
  nodes: readonly WorkflowNode[]
}

/** Lifecycle status of one node inside a run. */
export type NodeStatus = 'pending' | 'ready' | 'running' | 'completed' | 'failed' | 'skipped'

/** Recorded state of one node inside a run. */
export interface NodeState {
  status: NodeStatus
  attempts: number
  startedAt?: string
  finishedAt?: string
  error?: string
  /** Port the gateway selected, for run inspection. */
  chosenPort?: string
  /** Outputs produced by the executor, or aggregated for `parallel_branch`. */
  outputs?: Record<string, unknown>
}

/** Persisted state of one workflow run and its nodes. */
export interface RunState {
  runId: string
  status: 'running' | 'completed' | 'failed' | 'cancelled'
  /** Top-level workflow inputs used by this run. Absent in legacy persisted runs. */
  inputs?: Readonly<Record<string, unknown>>
  nodes: Record<string, NodeState>
  startedAt: string
  finishedAt?: string
  error?: string
}

/** Per-node execution callback. `parallel_branch` and `while` never call it. */
export interface NodeExecutor {
  (node: WorkflowNode, context: ExecutorContext): Promise<Record<string, unknown> | void>
}

/** Run inputs and upstream results handed to a node executor. */
export interface ExecutorContext {
  runId: string
  /** Top-level workflow inputs for this run. */
  inputs: Readonly<Record<string, unknown>>
  /** 1-based iteration for nodes executed inside a `while`. */
  iteration: number
  /** Outputs of every completed upstream node, keyed by node id. */
  upstream: Readonly<Record<string, unknown>>
  signal?: AbortSignal
}

/** Caller-supplied options for one workflow run. */
export interface RunOptions {
  /** Stable run identity. Defaults to the workflow id for direct callers. */
  runId?: string
  /** Top-level workflow inputs exposed to every executor. Defaults to `{}`. */
  inputs?: Readonly<Record<string, unknown>>
  /** Maximum nodes executing at once per level. Default 4. */
  concurrency?: number
  /** Cancels the run between nodes. */
  signal?: AbortSignal
  /** Called whenever a node settles, for progress reporting. */
  onNodeSettled?: (nodeId: string, state: NodeState) => void
  /** Previous settled state; completed nodes are not executed again. */
  resume?: RunState
}
