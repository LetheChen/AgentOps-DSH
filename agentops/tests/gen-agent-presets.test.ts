import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'

import { load } from 'js-yaml'

import { buildPreset, renderPatch, EXTERNAL_PLUGIN_TOOLS, KNOWN_TOOLS } from '../scripts/gen-agent-presets.ts'
import type { AgentYaml } from '../scripts/gen-agent-presets.ts'

const toolMap = {
  tools: {
    sql_query: { mapped: { plugin: '@agentops/dsh-db/tools', tool: 'sql_query' } },
    describe_database: { mapped: { plugin: '@agentops/dsh-db/tools', tool: 'describe_database' } },
    present_content: { mapped: { plugin: '@agentops/dsh-host/tools', tool: 'present_content' } },
    query_kb: { mapped: { plugin: '@agentops/dsh-knowledge/tools', tool: 'knowledge_search' } },
    read_file: { mapped: { plugin: '@deepseek-ai/dsh-tool-fs', tool: 'read' } },
    write_file: { mapped: { plugin: '@deepseek-ai/dsh-tool-fs', tool: 'write' } },
    bash: { mapped: { plugin: '@deepseek-ai/dsh-tool-pwsh', tool: 'pwsh' } },
    read_skill: { mapped: { plugin: '@deepseek-ai/dsh-tool-skill', tool: 'skill' } },
    log_query: { mapped: null },
    pull_logs: { mapped: null },
    ingest_source: { mapped: null },
    plan_tasks: { mapped: null },
  },
}

const kbMap = {
  keys: {
    shared_kb: { domain: null, space: null },
    smart_query_kb: { domain: 'smart-query', space: 'smart-query' },
  },
}

const agent = (over: Partial<AgentYaml> = {}): AgentYaml => ({
  agent_id: 'demo',
  system_prompt: '你是 {{node_id}} 节点。',
  permissions: { allowed_tools: ['sql_query', 'present_content', 'query_kb'], denied_tools: ['ssh_exec'] },
  ...over,
})

test('按插件分组生成 only，未映射的工具只告警不写入', () => {
  const out = buildPreset(agent(), toolMap, kbMap)
  const dbRow = out.rows.find(row => row.id === 'db-tools')
  assert.deepEqual(dbRow?.config, { only: ['sql_query'] })
  const hostRow = out.rows.find(row => row.id === 'host-tools')
  assert.deepEqual(hostRow?.config, { only: ['present_content'] })
  assert.ok(out.warnings.some(w => w.includes('plan_tasks') === false))

  const withUnmapped = buildPreset(agent({ permissions: { allowed_tools: ['plan_tasks'] } }), toolMap, kbMap)
  assert.ok(withUnmapped.warnings.some(w => w.includes('plan_tasks')))
  assert.equal(withUnmapped.rows.find(row => row.id === 'db-tools'), undefined)
})

test('人设走 persona-static，deny 走 tool-policy', () => {
  const out = buildPreset(agent(), toolMap, kbMap)
  const persona = out.rows[0]!
  assert.equal(persona.name, '@agentops/dsh-host/persona-static')
  assert.equal(persona.config?.text, '你是 {{node_id}} 节点。', '模板变量必须原样保留')
  const policy = out.rows.find(row => row.id === 'tool-policy')
  assert.deepEqual(policy?.config, { deny: ['ssh_exec'] })
  assert.equal(out.rows.some(row => JSON.stringify(row).includes('restrict')), false, '绝不生成 restrict')
})

test('denied_tools 中的旧名会追加运行期工具名', () => {
  const out = buildPreset(agent({ permissions: { denied_tools: ['bash'] } }), toolMap, kbMap)
  const policy = out.rows.find(row => row.id === 'tool-policy')
  assert.deepEqual(policy?.config, { deny: ['bash', 'pwsh'] })
})

test('agent-instructions 显式配置 DSH 必填的 maxBytes', () => {
  const out = buildPreset(agent(), toolMap, kbMap)
  const instructions = out.rows.find(row => row.id === 'agent-instructions')
  assert.deepEqual(instructions?.config, { maxBytes: 65536 })
})

test('KB：空间未映射 → readableSpaces 为空并告警；映射了才写入', () => {
  const none = buildPreset(agent({ knowledge_bases: ['shared_kb'] }), toolMap, kbMap)
  const noneRow = none.rows.find(row => row.id === 'knowledge-tools')
  assert.deepEqual(noneRow?.config, { readableSpaces: [], allowedImportRoots: [], only: ['knowledge_search'] })
  assert.ok(none.warnings.some(w => w.includes('未映射 space')))

  const mapped = buildPreset(agent({ knowledge_bases: ['smart_query_kb'] }), toolMap, kbMap)
  const mappedRow = mapped.rows.find(row => row.id === 'knowledge-tools')
  assert.deepEqual((mappedRow?.config as { readableSpaces: string[] }).readableSpaces, ['smart-query'])
})

test('映射到插件不注册的工具 → 立即抛错（防漂移）', () => {
  const bad = { tools: { sql_query: { mapped: { plugin: '@agentops/dsh-db/tools', tool: 'sql_execute' } } } }
  assert.throws(() => buildPreset(agent(), bad, kbMap), /不注册的工具 "sql_execute"/)
})

