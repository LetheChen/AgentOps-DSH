import { evaluateExpression, evaluateValue } from './expr.js'
import { effectiveDependencies, validateWorkflow } from './validate.js'
import type {
  NodeExecutor,
  NodeState,
  RunOptions,
  RunState,
  WorkflowDefinition,
  WorkflowNode,
} from './types.js'

/** Raised when a workflow fails validation before any node runs. */
export class WorkflowValidationError extends Error {
  constructor(readonly errors: readonly string[]) {
    super(`工作流校验失败：${errors.join('；')}`)
    this.name = 'WorkflowValidationError'
  }
}

/** Stable reasons a persisted run cannot be mutated for a node rerun. */
export type RunMutationErrorCode = 'unknown_node' | 'workflow_mismatch' | 'run_running'

/** Rejection raised when a node rerun cannot invalidate the requested run. */
export class RunMutationError extends Error {
  constructor(
    readonly code: RunMutationErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'RunMutationError'
  }
}

/**
 * Invalidate one node for a resume without executing it.
 *
 * The returned state is a clone marked `running`. The target and, unless
 * `onlyNode` is true, every transitive runtime downstream node return to
 * `pending`; their attempts remain, while timestamps, errors, ports and
 * outputs are discarded. `parallel_branch` branch dependencies participate in
 * downstream discovery.
 * @param run - settled or failed run to fork into a resume.
 * @param workflow - current definition used to resolve runtime dependencies.
 * @param nodeId - node to execute again.
 * @param onlyNode - preserve completed downstream nodes when true.
 * @returns a cloned run ready to persist as running or pass to resume.
 * @throws {RunMutationError} when the run is running, the workflow differs, or the node is absent.
 */
export function invalidateRunForNode(
  run: RunState,
  workflow: WorkflowDefinition,
  nodeId: string,
  onlyNode: boolean,
): RunState {
  if (run.status === 'running') {
    throw new RunMutationError('run_running', `运行 ${run.runId} 仍在执行，不能重跑节点`)
  }
  if (run.runId !== workflow.id && !run.runId.startsWith(`${workflow.id}@`)) {
    throw new RunMutationError(
      'workflow_mismatch',
      `工作流 ${workflow.id} 与运行 ${run.runId} 不匹配`,
    )
  }
  if (!workflow.nodes.some(node => node.id === nodeId)) {
    throw new RunMutationError('unknown_node', `工作流 ${workflow.id} 不包含节点 ${nodeId}`)
  }

  const next = structuredClone(run)
  const invalidated = new Set<string>([nodeId])
  if (!onlyNode) {
    const children = new Map<string, string[]>()
    for (const [id, dependencies] of effectiveDependencies(workflow)) {
      for (const dependency of dependencies) {
        const downstream = children.get(dependency)
        if (downstream === undefined) children.set(dependency, [id])
        else downstream.push(id)
      }
    }
    const queue = [nodeId]
    while (queue.length > 0) {
      const current = queue.shift()
      if (current === undefined) break
      for (const child of children.get(current) ?? []) {
        if (invalidated.has(child)) continue
        invalidated.add(child)
        queue.push(child)
      }
    }
  }

  for (const id of invalidated) {
    const node = next.nodes[id]
    if (node !== undefined) next.nodes[id] = { status: 'pending', attempts: node.attempts }
  }
  next.status = 'running'
  delete next.finishedAt
  delete next.error
  return next
}

/**
 * Level-scheduled DAG runner.
 *
 * Fixes two defects of the legacy Python engine by construction: a gateway
 * evaluates its condition instead of always taking the first port, and a
 * `parallel_branch` aggregator depends on its branches, so it cannot read
 * empty output from running in the same level.
 */
