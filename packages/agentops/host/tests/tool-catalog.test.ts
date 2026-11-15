import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { readToolCatalog } from '../src/tool-catalog.ts'

function writeMap(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'agentops-tool-catalog-'))
  const file = join(dir, 'tool-map.yaml')
  writeFileSync(file, body, 'utf8')
  return file
}

test('映射文件缺失时返回 missing 目录而不是抛错', () => {
  const catalog = readToolCatalog(join(tmpdir(), 'agentops-absent-tool-map.yaml'))
  assert.equal(catalog.missing, true)
  assert.deepEqual(catalog.tools, [])
})

test('解析工具元数据、迁移目标与说明', () => {
  const file = writeMap([
    'version: 3',
    'tools:',
    '  read_file:',
    '    display_name: "读取文件"',
    '    description: "读取工作区文件"',
    '    allowed_domains: [observability]',
    '    requires_human_approval: false',
    '    mapped: { plugin: "@deepseek-ai/dsh-tool-fs", tool: "read_file" }',
    '    used_by: [log_puller]',
    '  sql_query:',
    '    display_name: "SQL 查询"',
    '    description: "查询审计库"',
    '    allowed_domains: []',
    '    requires_human_approval: true',
    '    mapped: null',
    '    used_by: []',
    '    note: "无（DSH 侧走 sql_query）"',
    '',
  ].join('\n'))

  const catalog = readToolCatalog(file)
  assert.equal(catalog.missing, false)
  assert.equal(catalog.file, file)
  assert.deepEqual(catalog.tools.map(tool => tool.id), ['read_file', 'sql_query'])

  const readFile = catalog.tools[0]!
  assert.equal(readFile.displayName, '读取文件')
  assert.equal(readFile.description, '读取工作区文件')
  assert.deepEqual(readFile.allowedDomains, ['observability'])
  assert.equal(readFile.requiresHumanApproval, false)
  assert.equal(readFile.migrated, true)
  assert.equal(readFile.mappedPlugin, '@deepseek-ai/dsh-tool-fs')
  assert.equal(readFile.mappedTool, 'read_file')
  assert.equal(readFile.note, undefined)

  const sqlQuery = catalog.tools[1]!
  assert.equal(sqlQuery.migrated, false)
  assert.equal(sqlQuery.mappedPlugin, undefined)
  assert.equal(sqlQuery.requiresHumanApproval, true)
  assert.deepEqual(sqlQuery.allowedDomains, [])
  assert.equal(sqlQuery.note, '无（DSH 侧走 sql_query）')
})

test('YAML 非法时返回空目录而不是抛错', () => {
  const file = writeMap('tools: [oops\n  bad: :\n')
  const catalog = readToolCatalog(file)
  assert.equal(catalog.missing, false)
  assert.deepEqual(catalog.tools, [])
})

test('tools 不是映射时返回空目录', () => {
  const file = writeMap('version: 3\ntools:\n  - read_file\n')
  const catalog = readToolCatalog(file)
  assert.equal(catalog.missing, false)
  assert.deepEqual(catalog.tools, [])
})
