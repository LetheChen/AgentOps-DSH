/**
 * T7-1 迁移脚本与校验脚本的行为测试。
 *
 * 迁移脚本的每条规则都要有对应断言：规则改了而断言没改，迁移就会静默漂移。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { load } from 'js-yaml'

import { listAssets, migrateAgent, migrateWorkflow, normalizeText } from '../scripts/migrate-legacy-assets.ts'
import { verifyMigration } from '../scripts/verify-migration.ts'

const AGENT_DIR = new URL('../agents/', import.meta.url)
const WORKFLOW_DIR = new URL('../workflows/', import.meta.url)

test('R1 文本规范：去 BOM、CRLF→LF、结尾恰好一个换行', () => {
  assert.equal(normalizeText('\uFEFFa\r\nb\r\n'), 'a\nb\n')
  assert.equal(normalizeText('a\n\n\n'), 'a\n')
  assert.equal(normalizeText('a'), 'a\n')
})

test('R2 只把 claude 系 harness 改写为 local_llm，codex 原样保留', () => {
  const code = migrateAgent('agent_id: a\ntier: T1\nharness: claude_code\n', 'a')
  assert.match(code.text, /^harness: local_llm$/m)
  assert.ok(code.changes.some(change => change.rule.startsWith('R2')))

  const sdk = migrateAgent('agent_id: a\ntier: T1\nharness: claude_sdk\n', 'a')
  assert.match(sdk.text, /^harness: local_llm$/m)

  const codex = migrateAgent('agent_id: a\ntier: T1\nharness: codex\n', 'a')
  assert.match(codex.text, /^harness: codex$/m)
  assert.deepEqual(codex.changes, [])
})

test('R3 只改写已知的 model id，其他 id 不动', () => {
  const mapped = migrateAgent('agent_id: a\ntier: T1\nmodel:\n  provider: minimax\n  id: MiniMax-M3.1-Flash\n', 'a')
  assert.match(mapped.text, /^ {2}id: MiniMax-M3$/m)

  const untouched = migrateAgent('agent_id: a\ntier: T1\nmodel:\n  provider: minimax\n  id: MiniMax-M2.7\n', 'a')
  assert.match(untouched.text, /^ {2}id: MiniMax-M2.7$/m)
  assert.deepEqual(untouched.changes, [])
})

test('R4 缺 tier 时在 agent_id 之后补 T2，已有 tier 不动', () => {
  const added = migrateAgent('agent_id: a\nharness: local_llm\n', 'a')
  assert.match(added.text, /^agent_id: a\ntier: T2\n/m)

  const kept = migrateAgent('agent_id: a\ntier: T1\n', 'a')
  assert.equal((kept.text.match(/^tier:/gm) ?? []).length, 1)
  assert.match(kept.text, /^tier: T1$/m)
})

test('迁移是幂等的：同一份原文再迁一次文本不变', () => {
  const once = migrateAgent('agent_id: a\r\nharness: claude_code\r\n', 'a')
  const twice = migrateAgent(once.text, 'a')
  assert.equal(twice.text, once.text)
  assert.deepEqual(twice.changes, [])
})

test('R5 删除顶层 business_category，不误伤缩进后的同名字段', () => {
  const removed = migrateWorkflow('name: w\nbusiness_category: ops\nnodes: []\n', 'w')
  assert.doesNotMatch(removed.text, /business_category/)
  assert.match(removed.text, /^nodes: \[\]$/m)
  assert.ok(removed.changes.some(change => change.rule.startsWith('R5')))

  const nested = migrateWorkflow('name: w\nnodes:\n  business_category: ops\n', 'w')
  assert.match(nested.text, /^ {2}business_category: ops$/m)
  assert.deepEqual(nested.changes, [])
})

test('listAssets 按目录约定列出原仓库的 agent 与 workflow', () => {
  const root = mkdtempSync(join(tmpdir(), 'agentops-migrate-'))
  mkdirSync(join(root, 'config', 'agents'), { recursive: true })
  mkdirSync(join(root, 'workflows'), { recursive: true })
  writeFileSync(join(root, 'config', 'agents', 'a.yaml'), 'agent_id: a\n')
  writeFileSync(join(root, 'workflows', 'w.yaml'), 'name: w\n')

  const assets = listAssets(root, root)
  assert.deepEqual(assets.map(asset => [asset.kind, asset.name]), [['agent', 'a'], ['workflow', 'w']])
})

test('已迁资产在 DSH 契约与 DAG 引擎下没有硬失败', () => {
  const result = verifyMigration()
  assert.deepEqual(result.failures, [], `硬失败必须为空：${JSON.stringify(result.failures, null, 2)}`)
})

test('资产数量与磁盘一致，且每份 agent 都显式声明 tier', () => {
  const agentFiles = readdirSync(AGENT_DIR).filter(name => name.endsWith('.yaml'))
  const workflowFiles = readdirSync(WORKFLOW_DIR).filter(name => name.endsWith('.yaml'))
  const result = verifyMigration()
  assert.equal(result.agents, agentFiles.length)
  assert.equal(result.workflows, workflowFiles.length)

  for (const file of agentFiles) {
    const doc = load(readFileSync(new URL(file, AGENT_DIR), 'utf8')) as { tier?: string }
    assert.ok(doc.tier, `${file} 必须显式声明 tier，缺 tier 会静默降成 T2`)
  }
})

test('不兼容项只落在已知类别里', () => {
  const known = new Set([
    'missing-agent',
    'unmapped-tool',
    'missing-kb',
    'command-node',
    'implicit-tier',
    'legacy-workflow',
    'unowned-workflow',
  ])
  for (const item of verifyMigration().incompatibilities) {
    assert.ok(known.has(item.category), `未知不兼容类别：${item.category}`)
  }
})

test('没有 Agent 声明的工作流被标记，且不进入硬失败', () => {
  const result = verifyMigration()
  const unowned = result.incompatibilities.filter(item => item.category === 'unowned-workflow')
  assert.deepEqual(
    unowned.map(item => item.asset).sort(),
    ['example-greet', 'hello-world', 'hybrid-test', 'travel-expense'],
    '归属模型下没有所属 Agent 的工作流必须显式列出',
  )
  assert.equal(
    result.failures.some(failure => unowned.some(item => item.asset === failure.asset)),
    false,
    '已标记为遗留的工作流不应同时算作硬失败',
  )
})

test('引用不存在的 agent 被记为不兼容项；command 节点已全部迁出', () => {
  const incompatibilities = verifyMigration().incompatibilities
  assert.ok(incompatibilities.some(item => item.category === 'missing-agent'), '缺失 agent 必须被记录')
  assert.equal(
    incompatibilities.some(item => item.category === 'command-node'),
    false,
    '迁移后的工作流不再含 command 节点：确定性步骤改由原生工具或 agent 节点承担',
  )
  assert.equal(incompatibilities.some(item => item.category === 'implicit-tier'), false, '迁移后不该再有隐式 tier')
})
