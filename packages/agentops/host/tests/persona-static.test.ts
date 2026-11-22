import { test } from 'node:test'
import assert from 'node:assert/strict'

import { Context } from '@deepseek-ai/cordis'
import { createScope, scopeOf } from '@deepseek-ai/dsh-scope'
import type { Scope } from '@deepseek-ai/dsh-scope'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'

import * as personaStatic from '../src/persona-static.ts'

async function mount(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, { personaPrefix: 'You are the deployment persona.' })
  return ctx
}

async function mintScope(ctx: Context, name: string): Promise<Scope> {
  let scope!: Scope
  await ctx.plugin(Object.assign((inner: Context) => { scope = createScope(inner, { name }) },
    { inject: ['systemPrompt'] }))
  return scope
}

const keyOf = (scope: Scope) => scopeOf(scope.ctx)!

void test('人设原样带入：{{…}} 保留字面量，并且顶替部署人设', async () => {
  const ctx = await mount()
  const scope = await mintScope(ctx, 'agent-a')
  await scope.ctx.plugin(personaStatic, { text: '你是工作流节点 {{node_id}}，输入 {{question}}。' })

  const scoped = renderPrompt(await ctx.systemPrompt.assemble({ scope: keyOf(scope) }))
  assert.match(scoped, /\{\{node_id\}\}/, '模板变量必须按字面量保留')
  assert.match(scoped, /\{\{question\}\}/)
  assert.doesNotMatch(scoped, /You are the deployment persona/, '必须顶替部署人设，而不是追加')

  const global = renderPrompt(await ctx.systemPrompt.assemble())
  assert.match(global, /You are the deployment persona/, '全局层不受影响')
  assert.doesNotMatch(global, /\{\{node_id\}\}/)
})

void test('反证：不加 interpolate:false 时 strict 插值会抛错', async () => {
  const ctx = await mount()
  const scope = await mintScope(ctx, 'agent-b')
  scope.ctx.systemPrompt.section({ name: 'deployment:persona-prefix', order: 0, text: '节点 {{node_id}}' })

  const assembly = await ctx.systemPrompt.assemble({ scope: keyOf(scope) })
  assert.throws(() => renderPrompt(assembly), /unknown prompt variable/)
})

void test('配置校验：text 必填', () => {
  assert.throws(() => personaStatic.Config({} as never))
})
