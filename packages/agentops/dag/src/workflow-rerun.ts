/**
 * Session launch route for rerunning one persisted workflow node.
 *
 * The route validates the persisted run and current workflow before creating a
 * Session. It only reports that the `dag_rerun` instruction was queued; node
 * execution and history updates happen inside the Agent turn.
 *
 * @module @agentops/dsh-dag/workflow-rerun
 */

import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import { brandString } from '@deepseek-ai/dsh-brand'
import type {
  SessionCreateValue,
  SessionPromptRequest,
  SessionRequestId,
} from '@deepseek-ai/dsh-api-session-controller/types'

import { parseWorkflowYaml } from './load.ts'
import type { SqliteRunStore } from './run-store.ts'
import type { WorkflowDefinition } from './types.ts'
import { validateWorkflow } from './validate.ts'
import type { WorkflowSessionController } from './workflow-run.ts'
import { resolveWorkflowRunInputs } from './workflow-run.ts'
import { scanWorkflows } from './workflows.ts'

/** Stable failures returned by the workflow rerun route. */
export type WorkflowRerunErrorCode =
  | 'invalid_request'
  | 'unknown_run'
  | 'workflow_mismatch'
  | 'node_missing'
  | 'run_running'
  | 'workflow_invalid'
  | 'invalid_inputs'
  | 'session_unavailable'
  | 'internal_error'

interface WorkflowRerunRequest {
  runId: string
  workflowId: string
  nodeId: string
  onlyNode: boolean
  inputs: Record<string, unknown>
}

interface WorkflowRerunErrorBody {
  error: {
    code: WorkflowRerunErrorCode
    message: string
    issues?: readonly string[]
  }
  sessionId?: string
}

/** Supplies the Session controller when the host service is available. */
export type WorkflowSessionControllerProvider = () => WorkflowSessionController | undefined

/**
 * Build the fixed prompt that asks an Agent to invoke `dag_rerun`.
 * @param workflowId - workflow identity.
 * @param runId - persisted run identity.
 * @param nodeId - node to execute again.
 * @param onlyNode - whether downstream results should be preserved.
 * @param values - validated run inputs in declaration order.
 * @returns prompt text carrying every rerun parameter.
 */
export function buildWorkflowRerunPrompt(
  workflowId: string,
  runId: string,
  nodeId: string,
  onlyNode: boolean,
  values: Readonly<Record<string, unknown>>,
): string {
  return [
    `请用 dag_rerun 工具重跑 AgentOps 工作流 ${workflowId} 的运行 ${runId} 中的节点 ${nodeId}。`,
    `onlyNode=${String(onlyNode)}`,
    '运行输入（JSON）：',
    JSON.stringify(values),
    '执行完把每个节点的状态与产物摘要告诉我。',
  ].join('\n')
}

/**
 * Create the POST workflow rerun handler.
 * @param dir - workflow directory.
 * @param store - run persistence used for read-only validation.
 * @param controller - provider for the Session controller.
 * @returns handler that validates and queues one rerun instruction.
 */
