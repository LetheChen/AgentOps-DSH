import assert from 'node:assert/strict'
import test from 'node:test'

import { Context } from '@deepseek-ai/cordis'

import * as feishuTools from '../src/feishu-tools.ts'
import type { CapabilityRuntime } from '../src/types.ts'

function runtime(overrides: Partial<CapabilityRuntime> = {}): CapabilityRuntime {
  return {
    agentPreset: 'oa_assistant',
    capabilityId: 'feishu-docs',
    instanceId: 'feishu-docs',
    name: 'Feishu docs',
    config: { app_id: 'cli_test', base_url: 'https://open.feishu.cn' },
    accessPolicy: {},
    secret: 'app-secret',
    credentialGeneration: 'gen-1',
    ...overrides,
  }
}

interface RegisteredTool {
  readonly name: string
  execute(args: Record<string, unknown>): Promise<Record<string, unknown>>
}

async function fixture(
  transport: (path: string, query: Readonly<Record<string, string | number | undefined>>) => Promise<unknown>,
): Promise<{ tools: RegisteredTool[]; runtime: CapabilityRuntime }> {
  const ctx = new Context()
  const registered: unknown[] = []
  const subject = runtime()
  await ctx.plugin({
    name: 'capability-host',
    inject: [],
    apply: (c) => {
      c.reflect.provide('tools', { register: (tool: unknown) => { registered.push(tool) } })
      c.reflect.provide('capabilityRuntime', { resolve: () => subject })
      c.reflect.provide('capabilityRest', {
        transport: {
          request: async (_candidate: CapabilityRuntime, request: Record<string, unknown>) => {
            const path = String(request['path'])
            const query = (request['query'] ?? {}) as Readonly<Record<string, string | number | undefined>>
            return { ok: true, status: 200, json: await transport(path, query), text: '', contentType: 'application/json', token: null }
          },
        },
      })
    },
  })
  await ctx.plugin(feishuTools, { agentPreset: 'oa_assistant' })
  return { tools: registered as RegisteredTool[], runtime: subject }
}

void test('Feishu docs list walks folders and keeps paths for the model', async () => {
  const calls: string[] = []
  const { tools } = await fixture(async (path, query) => {
    calls.push(path)
    if (path === '/open-apis/drive/v1/files') {
      if (query['folder_token'] === undefined) {
        return { code: 0, data: { files: [
          { token: 'folder-1', type: 'folder', name: '项目文档' },
          { token: 'doc-1', type: 'docx', name: '总览', url: 'https://example.feishu.cn/docx/doc-1' },
        ] } }
      }
      if (query['folder_token'] === 'folder-1') {
        return { code: 0, data: { files: [
          { token: 'doc-2', type: 'docx', name: '需求', url: 'https://example.feishu.cn/docx/doc-2' },
        ] } }
      }
    }
    throw new Error(`unexpected ${path}`)
  })
  const tool = tools.find(item => item.name === 'feishu_docs_list')
  assert.ok(tool)
  const result = await tool.execute({ recursive: true })
  assert.equal(result['ok'], true)
  assert.equal(result['total'], 3)
  assert.equal(result['truncated'], false)
  assert.deepEqual(result['items'], [
    { token: 'folder-1', type: 'folder', name: '项目文档', url: null, modifiedTime: null, ownerId: null, path: '项目文档' },
    { token: 'doc-1', type: 'docx', name: '总览', url: 'https://example.feishu.cn/docx/doc-1', modifiedTime: null, ownerId: null, path: '总览' },
    { token: 'doc-2', type: 'docx', name: '需求', url: 'https://example.feishu.cn/docx/doc-2', modifiedTime: null, ownerId: null, path: '项目文档/需求' },
  ])
  assert.equal(calls.length, 2)
})

void test('Feishu docs read accepts a docx token and a wiki URL', async () => {
  const { tools } = await fixture(async (path, query) => {
    if (path === '/open-apis/wiki/v2/spaces/get_node') {
      return { code: 0, data: { node: { obj_type: 'docx', obj_token: 'doc-wiki', title: '知识库文档' } } }
    }
    if (path === '/open-apis/docs/v1/content') {
      assert.equal(query['doc_type'], 'docx')
      return { code: 0, data: { content: `正文：${String(query['doc_token'])}` } }
    }
    throw new Error(`unexpected ${path}`)
  })
  const tool = tools.find(item => item.name === 'feishu_docs_read')
  assert.ok(tool)
  const docx = await tool.execute({ document: 'doc-direct-123' })
  assert.equal(docx['ok'], true)
  assert.equal(docx['token'], 'doc-direct-123')
  assert.equal(docx['content'], '正文：doc-direct-123')
  const wiki = await tool.execute({ document: 'https://team.feishu.cn/wiki/wiki-node-123' })
  assert.equal(wiki['ok'], true)
  assert.equal(wiki['token'], 'doc-wiki')
  assert.equal(wiki['title'], '知识库文档')
  assert.equal(wiki['content'], '正文：doc-wiki')
})

void test('Feishu docs tools report an invalid API origin before transport', async () => {
  const ctx = new Context()
  const registered: unknown[] = []
  let calls = 0
  await ctx.plugin({
    name: 'capability-host',
    inject: [],
    apply: (c) => {
      c.reflect.provide('tools', { register: (tool: unknown) => { registered.push(tool) } })
      c.reflect.provide('capabilityRuntime', {
        resolve: () => runtime({ config: { app_id: 'cli_test', base_url: 'http://open.feishu.cn' } }),
      })
      c.reflect.provide('capabilityRest', {
        transport: { request: async () => { calls += 1; return { ok: true, status: 200, json: { code: 0 }, text: '', contentType: 'application/json', token: null } } },
      })
    },
  })
  await ctx.plugin(feishuTools, { agentPreset: 'oa_assistant' })
  const tool = registered.find(entry => (entry as { name?: string }).name === 'feishu_docs_list') as RegisteredTool
  const result = await tool.execute({})
  assert.equal(result['ok'], false)
  assert.match(String(result['note']), /https:\/\//)
  assert.equal(calls, 0)
})
