/**
 * Workflow run input resolution and Session launch routes.
 *
 * @module @agentops/dsh-dag/workflow-run
 */

import { randomUUID } from 'node:crypto'

import type SessionController from '@deepseek-ai/dsh-api-session-controller'
import { brandString } from '@deepseek-ai/dsh-brand'
import type {
  SessionCreateValue,
  SessionPromptRequest,
  SessionRequestId,
} from '@deepseek-ai/dsh-api-session-controller/types'

import { scanWorkflows } from './workflows.ts'
import type { WorkflowDefinition, WorkflowRunInputDefinition } from './types.ts'

/** Session operations required to launch one workflow run. */
export type WorkflowSessionController = Pick<SessionController, 'create' | 'prompt'>

/** Result of validating submitted values against a workflow's declarations. */
export type WorkflowRunInputResolution =
  | { ok: true; values: Readonly<Record<string, unknown>> }
  | { ok: false; reason: string }

/** Response returned by the workflow run hint route. */
export interface WorkflowRunHint {
  workflowId: string
  prompt: string
  reason: string
  inputs: readonly WorkflowRunInputDefinition[]
}

const RUN_HINT_REASON =
  'DSH 的 subagents 要求活跃父 Agent，工作流只能在会话里由 Agent 调用 dag_run 执行；页面只提供运行指令。'

/**
 * Merge defaults and validate submitted run values in declaration order.
 * @param workflow - workflow whose input declarations govern the run.
 * @param submitted - JSON request value supplied by the run form.
 * @returns ordered values when every submitted value is valid.
 */
export function resolveWorkflowRunInputs(
  workflow: Pick<WorkflowDefinition, 'inputs'>,
  submitted: unknown,
): WorkflowRunInputResolution {
  if (!isRecord(submitted)) return { ok: false, reason: 'inputs 必须是对象' }

  const declared = new Set(workflow.inputs.map(input => input.name))
  for (const name of Object.keys(submitted)) {
    if (!declared.has(name)) {
      return { ok: false, reason: `未知输入参数：${name}（${describeDeclaredInputs(workflow)}）` }
    }
  }

  const values: Record<string, unknown> = {}
  for (const input of workflow.inputs) {
    const value = Object.hasOwn(submitted, input.name)
      ? submitted[input.name]
      : input.default

    if (value === undefined) {
      if (input.required) {
        return { ok: false, reason: `缺少必填输入参数：${input.name}（${describeDeclaredInputs(workflow)}）` }
      }
      continue
    }
    const invalid = validateInput(input, value)
    if (invalid !== undefined) return { ok: false, reason: invalid }
    values[input.name] = value
  }
  return { ok: true, values }
}

/**
 * Build the fixed prompt that asks an Agent to invoke `dag_run`.
 * @param workflowId - workflow identity.
 * @param values - validated run values in declaration order.
 * @returns prompt text with no run-input section when the workflow declares none.
 */
export function buildWorkflowRunPrompt(
  workflowId: string,
  values: Readonly<Record<string, unknown>>,
): string {
  if (Object.keys(values).length === 0) {
    return `请用 dag_run 工具运行 AgentOps 工作流 ${workflowId}，执行完把每个节点的状态与产物摘要告诉我。`
  }
  return [
    `请用 dag_run 工具运行 AgentOps 工作流 ${workflowId}。`,
    '运行输入（JSON）：',
    JSON.stringify(values),
    '执行完把每个节点的状态与产物摘要告诉我。',
  ].join('\n')
}

/**
 * Build the page hint for one workflow, including declared inputs and defaults.
 * @param workflow - workflow selected in the catalog.
 * @returns stable prompt text, reason, and input declarations.
 */
export function createWorkflowRunHint(
  workflow: Pick<WorkflowDefinition, 'id' | 'inputs'>,
): WorkflowRunHint {
  return {
    workflowId: workflow.id,
    prompt: buildWorkflowRunPrompt(workflow.id, defaultsOf(workflow)),
    reason: RUN_HINT_REASON,
    inputs: workflow.inputs,
  }
}

/**
 * Create the POST run handler.
 * @param dir - workflow directory.
 * @param controller - Session controller, or undefined while the host service is unavailable.
 * @returns handler for one run request.
 */
