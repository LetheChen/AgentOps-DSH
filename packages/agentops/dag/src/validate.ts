import { dataEdges, scheduleDependencies } from '@agentops/dsh-contracts'

import { tokenizeExpression } from './expr.js'
import type { WorkflowDefinition, WorkflowNode } from './types.js'

/** Validation outcome: the reported errors plus the computed execution levels. */
export interface ValidationResult {
  ok: boolean
  errors: string[]
  /** Execution order: nodes in a level may run in parallel. */
  levels: string[][]
}

/**
 * Validate a workflow and compute its execution levels.
 *
 * Adds the dependency the legacy engine lacked: a `parallel_branch` aggregator
 * waits for every declared branch, so the aggregator can never read empty
 * branch output because it ran in the same level.
 * @param workflow - nodes and identity.
 * @returns errors plus levels (empty on failure).
 */
export function validateWorkflow(workflow: WorkflowDefinition): ValidationResult {
  const errors: string[] = []
  const byId = new Map<string, WorkflowNode>()

  for (const node of workflow.nodes) {
    if (byId.has(node.id)) errors.push(`节点 id 重复：${node.id}`)
    byId.set(node.id, node)
  }
  if (byId.size === 0) errors.push('工作流至少需要一个节点')

  for (const edge of dataEdges(workflow.nodes)) {
    if (!byId.has(edge.to)) errors.push(`节点 ${edge.from} 的输出指向不存在的节点：${edge.to}`)
  }

  for (const node of workflow.nodes) {
    for (const upstream of scheduleDependencies(node)) {
      if (upstream === node.id) errors.push(`节点 ${node.id} 不能依赖自身`)
      else if (!byId.has(upstream)) errors.push(`节点 ${node.id} 依赖不存在的节点：${upstream}`)
    }

    if (node.type === 'gateway') {
      if (!node.condition) errors.push(`gateway 节点 ${node.id} 缺少 condition`)
      else errors.push(...expressionErrors(node.condition).map(e => `gateway ${node.id}: ${e}`))
      if (Object.keys(node.outputs ?? {}).length === 0) errors.push(`gateway 节点 ${node.id} 没有输出端口`)
    }

    if (node.type === 'parallel_branch') {
      if (!node.branches || node.branches.length === 0) errors.push(`parallel_branch 节点 ${node.id} 缺少 branches`)
      for (const branch of node.branches ?? []) {
        if (!byId.has(branch)) errors.push(`parallel_branch 节点 ${node.id} 的分支不存在：${branch}`)
        if (branch === node.id) errors.push(`parallel_branch 节点 ${node.id} 不能把自己作为分支`)
      }
    }

    if (node.type === 'while') {
      if (!node.body || node.body.length === 0) errors.push(`while 节点 ${node.id} 缺少 body`)
      if (!Number.isInteger(node.maxIterations) || (node.maxIterations ?? 0) < 1) {
        errors.push(`while 节点 ${node.id} 需要正整数 maxIterations`)
      }
      if (!node.continueIf) errors.push(`while 节点 ${node.id} 缺少 continueIf`)
      else errors.push(...expressionErrors(node.continueIf).map(e => `while ${node.id}: ${e}`))
      for (const bodyNode of node.body ?? []) {
        if (!byId.has(bodyNode)) errors.push(`while 节点 ${node.id} 的 body 不存在：${bodyNode}`)
      }
    }

    if (node.skipIf !== undefined) {
      errors.push(...expressionErrors(node.skipIf).map(e => `skip_if ${node.id}: ${e}`))
    }

    if (node.type !== 'while' && node.body !== undefined) errors.push(`节点 ${node.id} 不是 while 却声明了 body`)
    if (node.type !== 'parallel_branch' && node.branches !== undefined) {
      errors.push(`节点 ${node.id} 不是 parallel_branch 却声明了 branches`)
    }
  }

  if (errors.length > 0) return { ok: false, errors, levels: [] }

  const inner = innerNodeIds(workflow)
  for (const node of workflow.nodes) {
    if (inner.has(node.id)) continue
    for (const upstream of scheduleDependencies(node)) {
      if (inner.has(upstream)) errors.push(`节点 ${node.id} 不能依赖 while body 节点：${upstream}`)
    }
  }
  if (errors.length > 0) return { ok: false, errors, levels: [] }

  const deps = effectiveDependencies(workflow)
  const cycle = findCycle(deps)
  if (cycle !== undefined) return { ok: false, errors: [`存在循环依赖：${cycle.join(' → ')}`], levels: [] }

  return { ok: true, errors: [], levels: topologicalLevels(deps) }
}

/**
 * Dependencies actually enforced at run time.
 * @param workflow - definition.
 * @returns node id → prerequisite ids.
 */
export function effectiveDependencies(workflow: WorkflowDefinition): Map<string, string[]> {
  const inner = innerNodeIds(workflow)
  const deps = new Map<string, string[]>()
  for (const node of workflow.nodes) {
    if (inner.has(node.id)) continue
    deps.set(node.id, [...scheduleDependencies(node)])
  }

  for (const node of workflow.nodes) {
    if (node.type !== 'parallel_branch') continue
    for (const branch of node.branches ?? []) {
      const list = deps.get(node.id)
      if (list !== undefined) list.push(branch)
    }
  }
  return deps
}

/**
 * Group nodes into levels by dependency depth.
 * @param deps - node id → prerequisites.
 * @returns ordered levels, each sorted for determinism.
 */
export function topologicalLevels(deps: Map<string, string[]>): string[][] {
  const remaining = new Map<string, Set<string>>()
  for (const [id, list] of deps) remaining.set(id, new Set(list))

  const levels: string[][] = []
  const done = new Set<string>()
  while (remaining.size > 0) {
    const level = [...remaining.entries()]
      .filter(([, prerequisites]) => [...prerequisites].every(dep => done.has(dep)))
      .map(([id]) => id)
      .sort()
    if (level.length === 0) break
    for (const id of level) { remaining.delete(id); done.add(id) }
    levels.push(level)
  }
  return levels
}

/**
 * Nodes that only run inside a `while` body, never at the top level.
 * @param workflow - the workflow whose `while` bodies are inspected.
 * @returns the ids of nodes that only run inside a `while` body.
 */
export function innerNodeIds(workflow: WorkflowDefinition): Set<string> {
  const inner = new Set<string>()
  for (const node of workflow.nodes) {
    if (node.type !== 'while') continue
    for (const bodyNode of node.body ?? []) inner.add(bodyNode)
  }
  return inner
}


function expressionErrors(source: string): string[] {
  try {
    tokenizeExpression(source)
    return []
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)]
  }
}

function findCycle(deps: Map<string, string[]>): string[] | undefined {
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const stack: string[] = []

  const walk = (id: string): string[] | undefined => {
    if (visited.has(id)) return undefined
    if (visiting.has(id)) return [...stack.slice(stack.indexOf(id)), id]
    visiting.add(id)
    stack.push(id)
    for (const dep of deps.get(id) ?? []) {
      const cycle = walk(dep)
      if (cycle !== undefined) return cycle
    }
    stack.pop()
    visiting.delete(id)
    visited.add(id)
    return undefined
  }

  for (const id of deps.keys()) {
    const cycle = walk(id)
    if (cycle !== undefined) return cycle
  }
  return undefined
}