export function createWorkflowRerunHandler(
  dir: string,
  store: Pick<SqliteRunStore, 'loadRecord'>,
  controller: WorkflowSessionControllerProvider,
): (request: Request) => Promise<Response> {
  return async (request) => {
    let body: unknown
    try {
      body = await request.json()
    } catch {
      return rerunError(400, 'invalid_request', '请求体不是合法 JSON')
    }

    const parsed = parseRequest(body)
    if (!parsed.ok) return rerunError(400, 'invalid_request', parsed.reason)

    try {
      const record = store.loadRecord(parsed.value.runId)
      if (record === null) {
        return rerunError(404, 'unknown_run', `未知运行：${parsed.value.runId}`)
      }
      if (record.workflowId !== parsed.value.workflowId) {
        return rerunError(
          409,
          'workflow_mismatch',
          `运行记录 workflowId ${record.workflowId} 与请求的 workflowId ${parsed.value.workflowId} 不匹配`,
        )
      }

      const summary = scanWorkflows(dir).entries.find(entry => entry.id === parsed.value.workflowId)
      if (summary === undefined) {
        return rerunError(422, 'workflow_invalid', `工作流定义不存在：${parsed.value.workflowId}`)
      }
      if (!summary.ok) {
        return rerunError(422, 'workflow_invalid', '工作流定义无效', summary.errors)
      }

      let workflow: WorkflowDefinition
      try {
        workflow = parseWorkflowYaml(readFileSync(join(dir, summary.file), 'utf8'))
      } catch (reason) {
        return rerunError(422, 'workflow_invalid', '工作流定义无效', [errorMessage(reason)])
      }
      const validation = validateWorkflow(workflow)
      if (!validation.ok) {
        return rerunError(422, 'workflow_invalid', '工作流定义无效', validation.errors)
      }
      if (!workflow.nodes.some(node => node.id === parsed.value.nodeId)) {
        return rerunError(404, 'node_missing', `工作流不包含节点：${parsed.value.nodeId}`)
      }
      if (record.state.status === 'running') {
        return rerunError(409, 'run_running', `运行 ${parsed.value.runId} 仍在执行，不能重跑节点`)
      }

      const resolution = resolveWorkflowRunInputs(workflow, parsed.value.inputs)
      if (!resolution.ok) return rerunError(422, 'invalid_inputs', resolution.reason)

      let sessionController: WorkflowSessionController | undefined
      try {
        sessionController = controller()
      } catch (reason) {
        return rerunError(503, 'session_unavailable', errorMessage(reason))
      }
      if (sessionController === undefined) {
        return rerunError(503, 'session_unavailable', '宿主未提供 sessionController，无法创建会话')
      }

      let created: SessionCreateValue
      try {
        created = await sessionController.create({ agentPreset: 'agentops' })
      } catch (reason) {
        return rerunError(503, 'session_unavailable', errorMessage(reason))
      }

      try {
        const promptRequest: SessionPromptRequest = {
          requestId: brandString<SessionRequestId>(randomUUID()),
          sessionId: created.sessionId,
          content: [{
            type: 'text',
            text: buildWorkflowRerunPrompt(
              parsed.value.workflowId,
              parsed.value.runId,
              parsed.value.nodeId,
              parsed.value.onlyNode,
              resolution.values,
            ),
          }],
          mode: 'queue',
        }
        await sessionController.prompt(promptRequest, new AbortController().signal)
      } catch (reason) {
        return rerunError(
          503,
          'session_unavailable',
          `会话 ${created.sessionId} 已创建，但重跑指令入队失败：${errorMessage(reason)}`,
          undefined,
          created.sessionId,
        )
      }

      return jsonResponse({
        ok: true,
        sessionId: created.sessionId,
        runId: parsed.value.runId,
        workflowId: parsed.value.workflowId,
        nodeId: parsed.value.nodeId,
        onlyNode: parsed.value.onlyNode,
      }, 200)
    } catch {
      return rerunError(500, 'internal_error', '重跑请求处理失败')
    }
  }
}

/**
 * Register the rerun route independently of current controller availability.
 * @param ctx - context carrying Connection.
 * @param dir - workflow directory.
 * @param store - run persistence used for validation.
 * @param controller - provider for the Session controller.
 */
export function registerWorkflowRerunRoute(
  ctx: Context,
  dir: string,
  store: Pick<SqliteRunStore, 'loadRecord'>,
  controller: WorkflowSessionControllerProvider,
): void {
  const rerun = createWorkflowRerunHandler(dir, store, controller)
  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/agentops/workflow-rerun',
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: rerun,
  }), 'agentops-dag: /api/agentops/workflow-rerun')
}

function parseRequest(body: unknown): { ok: true; value: WorkflowRerunRequest } | { ok: false; reason: string } {
  if (!isRecord(body)) return { ok: false, reason: '请求体必须是对象' }
  const allowed = new Set(['runId', 'workflowId', 'nodeId', 'onlyNode', 'inputs'])
  for (const key of Object.keys(body)) {
    if (!allowed.has(key)) return { ok: false, reason: `未知请求字段：${key}` }
  }

  const runId = typeof body.runId === 'string' ? body.runId.trim() : ''
  const workflowId = typeof body.workflowId === 'string' ? body.workflowId.trim() : ''
  const nodeId = typeof body.nodeId === 'string' ? body.nodeId.trim() : ''
  if (runId.length === 0) return { ok: false, reason: '缺少 runId' }
  if (workflowId.length === 0) return { ok: false, reason: '缺少 workflowId' }
  if (nodeId.length === 0) return { ok: false, reason: '缺少 nodeId' }
  if (typeof body.onlyNode !== 'boolean') return { ok: false, reason: 'onlyNode 必须是布尔值' }
  if (!isRecord(body.inputs)) return { ok: false, reason: 'inputs 必须是对象' }

  return {
    ok: true,
    value: {
      runId,
      workflowId,
      nodeId,
      onlyNode: body.onlyNode,
      inputs: body.inputs,
    },
  }
}

function rerunError(
  status: number,
  code: WorkflowRerunErrorCode,
  message: string,
  issues?: readonly string[],
  sessionId?: string,
): Response {
  const body: WorkflowRerunErrorBody = {
    error: {
      code,
      message,
      ...(issues === undefined ? {} : { issues }),
    },
    ...(sessionId === undefined ? {} : { sessionId }),
  }
  return jsonResponse(body, status)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}
