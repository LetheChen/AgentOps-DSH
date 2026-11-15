// K5 冒烟夹具：在 preset scope 内装一个 guard，拒绝 config.deny 列出的工具名。
// 这是 @agentops/dsh-tool-policy 的最小等价物（真实插件只多一层 Config 校验）。
export const name = 'smoke-guard'
export const inject = ['tools']

export function apply(ctx, config) {
  const deny = new Set(config.deny ?? [])
  ctx.effect(() => ctx.tools.guard(exec => (deny.has(exec.name) ? `smoke guard denied ${exec.name}` : undefined)))
}