export function createWorkflowRunHandler(
  dir: string,
  controller: WorkflowSessionController | undefined,
): (request: Request) => Promise<Response> {
  return async (request) => {
    let parsed: unknown
    try {
      parsed = await request.json()
    } catch {
      return jsonResponse({ ok: false, reason: '请求体不是合法 JSON' }, 400)
    }

    if (!isRecord(parsed)) return jsonResponse({ ok: false, reason: '请求体必须是对象' }, 400)
    const requestedId = parsed.workflowId
    const workflowId = typeof requestedId === 'string' ? requestedId.trim() : ''
    if (workflowId.length === 0) return jsonResponse({ ok: false, reason: '缺少 workflowId' }, 400)

    const summary = scanWorkflows(dir).entries.find(item => item.id === workflowId)
    if (summary === undefined) return jsonResponse({ ok: false, reason: `未知工作流：${workflowId}` }, 404)
    if (!summary.ok) {
      return jsonResponse({ ok: false, reason: `工作流校验失败：${summary.errors.join('；')}` }, 422)
    }

    const resolution = resolveWorkflowRunInputs(summary, parsed.inputs ?? {})
    if (!resolution.ok) return jsonResponse({ ok: false, reason: resolution.reason }, 422)
    if (controller === undefined) {
      return jsonResponse({ ok: false, reason: '宿主未提供 sessionController，无法创建会话' }, 503)
    }

    let created: SessionCreateValue
    try {
      created = await controller.create({ agentPreset: 'agentops' })
    } catch (reason) {
      return jsonResponse({ ok: false, reason: errorMessage(reason) }, 503)
    }

    try {
      const promptRequest: SessionPromptRequest = {
        requestId: brandString<SessionRequestId>(randomUUID()),
        sessionId: created.sessionId,
        content: [{ type: 'text', text: buildWorkflowRunPrompt(summary.id, resolution.values) }],
        mode: 'queue',
      }
      await controller.prompt(promptRequest, new AbortController().signal)
      return jsonResponse({ ok: true, sessionId: created.sessionId, workflowId: summary.id }, 200)
    } catch (reason) {
      return jsonResponse({
        ok: false,
        reason: `会话 ${created.sessionId} 已创建，但运行指令入队失败：${errorMessage(reason)}`,
        sessionId: created.sessionId,
      }, 503)
    }
  }
}

/**
 * Create the GET hint handler.
 * @param dir - workflow directory.
 * @returns handler that returns one workflow hint or 404.
 */
export function createWorkflowRunHintHandler(
  dir: string,
): (request: Request) => Promise<Response> {
  return (request) => {
    const id = new URL(request.url).searchParams.get('id')?.trim() ?? ''
    const summary = scanWorkflows(dir).entries.find(item => item.id === id)
    if (summary === undefined) return Promise.resolve(new Response('not found', { status: 404 }))
    return Promise.resolve(jsonResponse(createWorkflowRunHint(summary), 200))
  }
}

function defaultsOf(workflow: Pick<WorkflowDefinition, 'inputs'>): Record<string, unknown> {
  const values: Record<string, unknown> = {}
  for (const input of workflow.inputs) {
    if (input.default !== undefined) values[input.name] = input.default
  }
  return values
}

/**
 * Name every declared run input so a rejected call says what it should have sent.
 * @param workflow - workflow whose declarations are listed.
 * @returns one clause, or a no-input statement when the workflow declares none.
 */
export function describeDeclaredInputs(workflow: Pick<WorkflowDefinition, 'inputs'>): string {
  if (workflow.inputs.length === 0) return '本工作流没有顶层输入'
  return `本工作流输入：${workflow.inputs.map(input => `${input.name}${input.required ? '（必填）' : '（可选）'}`).join('、')}`
}

function validateInput(
  input: WorkflowRunInputDefinition,
  value: unknown,
): string | undefined {
  switch (input.type) {
    case 'string':
      if (typeof value !== 'string') return `输入参数 ${input.name} 必须是字符串`
      break
    case 'integer':
      if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
        return `输入参数 ${input.name} 必须是安全整数`
      }
      break
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return `输入参数 ${input.name} 必须是有限数字`
      }
      break
    case 'boolean':
      if (typeof value !== 'boolean') return `输入参数 ${input.name} 必须是布尔值`
      break
    case 'array':
      if (!Array.isArray(value) || !value.every(isJsonValue)) {
        return `输入参数 ${input.name} 必须是 JSON 数组`
      }
      break
  }

  if (input.required && typeof value === 'string' && value.trim().length === 0) {
    return `必填输入参数不能为空：${input.name}`
  }
  return undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isJsonValue(value: unknown): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index) || !isJsonValue(value[index])) return false
    }
    return true
  }
  if (!isRecord(value)) return false
  const prototype = Reflect.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return false
  return Object.values(value).every(isJsonValue)
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