export class DagEngine {
  /**
   * Execute a workflow.
   * @param workflow - definition to run.
   * @param executor - per-node callback (not called for gateway/aggregator/while).
   * @param options - concurrency, cancellation and progress.
   * @returns the settled run state.
   */
  async run(
    workflow: WorkflowDefinition,
    executor: NodeExecutor,
    options: RunOptions = {},
  ): Promise<RunState> {
    const validation = validateWorkflow(workflow)
    if (!validation.ok) throw new WorkflowValidationError(validation.errors)

    const byId = new Map(workflow.nodes.map(node => [node.id, node]))
    const deps = effectiveDependencies(workflow)
    const inputs = { ...(options.inputs ?? options.resume?.inputs ?? {}) }
    const state: RunState = options.resume === undefined
      ? {
        runId: options.runId ?? workflow.id,
        status: 'running',
        inputs,
        nodes: Object.fromEntries(workflow.nodes.map(node => [node.id, { status: 'pending', attempts: 0 }])),
        startedAt: new Date().toISOString(),
      }
      : (() => {
        const previous = structuredClone(options.resume)
        delete previous.finishedAt
        return { ...previous, status: 'running' as const, inputs }
      })()

    const outputs = new Map<string, Record<string, unknown>>()
    for (const [id, nodeState] of Object.entries(state.nodes)) {
      if (nodeState.status === 'completed') {
        if (nodeState.outputs !== undefined) outputs.set(id, nodeState.outputs)
        continue
      }
      // Resume reruns everything that did not complete: failed, skipped after a
      // failure, or interrupted mid-flight. Attempts are preserved as history.
      state.nodes[id] = { status: 'pending', attempts: nodeState.attempts }
    }
    const concurrency = Math.max(1, options.concurrency ?? 4)

    for (const level of validation.levels) {
      if (options.signal?.aborted) {
        return this.cancel(state)
      }

      for (const id of level) {
        if (this.blockedByUpstream(id, deps, state) || this.blockedByGatewayPort(id, byId, state)) {
          this.settle(state, id, { status: 'skipped' }, options)
        }
      }

      const runnable = level.filter(id => state.nodes[id]?.status === 'pending')
      await this.runLevel(runnable, async (id) => {
        const node = byId.get(id)
        if (node === undefined) throw new Error(`工作流不包含节点：${id}`)
        const nodeState = state.nodes[id]
        if (nodeState === undefined) throw new Error(`运行状态不包含节点：${id}`)
        nodeState.status = 'running'
        nodeState.attempts += 1
        nodeState.startedAt = new Date().toISOString()
        try {
          const result = await this.executeNode(node, state.runId, state.inputs ?? {}, byId, deps, outputs, executor, options)
          outputs.set(id, result.outputs)
          this.settle(state, id, {
            status: 'completed',
            finishedAt: new Date().toISOString(),
            outputs: result.outputs,
            ...(result.chosenPort === undefined ? {} : { chosenPort: result.chosenPort }),
          }, options)
        } catch (error) {
          this.settle(state, id, {
            status: 'failed',
            finishedAt: new Date().toISOString(),
            error: error instanceof Error ? error.message : String(error),
          }, options)
        }
      }, concurrency, options.signal)
    }

    if (options.signal?.aborted) return this.cancel(state)

    const failed = Object.values(state.nodes).some(node => node.status === 'failed')
    state.status = failed ? 'failed' : 'completed'
    state.finishedAt = new Date().toISOString()
    return state
  }

