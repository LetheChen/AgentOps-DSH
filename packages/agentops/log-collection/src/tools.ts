/**
 * Model-facing pull_logs tool.
 * @module @agentops/dsh-log-collection/tools
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'

import type { PullLogsService } from './pull.ts'
import type { LogDeltaReader } from './delta.ts'

/** Immutable authorization context bound by the plugin mount. */
export interface PullLogsToolContext {
  readonly tenantKey: string
  readonly agentPreset: string
}

/**
 * Create the canonical pull_logs tool.
 * @param service - authenticated pull service.
 * @param auth - tenant and preset bound by plugin composition.
 * @returns one ToolDefinition.
 */
export function createPullLogsTool(service: PullLogsService, auth: PullLogsToolContext): ToolDefinition {
  return defineTool({
    name: 'pull_logs',
    description:
      'Pull the configured active log files for one log collection task through its bound SSH instance. '
      + 'Only log_task_id is accepted; host, paths and credentials come from the AgentOps control plane.',
    parameters: {
      log_task_id: { type: 'string', required: true, description: 'Canonical log collection task id.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          log_task_id: { type: 'string', required: true },
          ssh_instance_id: { type: 'string', required: true },
          files: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                remote_path: { type: 'string', required: true },
                local_path: { type: 'string', required: true },
                bytes: { type: 'integer', required: true },
                delta_start: { type: 'integer', required: true },
                delta_end: { type: 'integer', required: true },
                skipped: { type: 'boolean', required: true },
              },
            },
          },
          files_cleaned: { type: 'integer' },
          error: { type: 'string' },
        },
      },
      // The workflow forwards this value through a JSON output port. The model
      // must receive every file/delta field, not a human-only summary.
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args) {
      try {
        const result = await service.pull({
          tenantKey: auth.tenantKey,
          agentPreset: auth.agentPreset,
          logTaskId: args.log_task_id,
        })
        return {
          ok: true,
          log_task_id: result.logTaskId,
          ssh_instance_id: result.sshInstanceId,
          files: result.files.map(file => ({
            remote_path: file.remotePath,
            local_path: file.localPath,
            bytes: file.bytes,
            delta_start: file.deltaStart,
            delta_end: file.deltaEnd,
            skipped: file.skipped,
          })),
          files_cleaned: result.filesCleaned,
        }
      } catch (error) {
        return {
          ok: false,
          log_task_id: args.log_task_id,
          ssh_instance_id: '',
          files: [],
          error: error instanceof Error ? error.message : String(error),
        }
      }
    },
  })
}

/**
 * Register pull_logs on a Cordis context.
 * @param ctx - context owning the tool registry.
 * @param service - authenticated pull service.
 * @param auth - tenant and preset bound by composition.
 */
export function mountPullLogsTool(ctx: Context, service: PullLogsService, auth: PullLogsToolContext): void {
  ctx.tools.register(createPullLogsTool(service, auth))
}
/**
 * Create the `log_read_delta` tool.
 *
 * Returns only the bytes added by the latest pull, optionally filtered by level,
 * so the analyzer never re-reads the whole day on every run.
 * @param reader - delta reader over the same store.
 * @param auth - tenant and preset bound by plugin composition.
 * @returns one ToolDefinition.
 */
