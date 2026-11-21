/**
 * Launch a real DSH Session for an admitted task.
 *
 * The task database remains the delivery source of truth. This module only
 * bridges the `execute` command to DSH Session creation and prompt delivery; the
 * Session id is stored as an opaque weak pointer in `task_runs`.
 *
 * @module @agentops/dsh-task/execution
 */

import { randomUUID } from 'node:crypto'

import type {
  SessionCreateRequest,
  SessionCreateValue,
  SessionPromptRequest,
  SessionRequestId,
} from '@deepseek-ai/dsh-api-session-controller/types'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { brandString } from '@deepseek-ai/dsh-brand'

import { assertAgentPresetCapable, selectAgentForTask } from './agent-dispatch.ts'
import { setTaskToolExecutionContext, clearTaskToolExecutionContext } from './execution-context.ts'
import type { Actor, TaskExecutionContext, TaskRecord, TaskService } from './service.ts'
import { TaskServiceError } from './service.ts'

/** Session operations required to launch one task execution. */
export interface TaskSessionController {
  create(request: SessionCreateRequest): Promise<SessionCreateValue>
  prompt(request: SessionPromptRequest, signal: AbortSignal): Promise<unknown>
}

/** Optional execution permissions applied after a task Session is created. */
export interface TaskPermissionController {
  set(session: unknown, name: string): void
}

/** Host authority that can resolve the just-created live Agent. */
export interface TaskAgentRegistry {
  get(sessionId: SessionId): unknown
}

type SessionWorkspaceId = NonNullable<SessionCreateRequest['workspaceId']>

/** Body accepted by the task execution launch route. */
export interface TaskExecutionLaunchBody {
  readonly task_id: string
  readonly if_version: number
  readonly role?: 'main_execution' | 'validation' | 'discussion'
  readonly idempotency_key?: string
  readonly agent_preset?: string
}

/** Successful launch response. */
export interface TaskExecutionLaunchResult {
  readonly ok: true
  readonly sessionId: string
  readonly run: import('./service.ts').ExecutionRunRecord
  readonly execution: {
    readonly projectId: string
    readonly workspaceId: string
    readonly workspaceSource: 'workspace_id' | 'local_path'
    readonly scopeId: string
    readonly leaseId: string
    readonly agentPreset: string
    readonly executionBackend: 'dsh_native' | 'codex' | 'claude_code' | 'auto'
  }
}

const USER_ACTOR: Actor = { type: 'user', name: 'owner' }

/**
 * Choose a preset for a task type when the caller does not override it.
 * @param task - admitted task.
 * @returns the dispatch decision.
 */
export function presetForTask(
  task: Pick<TaskRecord, 'taskType' | 'riskLevel'>,
): ReturnType<typeof selectAgentForTask> {
  return selectAgentForTask(task)
}

/**
 * Build the self-contained execution prompt. The Session cannot see the task
 * center UI, so the prompt carries the task id, version, session id and the
 * required completion protocol.
 * @param task - task being executed.
 * @param sessionId - newly created Session id.
 * @param context - project workspace and execution scope.
 * @param agentPreset - selected Agent preset.
 * @param leaseId - lease that authorizes this execution.
 * @returns prompt text.
 */
