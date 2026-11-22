/**
 * Capability-backed webhook notification tools.
 *
 * The URL never comes from model arguments: the tool resolves the bound
 * capability instance for the executing preset and reads its sealed webhook URL.
 * This is the DSH replacement for the old `wecom_notify` / `feishu_bot_notify`
 * handlers, which read a process environment variable.
 *
 * @module @agentops/dsh-capability/notify-tools
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'

import type { CapabilityRuntime } from './types.ts'
import { resolveWebhookUrl } from './validation.ts'

export const name = 'agentops-notify-tools'

export const inject = ['tools', 'capabilityRuntime']

/** Tools registered by this plugin. */
export const TOOL_NAMES = ['feishu_notify', 'wecom_notify'] as const

/** Preset-scoped notification configuration. */
export interface NotifyToolsConfig {
  readonly agentPreset: string
  /** Optional fixed instance; omission resolves the only bound instance. */
  readonly instanceId?: string
  readonly only?: readonly string[]
}

interface NotifyResult {
  readonly ok: boolean
  readonly message: string
  readonly status?: number
  readonly response?: string
}

async function postWebhook(url: string, payload: unknown, timeoutMs: number): Promise<NotifyResult> {
  const controller = new AbortController()
  const timer = setTimeout(() =>{  controller.abort() }, timeoutMs)
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    })
    const text = await response.text()
    const parsed = safeJson(text)
    const parsedRecord = parsed as Record<string, unknown> | undefined
    const code = parsedRecord === undefined ? 0 : Number(parsedRecord.errcode ?? parsedRecord.code ?? 0)
    const ok = response.ok && (code === 0 || Number.isNaN(code))
    return {
      ok,
      message: ok ? '通知已发送' : `通知接口返回失败：${text.slice(0, 300)}`,
      status: response.status,
      response: text.slice(0, 500),
    }
  } catch (error) {
    return { ok: false, message: `通知发送失败：${error instanceof Error ? error.message : String(error)}` }
  } finally {
    clearTimeout(timer)
  }
}

function safeJson(text: string): unknown {
  try { return JSON.parse(text) as unknown } catch { return undefined }
}

function feishuPayload(content: string, title: string, msgType: string): unknown {
  return msgType === 'text'
    ? { msg_type: 'text', content: { text: content } }
    : {
      msg_type: 'post',
      content: { post: { zh_cn: { title: title || 'AgentOps 通知', content: [[{ tag: 'text', text: content }]] } } },
    }
}

function wecomPayload(content: string, msgType: string): unknown {
  return msgType === 'text'
    ? { msgtype: 'text', text: { content } }
    : { msgtype: 'markdown', markdown: { content } }
}

function createTool(
  ctx: Context,
  config: NotifyToolsConfig,
  capabilityId: 'feishu-bot' | 'wecom',
): ToolDefinition {
  const label = capabilityId === 'feishu-bot' ? '飞书' : '企业微信'
  return defineTool({
    name: capabilityId === 'feishu-bot' ? 'feishu_notify' : 'wecom_notify',
    description: `Send a ${label} group message through the capability instance bound to this Agent. `
      + 'The webhook URL is read from the sealed capability credential; never pass a URL.',
    parameters: {
      content: { type: 'string', required: true, description: 'Message body.' },
      title: { type: 'string', description: 'Optional title (Feishu post only).' },
      msg_type: { type: 'string', description: 'text or markdown/post.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          message: { type: 'string', required: true },
          status: { type: 'integer' },
          response: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.message }],
    },
    async execute(args) {
      let runtime: CapabilityRuntime
      try {
        runtime = ctx.capabilityRuntime.resolve(config.agentPreset, capabilityId, config.instanceId)
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) }
      }
      const resolved = resolveWebhookUrl(capabilityId, runtime.config, runtime.secret)
      if (!resolved.ok) return { ok: false, message: resolved.reason }
      const timeout = typeof runtime.config.timeout_seconds === 'number'
        ? Math.min(Math.max(runtime.config.timeout_seconds, 1), 30) * 1000
        : 10_000
      const payload = capabilityId === 'feishu-bot'
        ? feishuPayload(args.content, args.title ?? '', args.msg_type ?? 'post')
        : wecomPayload(args.content, args.msg_type ?? 'markdown')
      return await postWebhook(resolved.url, payload, timeout)
    },
  })
}

/**
 * Register the notification tools for one preset.
 * @param ctx - Agent-scoped context.
 * @param config - preset binding and optional fixed instance.
 */
export function apply(ctx: Context, config: NotifyToolsConfig): void {
  const agentPreset = config.agentPreset.trim()
  if (agentPreset === '') {
    throw new Error('@agentops/dsh-capability/tools requires config.agentPreset; add it to the preset plugin row')
  }
  const allow = config.only === undefined ? undefined : new Set(config.only)
  for (const capabilityId of ['feishu-bot', 'wecom'] as const) {
    const tool = createTool(ctx, { ...config, agentPreset }, capabilityId)
    if (allow !== undefined && !allow.has(tool.name)) continue
    ctx.tools.register(tool)
  }
}
