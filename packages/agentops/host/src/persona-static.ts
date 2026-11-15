/**
 * 静态人设行：把旧平台的 `system_prompt` 原样带入 DSH，**不做变量插值**。
 *
 * 为什么不直接用 `@deepseek-ai/dsh-persona`：它的 Config 没有 `interpolate` 开关，
 * 而 DSH 的提示词插值是 strict——旧 `system_prompt` 里形如 `{{node_id}}` 的模板变量
 * 在 agent 级没有真值，会直接抛 `unknown prompt variable`，整个轮次渲染失败。
 *
 * 关键：本行必须**占用保留的 section 名** `deployment:persona-prefix` 才能"顶替"部署人设；
 * 换成自定义 section 名就只是追加，会出现双份人设。
 *
 * @module @agentops/dsh-host/persona-static
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { PERSONA_PREFIX_SECTION } from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-system-prompt'

/** Cordis 插件名。 */
export const name = 'agentops-persona-static'

/** 只依赖提示词注册表。 */
export const inject = ['systemPrompt']

/** 插件配置。 */
export interface Config {
  /** 人设正文；`{{…}}` 会被当字面量保留（不插值）。 */
  text: string
}

/** 运行时 schema：`text` 必填，避免空人设静默生效。 */
export const Config: z<Config> = z.object({
  text: z.string().required(),
})

/**
 * 在**调用方的 scope**注册人设 section（放在 preset 里就只影响该 preset 的 agent）。
 * @param ctx - Agent 或 preset scope 上的上下文。
 * @param config - 人设正文。
 */
export function apply(ctx: Context, config: Config): void {
  ctx.effect(() => ctx.systemPrompt.section({
    name: PERSONA_PREFIX_SECTION,
    order: ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX'),
    text: config.text,
    interpolate: false,
  }), 'agentops-persona-static.section()')
}
