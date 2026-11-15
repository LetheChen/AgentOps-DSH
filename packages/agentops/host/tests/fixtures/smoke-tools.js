// K1/K5 冒烟夹具：在 preset scope 内注册两个工具（名字来自 config）。
// 与 agent-preset-registry 的 fixtures 一样保持 import-free —— Loader 通过 Node 的 ESM 解析器加载。
export const name = 'smoke-tools'
export const inject = ['tools']

export function apply(ctx, config) {
  for (const toolName of config.names) {
    ctx.effect(() => ctx.tools.register({
      name: toolName,
      description: `smoke tool ${toolName}`,
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: { schema: { type: 'string' }, render: () => [{ type: 'text', text: toolName }] },
      execute: () => Promise.resolve(`ran:${toolName}`),
    }))
  }
}
