import { test } from 'node:test'
import assert from 'node:assert/strict'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

import { createSystemTool, resolveSurfaceDbPath, summarize } from '../src/dsh.ts'
import { buildDeploymentSnapshot } from '../src/collect.ts'
import type { AgentOpsSystemService } from '../src/plugin.ts'

interface SystemValue {
  dshVersion: string
  instances: { mode: string }
}

interface SystemTool {
  name: string
  parameters: { type: string; properties: Record<string, unknown> }
  description: string
  output: {
    schema: { type: string; additionalProperties: boolean }
    render: (args: Record<string, unknown>, value: SystemValue) => { type: string; text: string }[]
    presentationMeta: (args: Record<string, unknown>, value: SystemValue) => { warningCount: number; dshVersion: string }
  }
  execute: (args: Record<string, unknown>, exec: unknown) => Promise<SystemValue>
}

const systemTool = (service: AgentOpsSystemService): SystemTool =>
  createSystemTool(service) as unknown as SystemTool


function serviceFor(input: Parameters<typeof buildDeploymentSnapshot>[0]): AgentOpsSystemService {
  const snapshot = buildDeploymentSnapshot(input)
  return { snapshot: () => structuredClone(snapshot) }
}

void test('surface 数据库默认落在 DSH home 下', () => {
  assert.equal(resolveSurfaceDbPath({}), join(homedir(), '.dsh', 'agentops', 'surfaces.db'))
})

void test('AGENTOPS_SURFACE_DB 优先于 DSH_HOME', () => {
  const explicit = join('custom', 'agentops', 'surfaces.db')
  assert.equal(
    resolveSurfaceDbPath({ AGENTOPS_SURFACE_DB: explicit, DSH_HOME: join('custom', 'dsh-home') }),
    explicit,
  )
})

void test('空白的 AGENTOPS_SURFACE_DB 不覆盖 DSH_HOME', () => {
  const home = join('custom', 'dsh-home')
  assert.equal(
    resolveSurfaceDbPath({ AGENTOPS_SURFACE_DB: '  ', DSH_HOME: home }),
    resolve(home, 'agentops', 'surfaces.db'),
  )
})

void test('工具声明：名称、空参数、只读描述', () => {
  const tool = systemTool(serviceFor({ dshVersion: '0.2.1-rc.3' }))
  assert.equal(tool.name, 'agentops_system_status')
  assert.equal(tool.parameters.type, 'object')
  assert.deepEqual(tool.parameters.properties, {})
  assert.match(tool.description, /Read-only/)
  assert.equal(tool.output.schema.type, 'object')
  assert.equal(tool.output.schema.additionalProperties, false)
})

void test('execute 返回完整快照，render 输出一行摘要', async () => {
  const tool = systemTool(serviceFor({
    dshVersion: '0.2.1-rc.3',
    nodeVersion: '24.9.0',
    profile: 'agentops',
    database: { engine: 'postgres', latencyMs: 12 },
    rollback: { snapshotAt: '2026-10-25T03:00:00+08:00' },
  }))
  const value = await tool.execute({}, {})
  assert.equal(value.dshVersion, '0.2.1-rc.3')
  assert.equal(value.instances.mode, 'single')

  const blocks = tool.output.render({}, value)
  assert.equal(blocks.length, 1)
  assert.match(blocks[0]!.text, /DSH 0\.2\.1-rc\.3 on Node 24\.9\.0/)
  assert.match(blocks[0]!.text, /DSH /)
  assert.match(blocks[0]!.text, /no warnings/)
})

void test('告警进入摘要与展示元数据', async () => {
  const tool = systemTool(serviceFor({
    dshVersion: '0.2.1-rc.3',
    instances: { mode: 'multi', hostCount: 2, sessionSticky: false },
    database: { engine: 'postgres', latencyMs: 12 },
    rollback: { snapshotAt: '2026-10-25T03:00:00+08:00' },
  }))
  const value = await tool.execute({}, {})
  const blocks = tool.output.render({}, value)
  assert.match(blocks[0]!.text, /1 warning\(s\)/)
  assert.match(blocks[0]!.text, /会话粘性/)

  const meta = tool.output.presentationMeta({}, value)
  assert.equal(meta.warningCount, 1)
  assert.equal(meta.dshVersion, '0.2.1-rc.3')
})

void test('summarize 对未知延迟给出占位而不断言', () => {
  const text = summarize(buildDeploymentSnapshot({ dshVersion: 'x', database: { engine: 'pg' } }))
  assert.match(text, /db pg \?ms/)
})
