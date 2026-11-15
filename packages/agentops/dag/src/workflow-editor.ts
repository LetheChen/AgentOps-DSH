/**
 * HTTP routes for the workflow YAML editor.
 *
 * The editor reads exact source text, validates drafts without writing, and
 * saves through the catalogue's compare-and-swap operation. File-system errors
 * are translated here so request handlers never expose host paths.
 *
 * @module @agentops/dsh-dag/workflow-editor
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import { dataEdges, loadWorkflowGraph, scheduleDependencies, topoLevelsLenient } from '@agentops/dsh-contracts'
import type { ValidationIssue, WorkflowDefinition, WorkflowNode } from '@agentops/dsh-contracts'
import {
  CatalogConflictError,
  CatalogCreateConflictError,
  CatalogInvalidError,
} from '@agentops/dsh-workflow-catalog'

import {
  WorkflowEditError,
  applyWorkflowEdit,
  parseWorkflowEditOperation,
} from './workflow-edit.ts'

const SOURCE_PATH = '/api/agentops/workflow-source'
const VALIDATE_PATH = '/api/agentops/workflow-validate'
const CREATE_PATH = '/api/agentops/workflow-create'
const SAVE_PATH = '/api/agentops/workflow-save'
const EDIT_PATH = '/api/agentops/workflow-edit'
const DELETE_PATH = '/api/agentops/workflow-delete'
const MAX_SOURCE_BYTES = 1_048_576
const WORKFLOW_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/

interface WorkflowGraph {
  readonly nodes: readonly (WorkflowNode & { readonly level: number })[]
  readonly edges: readonly { readonly from: string; readonly to: string }[]
  readonly dataEdges: readonly { readonly from: string; readonly to: string; readonly port: string }[]
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}

function failure(status: number, message: string): Response {
  return json({ error: message }, status)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value)
  return actual.length === keys.length && keys.every(key => key in value)
}

function isErrno(reason: unknown, code: string): boolean {
  return reason instanceof Error && 'code' in reason && reason.code === code
}

function exceedsLimit(text: string): boolean {
  return Buffer.byteLength(text, 'utf8') > MAX_SOURCE_BYTES
}

async function requestRecord(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = await request.json()
    return isRecord(parsed) ? parsed : null
  } catch (_malformed) {
    // The caller reports a malformed or non-object body as missing required fields.
    return null
  }
}

function graphOf(definition: WorkflowDefinition): WorkflowGraph {
  const levelOf = new Map(topoLevelsLenient(definition.nodes).map(node => [node.id, node.level]))
  return {
    nodes: definition.nodes.map(node => ({ ...node, level: levelOf.get(node.id) ?? -1 })),
    edges: definition.nodes.flatMap(node => scheduleDependencies(node).map(from => ({ from, to: node.id }))),
    dataEdges: dataEdges(definition.nodes),
  }
}

function invalidIssues(issues: readonly ValidationIssue[]): Response {
  return json({ ok: false, issues }, 422)
}

/**
 * Register the source, validate, and save routes for the YAML editor.
 * @param ctx - context carrying both Connection and `workflowCatalog`.
 */
