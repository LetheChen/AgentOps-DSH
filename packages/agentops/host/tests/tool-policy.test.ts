import { test } from 'node:test'
import assert from 'node:assert/strict'

import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'

import * as toolPolicy from '../src/tool-policy.ts'

async function mount(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, { personaPrefix: '' })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  for (const toolName of ['alpha', 'beta']) {
    ctx.tools.register(defineTool({
      name: toolName,
      description: `test tool ${toolName}`,
      parameters: {},
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
      execute: () => Promise.resolve(`ran:${toolName}`),
    }))
  }
  return ctx
}

async function run(ctx: Context, name: string) {
  const batch = await ctx.tools.execute({
    calls: [{ type: 'tool-call', id: `call-${name}`, name, arguments: '{}' } as never],
    signal: AbortSignal.timeout(5_000),
  })
  return batch.results[0]!.result
}

const textOf = (result: { content: readonly unknown[] }) =>
  result.content.map(block => (block as { text?: string }).text ?? '').join(' ')

void test('未装策略时两个工具都能跑（基线）', async () => {
  const ctx = await mount()
  const alpha = await run(ctx, 'alpha')
  assert.equal(alpha.isError, false)
  assert.match(textOf(alpha), /ran:alpha/)
})

void test('装了策略：deny 名单内的工具被拒且带原因', async () => {
  const ctx = await mount()
  toolPolicy.apply(ctx, { deny: ['alpha'] })

  const alpha = await run(ctx, 'alpha')
  assert.equal(alpha.isError, true)
  assert.match(textOf(alpha), /agentops tool policy: "alpha" is denied/)

  const beta = await run(ctx, 'beta')
  assert.equal(beta.isError, false, '不得误伤名单外工具')
  assert.match(textOf(beta), /ran:beta/)
})

void test('deny 不存在的工具名无害（留痕语义）', async () => {
  const ctx = await mount()
  toolPolicy.apply(ctx, { deny: ['server_restart', 'db_migrate'] })
  const alpha = await run(ctx, 'alpha')
  assert.equal(alpha.isError, false)
})

void test('配置校验：deny 必填且不能是空串', () => {
  assert.throws(() => toolPolicy.Config({} as never))
  assert.throws(() => toolPolicy.Config({ deny: [''] }))
})
