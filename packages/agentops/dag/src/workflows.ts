/**
 * Workflow catalog route: scan a directory of legacy YAML files and report
 * validation state. Read-only — no run, no write.
 *
 * @module @agentops/dsh-dag/workflows
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { scheduleDependencies } from '@agentops/dsh-contracts'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'

import { parseWorkflowYaml } from './load.ts'
import type { NodeType, WorkflowRunInputDefinition } from './types.ts'
import { validateWorkflow } from './validate.ts'

/** One node of a workflow summary, with the level it runs in. */
export interface WorkflowSummaryNode {
  id: string
  level: number
  type: NodeType
  agentRef?: string
  displayName?: string
  businessRole?: string
}

/** Catalogue entry for one workflow file and its validation state. */
export interface WorkflowSummary {
  id: string
  file: string
  name: string
  description?: string
  nodeCount: number
  levelCount: number
  ok: boolean
  errors: string[]
  status: 'verified' | 'invalid'
  /** Top-level run inputs in YAML declaration order. */
  inputs: readonly WorkflowRunInputDefinition[]
  /** Nodes with their execution level and source metadata, for previews and Agent bindings. */
  nodes: WorkflowSummaryNode[]
  /** Edges as `after` dependencies, for the same preview. */
  edges: { from: string; to: string }[]
  /** Source-file modification time in ISO form when it can be read. */
  updatedAt?: string
}

/**
 * Scan one directory.
 *
 * A missing directory is not an error: the page shows an empty catalog instead
 * of failing, which is what a freshly installed host looks like.
 * @param dir - directory holding `*.yaml` workflows.
 * @returns the scanned entries, and whether the directory was missing.
 */
export function scanWorkflows(dir: string): { dir: string; entries: WorkflowSummary[]; missing: boolean } {
  let files: string[]
  try {
    files = readdirSync(dir).filter(name => name.endsWith('.yaml')).sort()
  } catch {
    return { dir, entries: [], missing: true }
  }

  const entries = files.map((file) => {
    const target = join(dir, file)
    let updatedAt: string | undefined
    try {
      updatedAt = statSync(target).mtime.toISOString()
    } catch (_statFailure) {
      // A concurrent deletion must not hide the remaining catalogue entries.
    }
    try {
      const workflow = parseWorkflowYaml(readFileSync(target, 'utf8'))
      const validation = validateWorkflow(workflow)
      const levelOf = new Map<string, number>()
      validation.levels.forEach((level, index) => {
        for (const id of level) levelOf.set(id, index)
      })
      return {
        id: workflow.id,
        file,
        name: workflow.name ?? workflow.id,
        ...(workflow.description === undefined ? {} : { description: workflow.description }),
        nodeCount: workflow.nodes.length,
        levelCount: validation.levels.length,
        ok: validation.ok,
        errors: validation.errors,
        status: validation.ok ? 'verified' as const : 'invalid' as const,
        inputs: workflow.inputs,
        nodes: workflow.nodes.map(node => ({
          id: node.id,
          level: levelOf.get(node.id) ?? -1,
          type: node.type,
          ...(node.agentRef === undefined ? {} : { agentRef: node.agentRef }),
          ...(node.displayName === undefined ? {} : { displayName: node.displayName }),
          ...(node.businessRole === undefined ? {} : { businessRole: node.businessRole }),
        })),
        edges: workflow.nodes.flatMap(node =>
          scheduleDependencies(node).map(dep => ({ from: dep, to: node.id })),
        ),
        ...(updatedAt === undefined ? {} : { updatedAt }),
      }
    } catch (error) {
      return {
        id: file.replace(/\.yaml$/, ''),
        file,
        name: file.replace(/\.yaml$/, ''),
        nodeCount: 0,
        levelCount: 0,
        ok: false,
        errors: [error instanceof Error ? error.message : String(error)],
        status: 'invalid' as const,
        inputs: [],
        nodes: [],
        edges: [],
        ...(updatedAt === undefined ? {} : { updatedAt }),
      }
    }
  })
  return { dir, entries, missing: false }
}

/**
 * Register `GET /api/agentops/workflows`.
 * @param ctx - context carrying Connection.
 * @param dir - workflow directory (config or `AGENTOPS_WORKFLOW_DIR`).
 */
export function registerWorkflowRoute(ctx: Context, dir: string): void {
  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/agentops/workflows',
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: () => Promise.resolve(new Response(JSON.stringify(scanWorkflows(dir)), {
      headers: { 'content-type': 'application/json; charset=utf-8' },
    })),
  }), 'agentops-dag: /api/agentops/workflows')
}