export function registerWorkflowEditorRoutes(ctx: Context): void {
  ctx.effect(() => ctx.connection.fetch.register({
    path: SOURCE_PATH,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const workflowId = new URL(request.url).searchParams.get('id') ?? ''
      if (!WORKFLOW_ID.test(workflowId)) return failure(400, 'invalid workflow id')
      try {
        const source = await ctx.workflowCatalog.readSource(workflowId)
        if (exceedsLimit(source.text)) return failure(413, 'workflow source exceeds 1 MiB')
        return json(source)
      } catch (reason) {
        if (isErrno(reason, 'ENOENT')) return failure(404, 'workflow not found')
        return failure(500, 'internal server error')
      }
    },
  }), `agentops-dag: ${SOURCE_PATH}`)

  ctx.effect(() => ctx.connection.fetch.register({
    path: VALIDATE_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const body = await requestRecord(request)
      if (body === null || typeof body.text !== 'string') return failure(400, 'text is required')
      if (exceedsLimit(body.text)) return failure(413, 'workflow source exceeds 1 MiB')
      try {
        const result = ctx.workflowCatalog.validateAndCompile(body.text)
        if (!result.ok) {
          const graph = loadWorkflowGraph(body.text)
          return json({
            ok: false,
            issues: result.issues,
            ...(graph.value === undefined ? {} : graphOf(graph.value)),
          }, 422)
        }
        return json({
          ok: true,
          issues: result.issues,
          ...graphOf(result.value),
          ...(result.compiled.ok
            ? { compiled: result.compiled.value }
            : { compileIssues: result.compiled.issues }),
        })
      } catch {
        return failure(500, 'internal server error')
      }
    },
  }), `agentops-dag: ${VALIDATE_PATH}`)

  ctx.effect(() => ctx.connection.fetch.register({
    path: CREATE_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const body = await requestRecord(request)
      if (body === null
        || !hasExactKeys(body, ['workflowId', 'text'])
        || typeof body.workflowId !== 'string'
        || typeof body.text !== 'string') {
        return failure(400, 'workflowId and text are required')
      }
      if (exceedsLimit(body.text)) return failure(413, 'workflow source exceeds 1 MiB')
      try {
        return json(await ctx.workflowCatalog.create(body.workflowId, body.text), 201)
      } catch (reason) {
        if (reason instanceof CatalogInvalidError) return invalidIssues(reason.issues)
        if (reason instanceof CatalogCreateConflictError) return failure(409, 'workflow already exists')
        if (reason instanceof RangeError) return failure(400, 'invalid workflow id')
        return failure(500, 'internal server error')
      }
    },
  }), `agentops-dag: ${CREATE_PATH}`)

  ctx.effect(() => ctx.connection.fetch.register({
    path: SAVE_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const body = await requestRecord(request)
      if (body === null
        || typeof body.workflowId !== 'string'
        || typeof body.text !== 'string'
        || (body.expectedDigest !== null && typeof body.expectedDigest !== 'string')) {
        return failure(400, 'workflowId, text, and expectedDigest are required')
      }
      if (exceedsLimit(body.text)) return failure(413, 'workflow source exceeds 1 MiB')
      try {
        const saved = await ctx.workflowCatalog.save(body.workflowId, body.text, body.expectedDigest)
        return json(saved)
      } catch (reason) {
        if (reason instanceof CatalogInvalidError) return invalidIssues(reason.issues)
        if (reason instanceof CatalogConflictError) return json({ actualDigest: reason.actual }, 409)
        if (reason instanceof RangeError) return failure(400, 'invalid workflow id')
        return failure(500, 'internal server error')
      }
    },
  }), `agentops-dag: ${SAVE_PATH}`)

  ctx.effect(() => ctx.connection.fetch.register({
    path: EDIT_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const body = await requestRecord(request)
      if (body === null
        || !hasExactKeys(body, ['text', 'operation'])
        || typeof body.text !== 'string') {
        return failure(400, 'text and operation are required')
      }
      if (exceedsLimit(body.text)) return failure(413, 'workflow source exceeds 1 MiB')

      let operation
      try {
        operation = parseWorkflowEditOperation(body.operation)
      } catch (reason) {
        if (reason instanceof WorkflowEditError) return json({ ok: false, issues: reason.issues }, 400)
        return failure(500, 'internal server error')
      }

      try {
        const edited = applyWorkflowEdit(body.text, operation)
        const compiled = ctx.workflowCatalog.compileDefinition(edited.definition)
        return json({
          ok: true,
          text: edited.text,
          issues: edited.issues,
          ...graphOf(edited.definition),
          ...(compiled.ok
            ? { compiled: compiled.value }
            : { compileIssues: compiled.issues }),
        })
      } catch (reason) {
        if (reason instanceof WorkflowEditError) {
          const graph = reason.candidateText === undefined
            ? undefined
            : loadWorkflowGraph(reason.candidateText)
          return json({
            ok: false,
            issues: reason.issues,
            ...(reason.candidateText === undefined ? {} : { text: reason.candidateText }),
            ...(graph?.value === undefined ? {} : graphOf(graph.value)),
          }, reason.candidateText === undefined && reason.issues.some(issue => issue.kind === 'operation') ? 400 : 422)
        }
        return failure(500, 'internal server error')
      }
    },
  }), `agentops-dag: ${EDIT_PATH}`)

  ctx.effect(() => ctx.connection.fetch.register({
    path: DELETE_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const body = await requestRecord(request)
      if (body === null || !hasExactKeys(body, ['workflowId']) || typeof body.workflowId !== 'string') {
        return failure(400, 'workflowId is required')
      }
      try {
        await ctx.workflowCatalog.remove(body.workflowId)
        return json({ ok: true })
      } catch (reason) {
        if (reason instanceof RangeError) return failure(400, 'invalid workflow id')
        if (isErrno(reason, 'ENOENT')) return failure(404, 'workflow not found')
        return failure(500, 'internal server error')
      }
    },
  }), `agentops-dag: ${DELETE_PATH}`)
}
