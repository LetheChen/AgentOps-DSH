import { createHash } from 'node:crypto'

import { WorkflowCycleError, topoLayers } from '@agentops/dsh-contracts'
import type { ValidationIssue, WorkflowDefinition, WorkflowNode } from '@agentops/dsh-contracts'

/** One compiled workflow: the script source, its layers, and a stable digest. */
export interface CompiledWorkflow {
  /** Source for `new vm.Script(...)`: an async IIFE the PTC runtime evaluates. */
  readonly source: string
  /** Node ids grouped by `after` layers; the source mirrors this grouping. */
  readonly layers: readonly (readonly string[])[]
  /** SHA-256 over the generated body, without the header comment. */
  readonly digest: string
}

/** Compilation inputs that are not part of the workflow definition. */
export interface CompileOptions {
  /** Emitted as `provider` and `model` on every `agent()` call. */
  readonly model?: { readonly provider: string; readonly id: string }
}

/** A compiler outcome: either an executable artifact or structured blockers. */
export type CompileResult =
  | { readonly ok: true; readonly value: CompiledWorkflow }
  | { readonly ok: false; readonly issues: readonly ValidationIssue[] }

function identifier(nodeId: string): string {
  const safe = nodeId.replace(/[^A-Za-z0-9_]/g, '_')
  return `node_${/^[0-9]/.test(safe) ? `_${safe}` : safe}`
}

function agentOptions(node: WorkflowNode, layer: string, options: CompileOptions): string {
  const entries = [
    `label: ${JSON.stringify(node.id)}`,
    `phase: ${JSON.stringify(layer)}`,
    ...(options.model === undefined
      ? []
      : [`provider: ${JSON.stringify(options.model.provider)}`, `model: ${JSON.stringify(options.model.id)}`]),
  ]
  return `{ ${entries.join(', ')} }`
}

function call(node: WorkflowNode, layer: string, options: CompileOptions): string {
  return `agent(${JSON.stringify(node.rolePrompt)}, ${agentOptions(node, layer, options)})`
}

/**
 * Compile a validated workflow into the script shape the PTC runtime evaluates.
 *
 * Layers come from `after` alone, so a node that declares a dependency only
 * through `outputs` compiles into the same layer as its producer and runs in
 * parallel with it. Every layer starts a `phase()`; a multi-node layer becomes
 * one `parallel([...])` barrier, which is the same "wait for the whole layer"
 * semantics the layered scheduler has.
 *
 * @param definition - a definition already accepted by `parseWorkflowDefinition`.
 * @param options - model hint emitted into each `agent()` call.
 * Non-Agent nodes retain their YAML definition and remain editable, but this
 * executor cannot compile them. They are reported as `unsupported` instead of
 * being silently emitted as Agent calls.
 *
 * @returns the executable artifact, or every reason compilation cannot proceed.
 */
export function compileWorkflow(definition: WorkflowDefinition, options: CompileOptions = {}): CompileResult {
  const unsupported = definition.nodes
    .filter(node => node.type !== 'agent')
    .map((node): ValidationIssue => ({
      path: `nodes.${node.id}.type`,
      kind: 'unsupported',
      message: `执行器当前只支持 agent 节点，${node.id} 是 ${node.type}`,
    }))
  if (unsupported.length > 0) return { ok: false, issues: unsupported }

  let layers: readonly (readonly string[])[]
  try {
    layers = topoLayers(definition.nodes)
  } catch (reason) {
    if (reason instanceof WorkflowCycleError) {
      return {
        ok: false,
        issues: [{
          path: `nodes.${reason.cycle[0] ?? ''}.after`,
          kind: 'cycle',
          message: reason.message,
          nodeIds: reason.cycle,
          cycle: reason.cycle,
        }],
      }
    }
    throw reason
  }
  const byId = new Map(definition.nodes.map(node => [node.id, node]))
  const body: string[] = []

  for (const [index, layer] of layers.entries()) {
    const phase = `layer-${index}`
    body.push(`  phase(${JSON.stringify(phase)})`)

    if (layer.length === 1) {
      const node = byId.get(layer[0] as string) as WorkflowNode
      body.push(`  const ${identifier(node.id)} = await ${call(node, phase, options)}`)
      continue
    }

    body.push('  const [')
    for (const id of layer) body.push(`    ${identifier(id)},`)
    body.push('  ] = await parallel([')
    for (const id of layer) {
      const node = byId.get(id) as WorkflowNode
      body.push(`    () => ${call(node, phase, options)},`)
    }
    body.push('  ])')
  }

  body.push('  return {')
  for (const node of definition.nodes) body.push(`    ${JSON.stringify(node.id)}: ${identifier(node.id)},`)
  body.push('  }')

  const inner = body.join('\n')
  const digest = createHash('sha256').update(inner, 'utf8').digest('hex')
  const source = `// generated from workflow ${definition.workflowId} v${definition.version}\n(async () => {\n${inner}\n})()`

  return { ok: true, value: { source, layers, digest } }
}