export function buildTaskExecutionPrompt(
  task: TaskRecord,
  sessionId: string,
  context: TaskExecutionContext,
  agentPreset: string,
  leaseId: string,
): string {
  return [
    '你正在执行 AgentOps 任务中心派发的正式任务。',
    `task_id: ${task.taskId}`,
    `task_version: ${task.version}`,
    `session_id: ${sessionId}`,
    `project_id: ${context.projectId}`,
    `workspace_id: ${context.workspaceId}`,
    `workspace_source: ${context.workspaceSource}`,
    `execution_scope_id: ${context.scopeId}`,
    `lease_id: ${leaseId}`,
    `agent_preset: ${agentPreset}`,
    `execution_backend: ${context.executionBackend}`,
    `标题: ${task.title}`,
    `描述: ${task.description}`,
    `类型: ${task.taskType}`,
    `风险: ${task.riskLevel}`,
    '',
    '执行要求：',
    '1. 只能在服务端注入的当前 Project Workspace 内工作，不要跨项目读写。',
    '2. 先调用 task_get 读取任务、评论、验收标准和当前版本；任务描述与验收标准以 task_get 返回为准。',
    '3. 严格按任务描述和验收标准完成工作，不要自行关闭任务；涉及 UI 时页面代码位于 packages/agentops/client/src/client，必须先定位对应组件再修改。',
    '3.1 执行后端：auto 时优先选择当前可用的 Codex/Claude Code；codex 时调用 subagent_codex；claude_code 时调用 subagent_claude_code；dsh_native 时直接在当前 Session 执行。外部后端返回结果后，仍由你完成验收、提交报告和任务状态推进。',
    '4. decision_search 必须使用当前项目上下文；不要传入其他 projectId。',
    '5. 完成后调用 task_report_submit，提交 Markdown 报告、产物和自检结果，并传 sessionId。',
    '6. 如执行失败，调用 task_advance 将任务推进到 failed；如受外部条件阻塞，推进到 blocked。',
    '7. 任何状态写入都必须带最新 expectedVersion；版本冲突时重新读取任务后最多重试一次。',
  ].join('\n')
}

/**
 * Create the exact browser route handler for launching task execution.
 * @param service - task write authority.
 * @param controller - DSH Session controller, or undefined when unavailable.
 * @param permissions - optional controller applying execution permissions to the new Session.
 * @param agents - optional registry resolving the just-created live Agent.
 * @param resolveExecutionBackend - optional resolver picking the execution backend for a preset.
 * @returns fetch handler.
 */
export function createTaskExecutionHandler(
  service: TaskService,
  controller: TaskSessionController | undefined,
  permissions?: TaskPermissionController,
  agents?: TaskAgentRegistry,
  resolveExecutionBackend?: ((agentPreset: string) => 'dsh_native' | 'codex' | 'claude_code' | 'auto'),
): (request: Request) => Promise<Response> {
  return async (request) => {
    if (controller === undefined) {
      return jsonResponse({ ok: false, code: 'session_unavailable', message: '宿主未提供 sessionController' }, 503)
    }

    let body: TaskExecutionLaunchBody
    try {
      body = await parseBody(request)
    } catch (error) {
      return jsonResponse({ ok: false, code: 'invalid_request', message: errorMessage(error) }, 400)
    }

    let task = service.getTask(body.task_id).task
    let launchVersion = body.if_version

    try {
      const baseExecutionContext = service.getTaskExecutionContext(task.taskId)
      const dispatch = presetForTask(task)
      if (body.agent_preset !== undefined) assertAgentPresetCapable(body.agent_preset, task)

      if (task.status === 'backlog') {
        task = service.advance({
          taskId: task.taskId,
          to: 'in_progress',
          ifVersion: launchVersion,
          actor: USER_ACTOR,
          comment: '任务中心开始执行',
        })
        launchVersion = task.version
      }

      const agentPreset = body.agent_preset ?? dispatch.agentPreset
      const executionBackend = resolveExecutionBackend?.(agentPreset) ?? baseExecutionContext.executionBackend
      const executionContext: TaskExecutionContext = { ...baseExecutionContext, executionBackend }
      const createRequest: SessionCreateRequest = {
        agentPreset,
        ...(executionContext.workspaceSource === 'workspace_id'
          ? { workspaceId: executionContext.workspaceId as SessionWorkspaceId }
          : { cwd: executionContext.localPath ?? executionContext.workspaceId }),
      }
      let created: SessionCreateValue
      try {
        created = await controller.create(createRequest)
      } catch (error) {
        return jsonResponse({ ok: false, code: 'session_create_failed', message: errorMessage(error) }, 503)
      }

      if (permissions !== undefined && agents !== undefined) {
        try {
          const agent = agents.get(created.sessionId)
          if (agent === undefined) throw new Error(`live Agent ${created.sessionId} is unavailable after Session creation`)
          permissions.set((agent as { session: unknown }).session, 'danger-full-access')
        } catch (error) {
          return jsonResponse({ ok: false, code: 'permission_setup_failed', message: errorMessage(error) }, 503)
        }
      }

      let run: import('./service.ts').ExecutionRunRecord
      try {
        run = service.execute({
          taskId: task.taskId,
          ifVersion: launchVersion,
          actor: USER_ACTOR,
          role: body.role ?? 'main_execution',
          sessionId: created.sessionId,
          ...(body.idempotency_key === undefined ? {} : { idempotencyKey: body.idempotency_key }),
        })
      } catch (error) {
        clearTaskToolExecutionContext(created.sessionId)
        return errorResponse(error)
      }

      const sessionId = String(created.sessionId)
      setTaskToolExecutionContext({
        sessionId,
        taskId: task.taskId,
        projectId: executionContext.projectId,
        workspaceId: executionContext.workspaceId,
        workspaceSource: executionContext.workspaceSource,
        scopeId: executionContext.scopeId,
        leaseId: run.lease.leaseId,
        leaseToken: run.lease.leaseToken,
        agentPreset,
      })

      try {
        service.startRun({ taskId: task.taskId, linkId: run.linkId, actor: USER_ACTOR })
        const promptRequest: SessionPromptRequest = {
          requestId: brandString<SessionRequestId>(randomUUID()),
          sessionId: created.sessionId,
          content: [{ type: 'text', text: buildTaskExecutionPrompt(task, sessionId, executionContext, agentPreset, run.lease.leaseId) }],
          mode: 'queue',
        }
        await controller.prompt(promptRequest, new AbortController().signal)
      } catch (error) {
        clearTaskToolExecutionContext(sessionId)
        service.finishRun({ taskId: task.taskId, linkId: run.linkId, status: 'failed', actor: USER_ACTOR })
        return jsonResponse({
          ok: false,
          code: 'prompt_failed',
          message: `Session ${sessionId} 已创建，但执行指令入队失败：${errorMessage(error)}`,
          sessionId,
        }, 503)
      }

      const result: TaskExecutionLaunchResult = {
        ok: true,
        sessionId,
        run,
        execution: {
          projectId: executionContext.projectId,
          workspaceId: executionContext.workspaceId,
          workspaceSource: executionContext.workspaceSource,
          scopeId: executionContext.scopeId,
          leaseId: run.lease.leaseId,
          agentPreset,
          executionBackend: executionContext.executionBackend,
        },
      }
      return jsonResponse(result, 200)
    } catch (error) {
      return errorResponse(error)
    }
  }
}

