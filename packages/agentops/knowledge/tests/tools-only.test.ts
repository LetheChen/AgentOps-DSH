import { test } from 'node:test'
import assert from 'node:assert/strict'

import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'

import { apply, TOOL_NAMES } from '../src/tools.ts'
import type { KnowledgeConfig } from '../src/dsh.ts'

const BASE: KnowledgeConfig = { dbPath: ':memory:', readableSpaces: ['finance'], allowedImportRoots: [] }

async function mount(only?: readonly string[]): Promise<string[]> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, { personaPrefix: '' })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  apply(ctx, only === undefined ? BASE : { ...BASE, only } as KnowledgeConfig)
  return ctx.tools.definitions().map(definition => definition.name).sort()
}

void test('knowledge：省略 only 时全部工具都在', async () => {
  assert.deepEqual(await mount(), [...TOOL_NAMES].sort())
})

void test('knowledge：only: [] 全禁', async () => {
  assert.deepEqual(await mount([]), [])
})

void test('knowledge：only 子集生效', async () => {
  assert.deepEqual(await mount(['knowledge_search']), ['knowledge_search'])
})

void test('knowledge：未知名字抛错', async () => {
  await assert.rejects(() => mount(['query_kb']), /only 含本插件不注册的工具 "query_kb"/)
})