export function createLogReadDeltaTool(reader: LogDeltaReader, auth: PullLogsToolContext): ToolDefinition {
  return defineTool({
    name: 'log_read_delta',
    description: 'Read only the lines added by the latest pull for one log collection task. '
      + 'Use this before analysing; the whole file is not returned and the level filter is applied server-side.',
    parameters: {
      log_task_id: { type: 'string', required: true, description: 'Canonical log collection task id.' },
      level: { type: 'string', description: 'Optional level filter, e.g. ERROR.' },
      max_lines: { type: 'integer', description: 'Maximum lines per file (default 500).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          log_task_id: { type: 'string', required: true },
          truncated: { type: 'boolean', required: true },
          files: { type: 'array', required: true, items: { type: 'json' } },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => {
        if (value.error !== undefined) return [{ type: 'text', text: `读取增量失败：${value.error}` }]
        const files = (Array.isArray(value.files) ? value.files : []) as {
          remotePath?: string
          deltaStart?: number
          deltaEnd?: number
          matched?: number
          lines?: string[]
        }[]
        const head = `增量读取 ${value.log_task_id}：${files.length} 个文件` + (value.truncated ? '（已截断）' : '')
        const body = files.map((file) => {
          const list = Array.isArray(file.lines) ? file.lines.slice(0, 100) : []
          return `\n\n## ${file.remotePath ?? ''} [${file.deltaStart ?? 0}..${file.deltaEnd ?? 0}] matched=${file.matched ?? 0}\n`
            + (list.length === 0 ? '（没有匹配到该级别的日志行）' : list.join('\n'))
        }).join('')
        return [{ type: 'text', text: head + body }]
      },
    },
    async execute(args) {
      try {
        const result = await reader.read(auth.tenantKey, auth.agentPreset, args.log_task_id, {
          ...(args.level === undefined ? {} : { level: args.level }),
          ...(args.max_lines === undefined ? {} : { maxLines: args.max_lines }),
        })
        return {
          log_task_id: result.logTaskId,
          truncated: result.truncated,
          files: result.files as never,
        }
      } catch (error) {
        return {
          log_task_id: args.log_task_id,
          truncated: false,
          files: [] as never,
          error: error instanceof Error ? error.message : String(error),
        }
      }
    },
  })
}

/**
 * Register `log_read_delta` on a Cordis context.
 * @param ctx - the context owning the tool registry.
 * @param reader - reader for the unanalyzed log window.
 * @param auth - tenant and preset bound by plugin composition.
 */
export function mountLogReadDeltaTool(ctx: Context, reader: LogDeltaReader, auth: PullLogsToolContext): void {
  ctx.tools.register(createLogReadDeltaTool(reader, auth))
}

/**
 * Create the `log_list_tasks` discovery tool.
 *
 * A workflow run needs a concrete `log_task_id`; without this tool the model
 * has to guess or hunt for a config file that no longer exists in DSH.
 * @param store - task registry.
 * @param auth - tenant bound by plugin composition.
 * @returns one ToolDefinition.
 */
export function createLogListTasksTool(store: import('./store.ts').LogCollectionStore, auth: { readonly tenantKey: string }): ToolDefinition {
  return defineTool({
    name: 'log_list_tasks',
    description: 'List the log collection tasks this deployment has configured. Use it to discover the log_task_id before running log_read_delta.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          tasks: { type: 'array', required: true, items: { type: 'json' } },
        },
      },
      render: (_args, value) => { const tasks = (Array.isArray(value.tasks) ? value.tasks : []) as { log_task_id?: string; name?: string; enabled?: boolean }[]; return [{ type: 'text', text: tasks.length === 0 ? '没有可用的日志采集任务' : '可用日志采集任务：\n' + tasks.map(t => `- ${t.log_task_id}（${t.name ?? ''}，${t.enabled === false ? '停用' : '启用'}）`).join('\n') }] },
    },
    execute() {
      return Promise.resolve({
        tasks: store.list(auth.tenantKey).map(task => ({
          log_task_id: task.taskId,
          name: task.name,
          enabled: task.enabled,
          ssh_instance_id: task.sshInstanceId,
          remote_paths: task.remotePaths,
        })) as never,
      })
    },
  })
}

/**
 * Register `log_list_tasks` on a Cordis context.
 * @param ctx - the context owning the tool registry.
 * @param store - task registry to list tasks from.
 * @param auth - tenant bound by plugin composition.
 */
export function mountLogListTasksTool(ctx: Context, store: import('./store.ts').LogCollectionStore, auth: { readonly tenantKey: string }): void {
  ctx.tools.register(createLogListTasksTool(store, auth))
}
