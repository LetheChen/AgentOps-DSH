import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createAgent, deleteAgent, readAgent, scanAgents, updateAgent } from '../src/agents.ts'

void test('scanAgents：目录缺失返回空目录', () => {
  const result = scanAgents(join(tmpdir(), 'agentops-no-agents-xyz'))
  assert.equal(result.missing, true)
  assert.deepEqual(result.entries, [])
})

void test('scanAgents：映射 agent_id / 模型 / 权限 / 运行限制', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentops-agents-'))
  try {
    writeFileSync(join(dir, 'manager.yaml'), [
      'agent_id: manager',
      'domain: manager',
      'display_name: SupAgent',
      'description: 意图识别与编排',
      'harness: local_llm',
      'model:',
      '  provider: minimax',
      '  id: MiniMax-M3',
      'permissions:',
      '  allowed_tools: [read_file, bash]',
      '  denied_tools: [sql_execute]',
      'knowledge_bases: [finance]',
      'timeout_seconds: 600',
      'max_concurrent_runs: 3',
      'cost_limit_per_run: 1.5',
    ].join('\n'))
    writeFileSync(join(dir, 'broken.yaml'), 'just a string')
    writeFileSync(join(dir, 'notes.md'), 'ignored')

    const result = scanAgents(dir)
    assert.equal(result.missing, false)
    assert.equal(result.entries.length, 2)

    const manager = result.entries.find(entry => entry.id === 'manager')!
    assert.equal(manager.name, 'SupAgent')
    assert.equal(manager.model, 'minimax/MiniMax-M3')
    assert.equal(manager.execution_backend, 'auto')
    assert.equal(manager.execution, 'skill')
    assert.equal(manager.workflow, '')
    assert.deepEqual(manager.allowed_tools, ['read_file', 'bash'])
    assert.deepEqual(manager.denied_tools, ['sql_execute'])
    assert.deepEqual(manager.knowledge_bases, ['finance'])
    assert.equal(manager.timeout_seconds, 600)
    assert.equal(manager.max_concurrent_runs, 3)
    assert.equal(manager.cost_limit_per_run, 1.5)

    const broken = result.entries.find(entry => entry.id === 'broken')!
    assert.equal(broken.name, 'broken')
    assert.deepEqual(broken.allowed_tools, [])
    assert.equal(broken.cost_limit_per_run, null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
void test('readAgent：按 contracts 解析完整字段，非法值不返回部分定义', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentops-agents-read-'))
  try {
    writeFileSync(join(dir, 'full.yaml'), [
      'agent_id: full',
      'display_name: Full Agent',
      'domain: ops',
      'description: complete',
      'harness: codex',
      'model: auto',
      'system_prompt: follow evidence',
      'tier: T1',
      'permissions:',
      '  allowed_tools: [read_file]',
      '  denied_tools: [bash]',
      'knowledge_bases: [runbooks]',
      'timeout_seconds: 120',
      'max_concurrent_runs: 2',
      'cost_limit_per_run: null',
      'output_files:',
      '  report: reports/out.md',
      '',
    ].join('\n'))
    const read = readAgent(dir, 'full')
    assert.equal(read.ok, true)
    if (!read.ok) return
    assert.equal(read.value.systemPrompt, 'follow evidence')
    assert.deepEqual(read.value.knowledgeBases, ['runbooks'])
    assert.equal(read.value.tier, 'T1')

    writeFileSync(join(dir, 'bad.yaml'), 'agent_id: bad\nmax_concurrent_runs: -2\n')
    const bad = readAgent(dir, 'bad')
    assert.equal(bad.ok, false)
    if (bad.ok) return
    assert.equal(bad.code, 'invalid')
    assert.ok(bad.issues.some(issue => issue.path === 'max_concurrent_runs'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

void test('createAgent：创建前校验、原子写回并拒绝同名覆盖', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentops-agents-create-'))
  try {
    const input = {
      agent_id: 'writer',
      display_name: 'Writer',
      domain: 'content',
      description: 'write reports',
      harness: 'local_llm',
      model: { provider: 'deepseek', id: 'deepseek-chat' },
      system_prompt: 'Be precise',
      tier: 'T2',
      permissions: { allowed_tools: ['write_file'], denied_tools: [] },
      knowledge_bases: ['style'],
      timeout_seconds: 600,
      max_concurrent_runs: 1,
      cost_limit_per_run: 1.25,
      output_files: { report: 'reports/{run_id}.md' },
    }
    const created = createAgent(dir, input)
    assert.equal(created.ok, true)
    const reread = readAgent(dir, 'writer')
    assert.equal(reread.ok, true)
    if (!reread.ok) return
    assert.deepEqual(reread.value, created.value)

    const conflict = createAgent(dir, input)
    assert.equal(conflict.ok, false)
    if (conflict.ok) return
    assert.equal(conflict.code, 'exists')

    const invalid = createAgent(dir, { agent_id: '../escape' })
    assert.equal(invalid.ok, false)
    if (invalid.ok) return
    assert.equal(invalid.code, 'invalid')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

void test('updateAgent / deleteAgent：未知 Agent 返回 not_found，且不触碰目录外路径', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentops-agents-update-'))
  try {
    assert.equal(updateAgent(dir, { agent_id: 'missing' }).ok, false)
    const missingUpdate = updateAgent(dir, { agent_id: 'missing' })
    assert.equal(missingUpdate.ok, false)
    if (!missingUpdate.ok) assert.equal(missingUpdate.code, 'not_found')

    const missingDelete = deleteAgent(dir, '../outside')
    assert.equal(missingDelete.ok, false)
    if (!missingDelete.ok) assert.equal(missingDelete.code, 'invalid')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

void test('updateAgent：未声明 execution/workflow 的更新不会把工作流型 Agent 静默降级', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentops-agents-ownership-'))
  const base = {
    agent_id: 'smart_query',
    display_name: '智能问数',
    domain: 'smart_query',
    harness: 'local_llm',
    tier: 'T2',
    permissions: { allowed_tools: ['sql_query'], denied_tools: [] },
    output_files: {},
  }
  try {
    const created = createAgent(dir, { ...base, execution: 'workflow', workflow: 'smart-query' })
    assert.equal(created.ok, true)

    // A client that predates workflow ownership sends neither field; accepting
    // it would overwrite `execution: skill` and leave the workflow unclaimed.
    const legacyUpdate = updateAgent(dir, base)
    assert.equal(legacyUpdate.ok, false)
    if (legacyUpdate.ok) return
    assert.equal(legacyUpdate.code, 'invalid')
    assert.match(legacyUpdate.message, /smart-query/)

    const reread = readAgent(dir, 'smart_query')
    assert.equal(reread.ok, true)
    if (!reread.ok) return
    assert.equal(reread.value.workflow, 'smart-query')

    // An explicit demotion is allowed: the loss is declared rather than silent.
    const explicit = updateAgent(dir, { ...base, execution: 'skill' })
    assert.equal(explicit.ok, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
