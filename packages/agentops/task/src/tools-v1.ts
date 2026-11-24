/**
 * Model-facing task tools backed by `TaskService`.
 *
 * Every tool is a thin wrapper: parse arguments, call one service command with
 * `actor = agent`, and return a structured result. A `TaskServiceError` becomes
 * `{ ok: false, code, message }` so the model can distinguish "refused" from
 * "written"; nothing here writes SQL or mutates status directly.
 *
 * @module @agentops/dsh-task/tools-v1
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

import type { Actor, DecisionEvidenceInput, TaskRecord } from './service.ts'
import { getTaskToolExecutionContext } from './execution-context.ts'
import { TaskService, TaskServiceError } from './service.ts'

/** The actor every tool call uses; agents can never satisfy `requires_user`. */
export const AGENT_ACTOR: Actor = { type: 'agent', id: 'agentops-tool' }

/**
 * Convert a service failure into a tool result the model can act on.
 * @param error - thrown value.
 * @returns structured refusal.
 */
function refusal(error: unknown): { ok: false; code: string; message: string } {
  if (error instanceof TaskServiceError) {
    return { ok: false, code: error.code, message: error.message }
  }
  return { ok: false, code: 'internal_error', message: error instanceof Error ? error.message : String(error) }
}

function contextMismatch(message: string): { ok: false; code: string; message: string } {
  return { ok: false, code: 'project_context_mismatch', message }
}

/** Convert model evidence rows into service inputs. */
function decisionEvidenceInputs(
  rows: readonly { readonly kind: string; readonly ref: string; readonly contentHash?: string }[] | undefined,
): DecisionEvidenceInput[] | undefined {
  return rows?.map(row => ({
    kind: row.kind as DecisionEvidenceInput['kind'],
    ref: row.ref,
    ...(row.contentHash === undefined ? {} : { contentHash: row.contentHash }),
  }))
}

/**
 * Build the service-backed task tools.
 * @param service - the task write path.
 * @returns tool definitions for the AgentOps preset.
 */
