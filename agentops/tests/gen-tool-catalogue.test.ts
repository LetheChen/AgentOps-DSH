/**
 * 工具目录生成器的行为测试。
 *
 * 生成器只刷新元数据，人工标注（mapped / used_by / note）必须原样保留；
 * 映射表里每个未迁移工具都要写明原因，页面才不用猜。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { load } from 'js-yaml'

import {
  collapse,
  mergeToolMetadata,
  renderToolMap,
  type ToolMapFile,
} from '../scripts/gen-tool-catalogue.ts'

const mapFile = new URL('../mappings/tool-map.yaml', import.meta.url)

test('元数据刷新不覆盖人工标注', () => {
  const existing: ToolMapFile = {
    version: 3,
    agents: ['log_puller'],
    tools: {
      read_file: {
        mapped: { plugin: '@deepseek-ai/dsh-tool-fs', tool: 'read' },
        used_by: ['log_puller'],
        note: '保留这条说明',
        display_name: '旧名称',
        description: '旧描述',
        allowed_domains: ['old'],
        requires_human_approval: true,
      },
    },
  }
  const merged = mergeToolMetadata(existing, new Map([
    ['read_file', {
      display_name: '读取文件',
      description: '读取工作区文件',
      allowed_domains: ['observability'],
      requires_human_approval: false,
    }],
  ]))

  const entry = merged.tools.read_file!
  assert.equal(entry.display_name, '读取文件')
  assert.equal(entry.description, '读取工作区文件')
  assert.deepEqual(entry.allowed_domains, ['observability'])
  assert.equal(entry.requires_human_approval, false)
  assert.deepEqual(entry.mapped, { plugin: '@deepseek-ai/dsh-tool-fs', tool: 'read' })
  assert.deepEqual(entry.used_by, ['log_puller'])
  assert.equal(entry.note, '保留这条说明')
})

test('旧项目没有的工具保留人工标注并留空元数据', () => {
  const existing: ToolMapFile = {
    version: 3,
    agents: [],
    tools: {
      legacy_only: {
        mapped: null,
        used_by: ['log_puller'],
        note: '旧项目工具，本批 20 个 agent 未引用',
      },
    },
  }
  const merged = mergeToolMetadata(existing, new Map())
  const entry = merged.tools.legacy_only!
  assert.equal(entry.display_name, 'legacy_only')
  assert.equal(entry.description, '')
  assert.deepEqual(entry.allowed_domains, [])
  assert.equal(entry.requires_human_approval, false)
  assert.equal(entry.note, '旧项目工具，本批 20 个 agent 未引用')
})

test('渲染结果字段顺序固定，且没有说明时不写 note 行', () => {
  const rendered = renderToolMap({
    version: 3,
    agents: ['log_puller'],
    tools: {
      read_file: {
        mapped: { plugin: '@deepseek-ai/dsh-tool-fs', tool: 'read' },
        used_by: ['log_puller'],
        display_name: '读取文件',
        description: '读取工作区文件',
        allowed_domains: ['observability'],
        requires_human_approval: false,
      },
    },
  })
  assert.equal(rendered.includes('note:'), false)
  assert.match(rendered, /mapped: \{ plugin: "@deepseek-ai\/dsh-tool-fs", tool: "read" \}/)
  assert.equal(rendered.endsWith('\n'), true)
})

test('多行元数据压成一行', () => {
  assert.equal(collapse('  第一行\n第二行  '), '第一行 第二行')
})

test('映射表里每个未迁移工具都写明了原因', () => {
  const document = load(readFileSync(mapFile, 'utf8')) as ToolMapFile
  const missing = Object.entries(document.tools)
    .filter(([, entry]) => entry.mapped === null && (entry.note === undefined || entry.note === ''))
    .map(([id]) => id)
  assert.deepEqual(missing, [], `这些工具未迁移却没有说明：${missing.join(', ')}`)
})