test('映射到未知的自有插件 → 立即抛错', () => {
  const bad = { tools: { sql_query: { mapped: { plugin: '@agentops/dsh-nope/tools', tool: 'sql_query' } } } }
  assert.throws(() => buildPreset(agent(), bad, kbMap), /未知插件/)
})

test('KNOWN_TOOLS 覆盖八个自有插件', () => {
  assert.deepEqual(Object.keys(KNOWN_TOOLS).sort(), [
    '@agentops/dsh-capability/tools', '@agentops/dsh-dag/tools', '@agentops/dsh-db/tools',
    '@agentops/dsh-host/tools', '@agentops/dsh-knowledge/tools', '@agentops/dsh-log-collection/tools',
    '@agentops/dsh-security/tools', '@agentops/dsh-task/tools-v1',
  ])
})

test('外部插件按真实 Config 契约生成，不伪造 only', () => {
  const out = buildPreset(agent({
    permissions: { allowed_tools: ['read_file', 'write_file', 'bash', 'read_skill'] },
  }), toolMap, kbMap)

  const fsRow = out.rows.find(row => row.id === 'fs-tools')
  assert.equal(fsRow?.name, '@deepseek-ai/dsh-tool-fs')
  assert.deepEqual(fsRow?.config, { read: true, readImage: false, write: true, edit: false })

  const pwshRow = out.rows.find(row => row.id === 'pwsh-tool')
  assert.equal(pwshRow?.name, '@deepseek-ai/dsh-tool-pwsh')
  assert.equal(pwshRow?.config, undefined)

  const skillRow = out.rows.find(row => row.id === 'tool-skill')
  assert.equal(skillRow?.name, '@deepseek-ai/dsh-tool-skill')
  assert.equal(skillRow?.config, undefined)

  assert.deepEqual(EXTERNAL_PLUGIN_TOOLS['@deepseek-ai/dsh-tool-fs'], ['read', 'read_image', 'write', 'edit'])
})

test('日志与周报专用工具未迁移时只告警，不映射到相似工具', () => {
  const out = buildPreset(agent({
    permissions: { allowed_tools: ['log_query', 'pull_logs', 'ingest_source'] },
  }), toolMap, kbMap)

  for (const tool of ['log_query', 'pull_logs', 'ingest_source']) {
    assert.ok(out.warnings.some(w => w.includes(tool)), `${tool} 必须出现在告警里`)
  }
  assert.equal(out.rows.some(row => row.id === 'fs-tools' || row.id === 'knowledge-tools'), false)
})

test('渲染物是合法 YAML，且不含未替换的模板表达式', () => {
  const defined = agent({ display_name: '演示 Agent', description: '用于验证预设元数据。' })
  const out = buildPreset(defined, toolMap, kbMap)
  const text = renderPatch([out], { agents: [defined] })
  assert.match(text, /^# GENERATED - DO NOT EDIT/)
  assert.match(text, /name: "演示 Agent"/)
  assert.match(text, /description: "用于验证预设元数据。"/)
  assert.doesNotMatch(text, /\$\{/)
  assert.doesNotMatch(text, /\bindex\b/)
  assert.equal(load(text)[0].insert[0].config.hidden, true)
  assert.doesNotThrow(() => load(text))
})

test('全部作者面 Agent 都是合法 YAML，且每个都能生成 preset', () => {
  const agentsDir = new URL('../agents/', import.meta.url)
  const files = readdirSync(agentsDir).filter(name => name.endsWith('.yaml')).sort()
  const agents = files.map(name => load(readFileSync(new URL(name, agentsDir), 'utf8')) as AgentYaml)
  assert.deepEqual(agents.map(item => item.agent_id).sort(), [
    'coding_agent', 'log_analyst', 'log_puller', 'manager', 'multi-agent-report', 'oa_assistant',
    'proposal_planner', 'quality_inspector', 'smart_analysis', 'smart_approval', 'smart_form',
    'smart_ops', 'smart_query', 'task_conductor', 'task_decomposer', 'task_dispatcher',
    'task_inbox', 'task_monitor', 'task_planner', 'video_creator', 'weekly-reporter',
  ])

  const actualToolMap = load(readFileSync(new URL('../mappings/tool-map.yaml', import.meta.url), 'utf8')) as Parameters<typeof buildPreset>[1]
  const actualKbMap = load(readFileSync(new URL('../mappings/kb-map.yaml', import.meta.url), 'utf8')) as Parameters<typeof buildPreset>[2]
  const text = renderPatch(agents.map(item => buildPreset(item, actualToolMap, actualKbMap)), { agents })
  for (const item of agents) {
    assert.match(text, new RegExp(`id: preset-agent-${item.agent_id.replaceAll('-', '\\-')}`))
  }
  const parsed = load(text)
  for (const item of agents) {
    const preset = parsed[0].insert.find(row => row.config.id === item.agent_id)
    assert.equal(preset.config.hidden === true, item.agent_id !== 'manager')
  }

  const logPuller = agents.find(item => item.agent_id === 'log_puller')!
  const policy = buildPreset(logPuller, actualToolMap, actualKbMap).rows.find(row => row.id === 'tool-policy')
  assert.deepEqual(policy?.config, { deny: ['wecom_notify', 'feishu_notify', 'bash', 'pwsh'] })
})
