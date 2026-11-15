import { test } from 'node:test'
import assert from 'node:assert/strict'

import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'

import { apply, TOOL_NAMES } from '../src/tools.ts'

async function mount(only?: readonly string[]): Promise<string[]> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, { personaPrefix: '' })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  apply(ctx, only === undefined ? {} : { only })
  return ctx.tools.definitions().map(definition => definition.name).sort()
}

test('only 省略 = 全注册', async () => {
  assert.deepEqual(await mount(), [...TOOL_NAMES].sort())
})

test('only: [] = 一个都不注册（与"未写 only"必须可区分）', async () => {
  assert.deepEqual(await mount([]), [])
})

test('only 子集：只注册点名的', async () => {
  assert.deepEqual(await mount(['present_content']), ['present_content'])
  assert.deepEqual(await mount(['board_cleanup', 'present_content']), ['board_cleanup', 'present_content'])
})

test('only 写了本插件不注册的名字 → 抛错（防拼错静默失效）', async () => {
  await assert.rejects(() => mount(['present_contnet']), /only 含本插件不注册的工具 "present_contnet"/)
})