export function createServiceTaskTools(service: TaskService): readonly ToolDefinition[] {
  const list = defineTool({
    name: 'task_list',
    description: 'List tasks with optional status/project filters. Read-only.',
    parameters: {
      status: { type: 'string', description: 'Filter by lifecycle status.' },
      projectId: { type: 'string', description: 'Filter by project.' },
      limit: { type: 'integer', description: 'Max rows, default 50.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          tasks: { type: 'array', required: true, items: { type: 'json' } },
          total: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => {
        const rows = value.tasks as { taskId: string; status: string; title: string; version: number }[]
        return [{
          type: 'text',
          text: rows.length === 0
            ? 'No tasks matched.'
            : rows.map(row => `- ${row.taskId} [${row.status}] ${row.title} (v${row.version})`).join('\n'),
        }]
      },
    },
    execute(args) {
      const all = readTasks(service).filter(task =>
        (args.status === undefined || task.status === args.status)
        && (args.projectId === undefined || task.projectId === args.projectId))
      const limit = Math.min(Math.max(args.limit ?? 50, 1), 200)
      const tasks = all.slice(0, limit)
      return Promise.resolve({ tasks: tasks.map(task => ({ ...task })), total: all.length })
    },
  })

  const get = defineTool({
    name: 'task_get',
    description: 'Read one task with allowed transitions, executions and recent events. Read-only.',
    parameters: { id: { type: 'string', required: true } },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          task: { type: 'json' },
          allowed: { type: 'array', items: { type: 'json' } },
          runs: { type: 'array', items: { type: 'json' } },
          comments: { type: 'array', items: { type: 'json' } },
          criteria: { type: 'array', items: { type: 'json' } },
          reports: { type: 'array', items: { type: 'json' } },
          code: { type: 'string' },
          message: { type: 'string' },
        },
      },
      render: (_args, value) => {
        if (!value.ok) return [{ type: 'text', text: `Refused (${String(value.code)}): ${String(value.message)}` }]
        const task = value.task as { taskId: string; status: string; title: string; description: string; version: number }
        const allowed = value.allowed as { to: string; requiresUser: boolean }[]
        const comments = value.comments as { body: string; commentType: string; authorName: string | null }[]
        const criteria = value.criteria as { description: string; status: string }[]
        const reports = value.reports as { content: string; status: string }[]
        const lines = [
          `Task ${task.taskId} [${task.status}] ${task.title} v${task.version}`,
          `Description: ${task.description || '(none)'}`,
          `Allowed: ${allowed.length === 0 ? 'none (terminal)' : allowed.map(item => item.to).join(', ')}`,
          `Acceptance criteria: ${criteria.length === 0 ? '(none)' : ''}`,
          ...criteria.map(item => `- [${item.status}] ${item.description}`),
          `Comments: ${comments.length === 0 ? '(none)' : ''}`,
          ...comments.map(item => `- ${item.commentType} by ${item.authorName ?? 'unknown'}: ${item.body}`),
          `Reports: ${reports.length === 0 ? '(none)' : ''}`,
          ...reports.map(item => `- [${item.status}] ${item.content.slice(0, 500)}`),
        ]
        return [{ type: 'text', text: lines.filter((line, index) => line !== '' || index === 0).join('\n') }]
      },
    },
    execute(args) {
      try {
        const detail = service.getTask(args.id)
        return Promise.resolve({
          ok: true,
          task: { ...detail.task },
          allowed: detail.allowed.map(item => ({ ...item })),
          runs: service.listRuns(args.id).map(run => ({ ...run })),
          comments: detail.comments.map(item => ({ ...item })),
          criteria: detail.criteria.map(item => ({ ...item })),
          reports: JSON.parse(JSON.stringify(detail.reports)) as JsonValue[],
        })
      } catch (error) {
        return Promise.resolve(refusal(error))
      }
    },
  })

  const candidateCreate = defineTool({
    name: 'candidate_create',
    description: 'Capture a Candidate for analysis. This does not create a task; only a human approval gate does.',
    parameters: {
      projectId: { type: 'string', required: true },
      title: { type: 'string', required: true },
      description: { type: 'string' },
      riskLevel: { type: 'string', description: 'low | medium | high' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          candidate: { type: 'json' },
          code: { type: 'string' },
          message: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.ok
          ? `Captured ${(value.candidate as { candidateId: string }).candidateId}.`
          : `Refused (${String(value.code)}): ${String(value.message)}`,
      }],
    },
    execute(args) {
      try {
        const candidate = service.captureCandidate({
          projectId: args.projectId,
          title: args.title,
          actor: AGENT_ACTOR,
          ...(args.description === undefined ? {} : { description: args.description }),
          ...(args.riskLevel === undefined ? {} : { riskLevel: args.riskLevel as 'medium' }),
        })
        return Promise.resolve({
          ok: true,
          candidate: {
            candidateId: candidate.candidateId,
            projectId: candidate.projectId,
            title: candidate.title,
            status: candidate.status,
            version: candidate.version,
          },
        })
      } catch (error) {
        return Promise.resolve(refusal(error))
      }
    },
  })

  const advance = defineTool({
    name: 'task_advance',
    description:
      'Advance one allowed edge. Edges marked requires_user are refused: ask the user instead. '
      + 'Pass the version you read so a concurrent change is rejected.',
    parameters: {
      id: { type: 'string', required: true },
      to: { type: 'string', required: true },
      expectedVersion: { type: 'integer', required: true },
      comment: { type: 'string' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          task: { type: 'json' },
          code: { type: 'string' },
          message: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.ok
          ? `Advanced to ${(value.task as { status: string }).status}.`
          : `Refused (${String(value.code)}): ${String(value.message)}`,
      }],
    },
    execute(args) {
      try {
        const task = service.advance({
          taskId: args.id,
          to: args.to,
          ifVersion: args.expectedVersion,
          actor: AGENT_ACTOR,
          ...(args.comment === undefined ? {} : { comment: args.comment }),
        })
        return Promise.resolve({ ok: true, task: { ...task } })
      } catch (error) {
        return Promise.resolve(refusal(error))
      }
    },
  })

  const claim = defineTool({
    name: 'task_claim',
    description: 'Bind a task to the calling thread so follow-ups return to this worker.',
    parameters: {
      id: { type: 'string', required: true },
      threadId: { type: 'string', required: true },
      expectedVersion: { type: 'integer', required: true },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          task: { type: 'json' },
          code: { type: 'string' },
          message: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.ok ? 'Task claimed.' : `Refused (${String(value.code)}): ${String(value.message)}`,
      }],
    },
    execute(args) {
      try {
        const task = service.claim({
          taskId: args.id,
          threadId: args.threadId,
          ifVersion: args.expectedVersion,
          actor: AGENT_ACTOR,
        })
        return Promise.resolve({ ok: true, task: { ...task } })
      } catch (error) {
        return Promise.resolve(refusal(error))
      }
    },
  })

  const comment = defineTool({
    name: 'task_comment',
    description: 'Post a discussion or report comment on a task.',
    parameters: {
      id: { type: 'string', required: true },
      body: { type: 'string', required: true },
      commentType: { type: 'string', description: 'discussion | report' },
      expectedVersion: { type: 'integer', required: true },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          comment: { type: 'json' },
          code: { type: 'string' },
          message: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.ok ? 'Comment stored.' : `Refused (${String(value.code)}): ${String(value.message)}`,
      }],
    },
    execute(args) {
      try {
        const stored = service.addComment({
          taskId: args.id,
          body: args.body,
          ifVersion: args.expectedVersion,
          actor: AGENT_ACTOR,
          ...(args.commentType === undefined ? {} : { commentType: args.commentType as 'discussion' }),
        })
        return Promise.resolve({ ok: true, comment: { ...stored } })
      } catch (error) {
        return Promise.resolve(refusal(error))
      }
    },
  })

  const validate = defineTool({
    name: 'task_validate',
    description: 'Record one acceptance criterion as passed or failed.',
    parameters: {
      id: { type: 'string', required: true },
      criteriaId: { type: 'string', required: true },
      status: { type: 'string', required: true, description: 'passed | failed' },
      expectedVersion: { type: 'integer', required: true },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          criteria: { type: 'json' },
          code: { type: 'string' },
          message: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.ok ? 'Criterion recorded.' : `Refused (${String(value.code)}): ${String(value.message)}`,
      }],
    },
    execute(args) {
      try {
        if (args.status !== 'passed' && args.status !== 'failed') {
          return Promise.resolve({ ok: false, code: 'invalid_request', message: 'status must be passed or failed' })
        }
        const criteria = service.setCriteriaStatus({
          taskId: args.id,
          criteriaId: args.criteriaId,
          status: args.status,
          ifVersion: args.expectedVersion,
          actor: AGENT_ACTOR,
        })
        return Promise.resolve({ ok: true, criteria: { ...criteria } })
      } catch (error) {
        return Promise.resolve(refusal(error))
      }
    },
  })

  const report = defineTool({
    name: 'task_report_submit',
    description: 'Submit a formal task report with an acceptance self-check.',
    parameters: {
      id: { type: 'string', required: true },
      content: { type: 'string', required: true },
      expectedVersion: { type: 'integer', required: true },
      sessionId: { type: 'string' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          reportId: { type: 'string' },
          code: { type: 'string' },
          message: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.ok ? 'Report submitted.' : `Refused (${String(value.code)}): ${String(value.message)}`,
      }],
    },
    execute(args) {
      try {
        const stored = service.submitReport({
          taskId: args.id,
          content: args.content,
          ifVersion: args.expectedVersion,
          actor: AGENT_ACTOR,
          ...(args.sessionId === undefined ? {} : { sessionId: args.sessionId }),
        })
        return Promise.resolve({ ok: true, reportId: stored.reportId })
      } catch (error) {
        return Promise.resolve(refusal(error))
      }
    },
  })

  const rollback = defineTool({
    name: 'task_rollback',
    description:
      'Return a task to an earlier stage with a reason. A user-confirmed target is refused and must be requested from the user.',
    parameters: {
      id: { type: 'string', required: true },
      targetStatus: { type: 'string', required: true },
      reason: { type: 'string', required: true },
      expectedVersion: { type: 'integer', required: true },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          task: { type: 'json' },
          code: { type: 'string' },
          message: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.ok ? 'Rolled back.' : `Refused (${String(value.code)}): ${String(value.message)}`,
      }],
    },
    execute(args) {
      try {
        const task = service.rollback({
          taskId: args.id,
          targetStatus: args.targetStatus,
          reason: args.reason,
          ifVersion: args.expectedVersion,
          actor: AGENT_ACTOR,
        })
        return Promise.resolve({ ok: true, task: { ...task } })
      } catch (error) {
        return Promise.resolve(refusal(error))
      }
    },
  })

  const ideaCapture = defineTool({
    name: 'idea_capture',
    description:
      'Capture one inbox record from a conversation, bot message or connector. Bot and agent captures stay in the '
      + 'captured state until a user triages them.',
    parameters: {
      content: { type: 'string', required: true },
      channel: { type: 'string', description: 'manual | bot | agent | connector | agent_extract' },
      kind: { type: 'string', description: 'requirement | bug | doc | question | idea' },
      title: { type: 'string' },
      projectId: { type: 'string' },
      sourceSystem: { type: 'string' },
      sourceRef: { type: 'string' },
      contentHash: { type: 'string' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          idea: { type: 'json' },
          code: { type: 'string' },
          message: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.ok
          ? `Captured ${(value.idea as { ideaId: string }).ideaId} in captured.`
          : `Refused (${String(value.code)}): ${String(value.message)}`,
      }],
    },
    execute(args) {
      const channel = args.channel as 'manual' | 'bot' | 'agent' | 'connector' | 'agent_extract' | undefined
      const kind = args.kind as 'requirement' | 'bug' | 'doc' | 'question' | 'idea' | undefined
      try {
        const idea = service.captureIdea({
          channel: channel ?? 'agent',
          content: args.content,
          actor: AGENT_ACTOR,
          ...(kind === undefined ? {} : { kind }),
          ...(args.title === undefined ? {} : { title: args.title }),
          ...(args.projectId === undefined ? {} : { projectId: args.projectId }),
          ...(args.sourceSystem === undefined ? {} : { sourceSystem: args.sourceSystem }),
          ...(args.sourceRef === undefined ? {} : { sourceRef: args.sourceRef }),
          ...(args.contentHash === undefined ? {} : { contentHash: args.contentHash }),
        })
        return Promise.resolve({ ok: true, idea: { ...idea } })
      } catch (error) {
        return Promise.resolve(refusal(error))
      }
    },
  })

  const ideaList = defineTool({
    name: 'idea_list',
    description: 'List inbox records by status, channel or kind. Read-only.',
    parameters: {
      status: { type: 'string' },
      channel: { type: 'string' },
      kind: { type: 'string' },
      limit: { type: 'integer' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ideas: { type: 'array', required: true, items: { type: 'json' } },
          total: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: (value.ideas as unknown[]).length === 0
          ? 'No inbox records matched.'
          : (value.ideas as { ideaId: string; status: string }[]).map(idea => `- ${idea.ideaId} [${idea.status}]`).join('\n'),
      }],
    },
    execute(args) {
      const ideas = service.listIdeas({
        ...(args.status === undefined ? {} : { status: args.status }),
        ...(args.channel === undefined ? {} : { channel: args.channel }),
        ...(args.kind === undefined ? {} : { kind: args.kind }),
        ...(args.limit === undefined ? {} : { limit: args.limit }),
      })
      return Promise.resolve({ ideas: ideas.map(idea => ({ ...idea })), total: ideas.length })
    },
  })

  const ideaTriage = defineTool({
    name: 'idea_triage',
    description:
      'Classify, mark ready, ignore or archive one inbox record. Only the task_inbox role may mark ready, and bot or '
      + 'agent captures still require a user.',
    parameters: {
      ideaId: { type: 'string', required: true },
      action: { type: 'string', required: true, description: 'classify | ready | ignore | archive' },
      kind: { type: 'string' },
      projectId: { type: 'string' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          idea: { type: 'json' },
          code: { type: 'string' },
          message: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.ok
          ? `Inbox record is now ${(value.idea as { status: string }).status}.`
          : `Refused (${String(value.code)}): ${String(value.message)}`,
      }],
    },
    execute(args) {
      const action = args.action as 'classify' | 'ready' | 'ignore' | 'archive'
      const kind = args.kind as 'requirement' | 'bug' | 'doc' | 'question' | 'idea' | undefined
      try {
        const idea = service.triageIdea({
          ideaId: args.ideaId,
          action,
          actor: { type: 'agent', name: 'task_inbox' },
          ...(kind === undefined ? {} : { kind }),
          ...(args.projectId === undefined ? {} : { projectId: args.projectId }),
        })
        return Promise.resolve({ ok: true, idea: { ...idea } })
      } catch (error) {
        return Promise.resolve(refusal(error))
      }
    },
  })

  const execute = defineTool({
    name: 'task_execute',
    description:
      'Start one execution binding for a backlog or in_progress task. Pass an idempotency key so a retry returns the '
      + 'same run instead of starting another.',
    parameters: {
      id: { type: 'string', required: true },
      expectedVersion: { type: 'integer', required: true },
      role: { type: 'string', description: 'main_execution | validation | discussion' },
      idempotencyKey: { type: 'string' },
      sessionId: { type: 'string' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          run: { type: 'json' },
          code: { type: 'string' },
          message: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.ok
          ? `Run ${(value.run as { linkId: string }).linkId} started.`
          : `Refused (${String(value.code)}): ${String(value.message)}`,
      }],
    },
    execute(args) {
      const role = args.role as 'main_execution' | 'validation' | 'discussion' | undefined
      try {
        const run = service.execute({
          taskId: args.id,
          ifVersion: args.expectedVersion,
          actor: AGENT_ACTOR,
          ...(role === undefined ? {} : { role }),
          ...(args.idempotencyKey === undefined ? {} : { idempotencyKey: args.idempotencyKey }),
          ...(args.sessionId === undefined ? {} : { sessionId: args.sessionId }),
        })
        const { lease: _lease, ...runOnly } = run
        return Promise.resolve({ ok: true, run: { ...runOnly } })
      } catch (error) {
        return Promise.resolve(refusal(error))
      }
    },
  })

  const decisionPropose = defineTool({
    name: 'decision_propose',
    description:
      'Propose a durable project Decision for discussion. A proposal is not authority until a user implements it.',
    parameters: {
      projectId: { type: 'string', required: true },
      decisionKey: { type: 'string', required: true, description: 'Stable key used for authority uniqueness.' },
      title: { type: 'string', required: true },
      subjectType: {
        type: 'string',
        required: true,
        enum: ['project', 'task', 'module', 'service', 'api', 'process', 'data', 'security'],
      },
      subjectId: { type: 'string' },
      authorityScope: {
        type: 'string',
        required: true,
        enum: ['project', 'workspace', 'repository', 'branch', 'environment', 'task'],
      },
      authorityLevel: {
        type: 'string',
        required: true,
        enum: ['hard_constraint', 'policy', 'implementation', 'local_default'],
      },
      problem: { type: 'string', required: true },
      proposal: { type: 'string', required: true },
      rationale: { type: 'string', required: true },
      noteClass: {
        type: 'string',
        required: true,
        enum: ['feature', 'bug-fix', 'simplification', 'architecture', 'process', 'testing'],
      },
      decisionId: { type: 'string' },
      workspaceId: { type: 'string' },
      repositoryRef: { type: 'string' },
      relaxesDecisionId: { type: 'string' },
      relaxesEvidenceId: { type: 'string' },
      environment: { type: 'string' },
      branchKey: { type: 'string' },
      rolloutKey: { type: 'string' },
      tenantKey: { type: 'string' },
      regionKey: { type: 'string' },
      alternatives: { type: 'string' },
      acceptanceCriteria: { type: 'string' },
      predecessorId: { type: 'string' },
      supersedesId: { type: 'string' },
      sourceTaskId: { type: 'string' },
      sourceCandidateId: { type: 'string' },
      sourceRun: { type: 'string' },
      notePath: { type: 'string' },
      noteDate: { type: 'string' },
      contentHash: { type: 'string' },
      baseContentHash: { type: 'string' },
      evidence: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            kind: {
              type: 'string',
              required: true,
              enum: ['pull_request', 'commit', 'deployment', 'document', 'approval', 'test', 'manual'],
            },
            ref: { type: 'string', required: true },
            contentHash: { type: 'string' },
          },
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          decision: { type: 'json' },
          code: { type: 'string' },
          message: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.ok
          ? `Proposed ${(value.decision as { decisionId: string }).decisionId}.`
          : `Refused (${String(value.code)}): ${String(value.message)}`,
      }],
    },
    execute(args) {
      try {
        const evidence = decisionEvidenceInputs(args.evidence)
        const decision = service.decisionPropose({
          projectId: args.projectId,
          decisionKey: args.decisionKey,
          title: args.title,
          subjectType: args.subjectType,
          authorityScope: args.authorityScope,
          authorityLevel: args.authorityLevel,
          problem: args.problem,
          proposal: args.proposal,
          rationale: args.rationale,
          noteClass: args.noteClass,
          actor: AGENT_ACTOR,
          ...(args.decisionId === undefined ? {} : { decisionId: args.decisionId }),
          ...(args.workspaceId === undefined ? {} : { workspaceId: args.workspaceId }),
          ...(args.repositoryRef === undefined ? {} : { repositoryRef: args.repositoryRef }),
          ...(args.subjectId === undefined ? {} : { subjectId: args.subjectId }),
          ...(args.relaxesDecisionId === undefined ? {} : { relaxesDecisionId: args.relaxesDecisionId }),
          ...(args.relaxesEvidenceId === undefined ? {} : { relaxesEvidenceId: args.relaxesEvidenceId }),
          ...(args.environment === undefined ? {} : { environment: args.environment }),
          ...(args.branchKey === undefined ? {} : { branchKey: args.branchKey }),
          ...(args.rolloutKey === undefined ? {} : { rolloutKey: args.rolloutKey }),
          ...(args.tenantKey === undefined ? {} : { tenantKey: args.tenantKey }),
          ...(args.regionKey === undefined ? {} : { regionKey: args.regionKey }),
          ...(args.alternatives === undefined ? {} : { alternatives: args.alternatives }),
          ...(args.acceptanceCriteria === undefined ? {} : { acceptanceCriteria: args.acceptanceCriteria }),
          ...(args.predecessorId === undefined ? {} : { predecessorId: args.predecessorId }),
          ...(args.supersedesId === undefined ? {} : { supersedesId: args.supersedesId }),
          ...(args.sourceTaskId === undefined ? {} : { sourceTaskId: args.sourceTaskId }),
          ...(args.sourceCandidateId === undefined ? {} : { sourceCandidateId: args.sourceCandidateId }),
          ...(args.sourceRun === undefined ? {} : { sourceRun: args.sourceRun }),
          ...(args.notePath === undefined ? {} : { notePath: args.notePath }),
          ...(args.noteDate === undefined ? {} : { noteDate: args.noteDate }),
          ...(args.contentHash === undefined ? {} : { contentHash: args.contentHash }),
          ...(args.baseContentHash === undefined ? {} : { baseContentHash: args.baseContentHash }),
          ...(evidence === undefined ? {} : { evidence }),
        })
        return Promise.resolve({ ok: true, decision: { ...decision } })
      } catch (error) {
        return Promise.resolve(refusal(error))
      }
    },
  })

  const decisionRevise = defineTool({
    name: 'decision_revise',
    description: 'Revise a proposed Decision with an expected version. Implemented decisions are immutable.',
    parameters: {
      decisionId: { type: 'string', required: true },
      expectedVersion: { type: 'integer', required: true },
      workspaceId: { type: 'string' },
      repositoryRef: { type: 'string' },
      decisionKey: { type: 'string' },
      title: { type: 'string' },
      subjectType: {
        type: 'string',
        enum: ['project', 'task', 'module', 'service', 'api', 'process', 'data', 'security'],
      },
      subjectId: { type: 'string' },
      authorityScope: {
        type: 'string',
        enum: ['project', 'workspace', 'repository', 'branch', 'environment', 'task'],
      },
      authorityLevel: {
        type: 'string',
        enum: ['hard_constraint', 'policy', 'implementation', 'local_default'],
      },
      relaxesDecisionId: { type: 'string' },
      relaxesEvidenceId: { type: 'string' },
      environment: { type: 'string' },
      branchKey: { type: 'string' },
      rolloutKey: { type: 'string' },
      tenantKey: { type: 'string' },
      regionKey: { type: 'string' },
      problem: { type: 'string' },
      proposal: { type: 'string' },
      rationale: { type: 'string' },
      alternatives: { type: 'string' },
      acceptanceCriteria: { type: 'string' },
      predecessorId: { type: 'string' },
      supersedesId: { type: 'string' },
      sourceTaskId: { type: 'string' },
      sourceCandidateId: { type: 'string' },
      sourceRun: { type: 'string' },
      notePath: { type: 'string' },
      noteClass: {
        type: 'string',
        enum: ['feature', 'bug-fix', 'simplification', 'architecture', 'process', 'testing'],
      },
      noteDate: { type: 'string' },
      contentHash: { type: 'string' },
      baseContentHash: { type: 'string' },
      evidence: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            kind: {
              type: 'string',
              required: true,
              enum: ['pull_request', 'commit', 'deployment', 'document', 'approval', 'test', 'manual'],
            },
            ref: { type: 'string', required: true },
            contentHash: { type: 'string' },
          },
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          decision: { type: 'json' },
          code: { type: 'string' },
          message: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.ok
          ? `Revised ${(value.decision as { decisionId: string }).decisionId} to v${(value.decision as { version: number }).version}.`
          : `Refused (${String(value.code)}): ${String(value.message)}`,
      }],
    },
    execute(args) {
      try {
        const evidence = decisionEvidenceInputs(args.evidence)
        const decision = service.decisionRevise({
          decisionId: args.decisionId,
          ifVersion: args.expectedVersion,
          actor: AGENT_ACTOR,
          ...(args.workspaceId === undefined ? {} : { workspaceId: args.workspaceId }),
          ...(args.repositoryRef === undefined ? {} : { repositoryRef: args.repositoryRef }),
          ...(args.decisionKey === undefined ? {} : { decisionKey: args.decisionKey }),
          ...(args.title === undefined ? {} : { title: args.title }),
          ...(args.subjectType === undefined ? {} : { subjectType: args.subjectType }),
          ...(args.subjectId === undefined ? {} : { subjectId: args.subjectId }),
          ...(args.authorityScope === undefined ? {} : { authorityScope: args.authorityScope }),
          ...(args.authorityLevel === undefined ? {} : { authorityLevel: args.authorityLevel }),
          ...(args.relaxesDecisionId === undefined ? {} : { relaxesDecisionId: args.relaxesDecisionId }),
          ...(args.relaxesEvidenceId === undefined ? {} : { relaxesEvidenceId: args.relaxesEvidenceId }),
          ...(args.environment === undefined ? {} : { environment: args.environment }),
          ...(args.branchKey === undefined ? {} : { branchKey: args.branchKey }),
          ...(args.rolloutKey === undefined ? {} : { rolloutKey: args.rolloutKey }),
          ...(args.tenantKey === undefined ? {} : { tenantKey: args.tenantKey }),
          ...(args.regionKey === undefined ? {} : { regionKey: args.regionKey }),
          ...(args.problem === undefined ? {} : { problem: args.problem }),
          ...(args.proposal === undefined ? {} : { proposal: args.proposal }),
          ...(args.rationale === undefined ? {} : { rationale: args.rationale }),
          ...(args.alternatives === undefined ? {} : { alternatives: args.alternatives }),
          ...(args.acceptanceCriteria === undefined ? {} : { acceptanceCriteria: args.acceptanceCriteria }),
          ...(args.predecessorId === undefined ? {} : { predecessorId: args.predecessorId }),
          ...(args.supersedesId === undefined ? {} : { supersedesId: args.supersedesId }),
          ...(args.sourceTaskId === undefined ? {} : { sourceTaskId: args.sourceTaskId }),
          ...(args.sourceCandidateId === undefined ? {} : { sourceCandidateId: args.sourceCandidateId }),
          ...(args.sourceRun === undefined ? {} : { sourceRun: args.sourceRun }),
          ...(args.notePath === undefined ? {} : { notePath: args.notePath }),
          ...(args.noteClass === undefined ? {} : { noteClass: args.noteClass }),
          ...(args.noteDate === undefined ? {} : { noteDate: args.noteDate }),
          ...(args.contentHash === undefined ? {} : { contentHash: args.contentHash }),
          ...(args.baseContentHash === undefined ? {} : { baseContentHash: args.baseContentHash }),
          ...(evidence === undefined ? {} : { evidence }),
        })
        return Promise.resolve({ ok: true, decision: { ...decision } })
      } catch (error) {
        return Promise.resolve(refusal(error))
      }
    },
  })

  const decisionSearch = defineTool({
    name: 'decision_search',
    description:
      'Search proposed, authoritative or historical project Decisions. Collections are mutually exclusive. Read-only.',
    parameters: {
      projectId: { type: 'string', required: true },
      q: { type: 'string' },
      collection: { type: 'string', enum: ['proposed', 'authoritative', 'historical', 'all'] },
      status: { type: 'string', enum: ['proposed', 'implemented', 'rejected', 'archived'] },
      authorityScope: {
        type: 'string',
        enum: ['project', 'workspace', 'repository', 'branch', 'environment', 'task'],
      },
      authorityLevel: {
        type: 'string',
        enum: ['hard_constraint', 'policy', 'implementation', 'local_default'],
      },
      subjectType: {
        type: 'string',
        enum: ['project', 'task', 'module', 'service', 'api', 'process', 'data', 'security'],
      },
      subjectId: { type: 'string' },
      decisionKey: { type: 'string' },
      limit: { type: 'integer' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          result: { type: 'json' },
          code: { type: 'string' },
          message: { type: 'string' },
        },
      },
      render: (_args, value) => {
        if (!value.ok) return [{ type: 'text', text: `Refused (${String(value.code)}): ${String(value.message)}` }]
        const result = value.result as { decisions: { decisionId: string; status: string; title: string }[]; total: number }
        return [{
          type: 'text',
          text: result.decisions.length === 0
            ? 'No decisions matched.'
            : result.decisions.map(item => `- ${item.decisionId} [${item.status}] ${item.title}`).join('\n')
              + `\n(total ${result.total})`,
        }]
      },
    },
    execute(args) {
      try {
        const result = service.decisionSearch({
          projectId: args.projectId,
          ...(args.q === undefined ? {} : { q: args.q }),
          ...(args.collection === undefined ? {} : { collection: args.collection }),
          ...(args.status === undefined ? {} : { status: args.status }),
          ...(args.authorityScope === undefined ? {} : { authorityScope: args.authorityScope }),
          ...(args.authorityLevel === undefined ? {} : { authorityLevel: args.authorityLevel }),
          ...(args.subjectType === undefined ? {} : { subjectType: args.subjectType }),
          ...(args.subjectId === undefined ? {} : { subjectId: args.subjectId }),
          ...(args.decisionKey === undefined ? {} : { decisionKey: args.decisionKey }),
          ...(args.limit === undefined ? {} : { limit: args.limit }),
        })
        return Promise.resolve({
          ok: true,
          result: {
            decisions: result.decisions.map(decision => ({ ...decision })),
            total: result.total,
            searchCoverage: result.searchCoverage,
          },
        })
      } catch (error) {
        return Promise.resolve(refusal(error))
      }
    },
  })

  const decisionGet = defineTool({
    name: 'decision_get',
    description: 'Read one Decision with its evidence, relations and immutable audit trail. Read-only.',
    parameters: { decisionId: { type: 'string', required: true } },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          detail: { type: 'json' },
          code: { type: 'string' },
          message: { type: 'string' },
        },
      },
      render: (_args, value) => {
        if (!value.ok) return [{ type: 'text', text: `Refused (${String(value.code)}): ${String(value.message)}` }]
        const detail = value.detail as { decision: { decisionId: string; status: string; title: string; version: number } }
        return [{ type: 'text', text: `Decision ${detail.decision.decisionId} [${detail.decision.status}] ${detail.decision.title} v${detail.decision.version}` }]
      },
    },
    execute(args) {
      try {
        const detail = service.decisionGet(args.decisionId)
        return Promise.resolve({
          ok: true,
          detail: {
            decision: { ...detail.decision },
            evidence: detail.evidence.map(row => ({ ...row })),
            relations: detail.relations.map(row => ({ ...row })),
            audit: detail.audit.map(row => ({ ...row, payload: JSON.parse(JSON.stringify(row.payload)) as JsonValue })),
          },
        })
      } catch (error) {
        return Promise.resolve(refusal(error))
      }
    },
  })

  const tools: readonly ToolDefinition[] = [
    list, get, candidateCreate, advance, claim, comment, validate, report, rollback, execute,
    ideaCapture, ideaList, ideaTriage, decisionPropose, decisionRevise, decisionSearch, decisionGet,
  ]
  const taskTools = new Set([
    'task_get', 'task_advance', 'task_claim', 'task_comment', 'task_validate',
    'task_report_submit', 'task_rollback', 'task_execute',
  ])
  const projectTools = new Set(['candidate_create', 'decision_propose', 'decision_revise', 'decision_search'])
  const leaseGuardedTools = new Set([
    'task_advance', 'task_claim', 'task_comment', 'task_validate', 'task_report_submit',
    'task_rollback', 'task_execute', 'candidate_create', 'decision_propose', 'decision_revise', 'idea_triage',
  ])
  return tools.map((tool) => {
    if (!taskTools.has(tool.name) && !projectTools.has(tool.name)
      && tool.name !== 'task_list' && tool.name !== 'decision_get' && tool.name !== 'idea_triage') {
      return tool
    }
    const originalExecute = tool.execute.bind(tool)
    const wrappedExecute = async (args: unknown, exec: ToolRunContext): Promise<unknown> => {
      const context = getTaskToolExecutionContext(exec.agent?.id)
      if (context === undefined) return originalExecute(args, exec)
      if (leaseGuardedTools.has(tool.name)) {
        try {
          service.assertLease({ taskId: context.taskId, leaseId: context.leaseId, leaseToken: context.leaseToken })
        } catch (error) {
          return refusal(error)
        }
      }
      const parsed = args as Record<string, unknown>
      if (tool.name === 'task_list') {
        if (parsed.projectId !== undefined && parsed.projectId !== context.projectId) {
          return contextMismatch('task_list cannot query another project')
        }
        parsed.projectId = context.projectId
        return originalExecute(parsed, exec)
      }
      if (projectTools.has(tool.name)) {
        if (parsed.projectId !== undefined && parsed.projectId !== context.projectId) {
          return contextMismatch('this tool is bound to the current task project')
        }
        parsed.projectId = context.projectId
        return originalExecute(parsed, exec)
      }
      if (tool.name === 'idea_triage') {
        if (parsed.projectId !== undefined && parsed.projectId !== context.projectId) {
          return contextMismatch('idea triage is bound to the current task project')
        }
        parsed.projectId = context.projectId
        return originalExecute(parsed, exec)
      }
      if (tool.name === 'decision_get') {
        try {
          const decisionId = typeof parsed.decisionId === 'string' ? parsed.decisionId : ''
          const detail = service.decisionGet(decisionId)
          if (detail.decision.projectId !== context.projectId) {
            return contextMismatch('decision belongs to another project')
          }
        } catch (error) {
          return refusal(error)
        }
        return originalExecute(parsed, exec)
      }
      try {
        const taskId = typeof parsed.id === 'string' ? parsed.id : ''
        const task = service.getTask(taskId)
        if (task.task.projectId !== context.projectId) {
          return contextMismatch('task belongs to another project')
        }
        if (parsed.threadId !== undefined && parsed.threadId !== context.sessionId) {
          return contextMismatch('task claim must use the dispatched Session')
        }
      } catch (error) {
        return refusal(error)
      }
      return originalExecute(parsed, exec)
    }
    return { ...tool, execute: wrappedExecute }
  })
}

/**
 * Read every task through the service.
 * @param service - the task service.
 * @returns tasks in update order.
 */
function readTasks(service: TaskService): TaskRecord[] {
  return service.listTasks({ limit: 500 })
}