async function parseBody(request: Request): Promise<TaskExecutionLaunchBody> {
  const raw: unknown = await request.json()
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('body must be a JSON object')
  }
  const value = raw as Record<string, unknown>
  if (typeof value.task_id !== 'string' || value.task_id.trim() === '') throw new Error('task_id is required')
  if (typeof value.if_version !== 'number' || !Number.isInteger(value.if_version) || value.if_version < 0) {
    throw new Error('if_version must be a non-negative integer')
  }
  const role = value.role
  if (role !== undefined && (typeof role !== 'string' || !['main_execution', 'validation', 'discussion'].includes(role))) {
    throw new Error('invalid role')
  }
  const roleValue = role === undefined ? undefined : (role as TaskExecutionLaunchBody['role'])
  const idempotencyValue = typeof value.idempotency_key === 'string' && value.idempotency_key.trim() !== ''
    ? value.idempotency_key.trim()
    : undefined
  const presetValue = typeof value.agent_preset === 'string' && value.agent_preset.trim() !== ''
    ? value.agent_preset.trim()
    : undefined
  return {
    task_id: value.task_id.trim(),
    if_version: value.if_version,
    ...(roleValue === undefined ? {} : { role: roleValue }),
    ...(idempotencyValue === undefined ? {} : { idempotency_key: idempotencyValue }),
    ...(presetValue === undefined ? {} : { agent_preset: presetValue }),
  }
}

function errorResponse(error: unknown): Response {
  if (error instanceof TaskServiceError) {
    return jsonResponse({ ok: false, code: error.code, message: error.message, details: error.details }, error.httpStatus)
  }
  return jsonResponse({ ok: false, code: 'internal_error', message: errorMessage(error) }, 500)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}