  private async executeNode(
    node: WorkflowNode,
    runId: string,
    inputs: Readonly<Record<string, unknown>>,
    byId: Map<string, WorkflowNode>,
    deps: Map<string, string[]>,
    outputs: Map<string, Record<string, unknown>>,
    executor: NodeExecutor,
    options: RunOptions,
  ): Promise<{ outputs: Record<string, unknown>; chosenPort?: string }> {
    const upstream = this.upstreamOf(node.id, deps, outputs)
    if (node.skipIf !== undefined && evaluateExpression(node.skipIf, upstream)) {
      return { outputs: { skipped: true, reason: node.skipIf } }
    }
    const context = {
      runId,
      inputs,
      iteration: 1,
      upstream,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    }

    if (node.type === 'parallel_branch') {
      const branches: Record<string, unknown> = {}
      for (const branch of node.branches ?? []) branches[branch] = outputs.get(branch) ?? null
      return { outputs: { branches } }
    }

    if (node.type === 'gateway') {
      const decision = evaluateValue(node.condition ?? '', upstream)
      const ports = Object.keys(node.outputs ?? {})
      let chosenPort: string | undefined
      if (typeof decision === 'string' && decision.length > 0) {
        // Legacy gateways select a port by name (`cond ? 'reject' : 'pass'`).
        if (!ports.includes(decision)) {
          throw new Error(`gateway ${node.id} 条件返回了未声明的端口：${decision}`)
        }
        chosenPort = decision
      } else {
        const truthy = decision !== null && (typeof decision === 'boolean' ? decision : Boolean(decision))
        chosenPort = truthy ? ports[0] : (ports[1] ?? ports[0])
      }
      if (chosenPort === undefined) throw new Error(`gateway ${node.id} 没有可用端口`)
      return { outputs: { [chosenPort]: true }, chosenPort }
    }

    if (node.type === 'while') {
      const results: Record<string, unknown> = {}
      let completed = 0
      const max = node.maxIterations ?? 1
      while (completed < max) {
        const merged = { ...upstream, ...results, iteration: completed }
        if (!evaluateExpression(node.continueIf ?? '', merged)) break
        completed += 1
        const iteration = completed
        for (const bodyId of node.body ?? []) {
          const bodyNode = byId.get(bodyId)
          if (bodyNode === undefined) throw new Error(`while ${node.id} 的 body 节点不存在：${bodyId}`)
          const bodyOutputs = await executor(bodyNode, {
            runId,
            inputs,
            iteration,
            upstream: merged,
            ...(options.signal === undefined ? {} : { signal: options.signal }),
          })
          results[bodyId] = bodyOutputs ?? {}
        }
      }
      return { outputs: { iterations: completed, results } }
    }

    const produced = await executor(node, context)
    return { outputs: produced ?? {} }
  }

  private upstreamOf(
    id: string,
    deps: Map<string, string[]>,
    outputs: Map<string, Record<string, unknown>>,
  ): Record<string, unknown> {
    const upstream: Record<string, unknown> = {}
    for (const dep of deps.get(id) ?? []) {
      upstream[dep] = outputs.get(dep) ?? {}
    }
    return upstream
  }

  private blockedByUpstream(id: string, deps: Map<string, string[]>, state: RunState): boolean {
    return (deps.get(id) ?? []).some((dep) => {
      const status = state.nodes[dep]?.status
      return status === 'failed' || status === 'skipped'
    })
  }

  /**
   * A gateway port routes data to its declared targets. Only targets of the
   * selected port are eligible; an unselected target is skipped even though its
   * scheduling dependency (the gateway itself) completed.
   */
  private blockedByGatewayPort(id: string, byId: Map<string, WorkflowNode>, state: RunState): boolean {
    for (const [gatewayId, gateway] of byId) {
      if (gateway.type !== 'gateway') continue
      const settled = state.nodes[gatewayId]
      if (settled?.status !== 'completed' || settled.chosenPort === undefined) continue
      const selected = new Set(this.portTargets(gateway.outputs?.[settled.chosenPort]))
      const unselected = new Set<string>()
      for (const [port, targets] of Object.entries(gateway.outputs ?? {})) {
        if (port === settled.chosenPort) continue
        for (const target of this.portTargets(targets)) unselected.add(target)
      }
      if (unselected.has(id) && !selected.has(id)) return true
    }
    return false
  }

  private portTargets(targets: string | readonly string[] | undefined): readonly string[] {
    if (targets === undefined) return []
    return typeof targets === 'string' ? [targets] : targets
  }

  private settle(state: RunState, id: string, patch: Partial<NodeState>, options: RunOptions): void {
    const node = state.nodes[id]
    if (node === undefined) throw new Error(`运行状态不包含节点：${id}`)
    Object.assign(node, patch)
    options.onNodeSettled?.(id, { ...node })
  }

  private async runLevel(
    ids: readonly string[],
    task: (id: string) => Promise<void>,
    concurrency: number,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    let cursor = 0
    const workers = Array.from({ length: Math.min(concurrency, ids.length) }, async () => {
      while (cursor < ids.length) {
        if (signal?.aborted) return
        const index = cursor
        cursor += 1
        const id = ids[index]
        if (id !== undefined) await task(id)
      }
    })
    await Promise.all(workers)
  }

  private cancel(state: RunState): RunState {
    state.status = 'cancelled'
    state.finishedAt = new Date().toISOString()
    for (const node of Object.values(state.nodes)) {
      if (node.status === 'pending' || node.status === 'ready') node.status = 'skipped'
    }
    return state
  }
}
