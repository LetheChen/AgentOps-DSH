import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { scanActors, scanDomains } from '../src/catalog.ts'

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

void test('目录缺失时业务域注册表为空且标记 missing', () => {
  const scan = scanDomains(join(tmpdir(), 'agentops-absent-domains'))
  assert.equal(scan.missing, true)
  assert.deepEqual(scan.entries, [])
})

void test('解析业务域默认值与文件名排序', () => {
  const dir = tempDir('agentops-domains-')
  writeFileSync(join(dir, 'smart_query.yaml'), [
    'domain: smart_query',
    'display_name: 智能问数',
    'description: 用自然语言查询业务库',
    'default_permissions:',
    '  allowed_tools: [sql_query]',
    '  denied_tools: [shell_exec]',
    'default_knowledge_bases: [metrics]',
    'cost_limit_per_run: 2.5',
    '',
  ].join('\n'))
  writeFileSync(join(dir, 'oa_query.yaml'), 'domain: oa_query\n', 'utf8')

  const scan = scanDomains(dir)
  assert.equal(scan.missing, false)
  assert.deepEqual(scan.entries.map(entry => entry.domain), ['oa_query', 'smart_query'])

  const query = scan.entries[1]!
  assert.equal(query.displayName, '智能问数')
  assert.deepEqual(query.defaultAllowedTools, ['sql_query'])
  assert.deepEqual(query.defaultDeniedTools, ['shell_exec'])
  assert.deepEqual(query.defaultKnowledgeBases, ['metrics'])
  assert.equal(query.costLimitPerRun, 2.5)
  assert.equal(query.valid, true)
  assert.deepEqual(query.issues, [])
})

void test('非法业务域文件保留为条目并带 issue', () => {
  const dir = tempDir('agentops-domains-')
  writeFileSync(join(dir, 'broken.yaml'), 'display_name: 缺少 domain\n', 'utf8')

  const scan = scanDomains(dir)
  assert.equal(scan.entries.length, 1)
  assert.equal(scan.entries[0]?.valid, false)
  assert.equal(scan.entries[0]?.domain, 'broken')
  assert.ok((scan.entries[0]?.issues.length ?? 0) > 0)
})

void test('Actor 注册表按子目录读取 Profile', () => {
  const dir = tempDir('agentops-actors-')
  mkdirSync(join(dir, 'log_puller'), { recursive: true })
  writeFileSync(join(dir, 'log_puller', 'actor_visual_profile.json'), JSON.stringify({
    actor_id: 'log_puller',
    description: '抽取日志中的异常',
    allowed_surface_views: [
      {
        view_id: 'log_summary',
        output_contract: 'LogSummary',
        description: '异常摘要',
        required_phases: ['partial'],
        fields: { count: { type: 'integer', required: true } },
      },
    ],
  }), 'utf8')

  const scan = scanActors(dir)
  assert.equal(scan.missing, false)
  assert.equal(scan.entries.length, 1)
  const actor = scan.entries[0]!
  assert.equal(actor.actorId, 'log_puller')
  assert.equal(actor.valid, true)
  assert.equal(actor.views.length, 1)
  assert.equal(actor.views[0]?.viewId, 'log_summary')
  assert.equal(actor.views[0]?.outputContract, 'LogSummary')
  assert.deepEqual(actor.views[0]?.requiredPhases, ['partial'])
  assert.equal(actor.views[0]?.fieldCount, 1)
})

void test('Actor 子目录缺少 Profile 时保留为无效条目', () => {
  const dir = tempDir('agentops-actors-')
  mkdirSync(join(dir, 'manager'), { recursive: true })

  const scan = scanActors(dir)
  assert.equal(scan.entries.length, 1)
  assert.equal(scan.entries[0]?.actorId, 'manager')
  assert.equal(scan.entries[0]?.valid, false)
  assert.ok((scan.entries[0]?.issues.length ?? 0) > 0)
})
