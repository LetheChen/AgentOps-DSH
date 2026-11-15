/**
 * 工具策略行：把旧 agent 定义的 `denied_tools` 落成 DSH 的调用层拒绝。
 *
 * 为什么不用 `tools.restrict()`：它只约束**祖先/全局**工具，而且拿本 scope 已注册的
 * 工具名调用会直接 throw（行失败 → preset broken → 新会话创建失败）。
 * `ctx.tools.guard()` 按 scope 分层，能挡住本 scope 自己注册的工具，且只影响挂载它的 agent。
 *
 * 语义提醒：deny 是**兜底**而不是主手段。真正干净的"禁用"是**不挂那一行**
 * （不注册 = 模型看不到）。本行用于①工具由共享行注册、无法按行拆②防未来同名工具。
 *
 * @module @agentops/dsh-host/tool-policy
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-tools'

/** Cordis 插件名。 */
export const name = 'agentops-tool-policy'

/** 只依赖工具注册表。 */
export const inject = ['tools']

/** 插件配置。 */
export interface Config {
  /** 禁止调用的工具名；对当前不存在的名字无害，纯留痕。 */
  deny: string[]
}

/** 运行时 schema：非空字符串数组，避免 `deny: ['']` 这种静默无效配置。 */
export const Config: z<Config> = z.object({
  deny: z.array(z.string().min(1)).required(),
})

/**
 * 在**调用方的 scope**装一条 guard（放在 preset 里就只影响该 preset 的 agent）。
 * @param ctx - Agent 或 preset scope 上的上下文。
 * @param config - 禁止的工具名。
 */
export function apply(ctx: Context, config: Config): void {
  const deny = new Set(config.deny)
  ctx.effect(() => ctx.tools.guard(exec =>
    (deny.has(exec.name) ? `agentops tool policy: "${exec.name}" is denied for this agent` : undefined),
  ), 'agentops-tool-policy.guard()')
}
