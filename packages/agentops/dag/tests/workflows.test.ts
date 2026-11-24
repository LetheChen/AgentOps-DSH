import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { dataEdges, scheduleDependencies } from '@agentops/dsh-contracts'

import { parseWorkflowYaml } from '../src/load.ts'
import { validateWorkflow } from '../src/validate.ts'
import { scanWorkflows } from '../src/workflows.ts'

void test('scanWorkflows：目录不存在返回空目录，不抛错', () => {
  const result = scanWorkflows(join(tmpdir(), 'agentops-no-such-dir-xyz'))
  assert.equal(result.missing, true)
  assert.deepEqual(result.entries, [])
})

void test('scanWorkflows：合法与非法文件一起报，非法带错误', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentops-wf-'))
  try {
    writeFileSync(join(dir, 'ok.yaml'), [
      'workflow_id: demo',
      'name: Demo workflow',
      'description: Demo description',
      'nodes:',
      '  a:',
      '    type: agent',
      '    name: Scan',
      '    agent: scanner',
      '    business_role: Intake',
      '  b:',
      '    type: agent',
      '    agent: scanner',
      '    after: [a]',
    ].join('\n'))
    writeFileSync(join(dir, 'broken.yaml'), 'workflow_id: broken\nnodes:\n  a:\n    type: agent\n    agent: x\n    after: [ghost]\n')
    writeFileSync(join(dir, 'notes.txt'), 'ignored')

    const result = scanWorkflows(dir)
    assert.equal(result.missing, false)
    assert.equal(result.entries.length, 2)

    const ok = result.entries.find(entry => entry.file === 'ok.yaml')!
    assert.equal(ok.ok, true)
    assert.equal(ok.name, 'Demo workflow')
    assert.equal(ok.description, 'Demo description')
    assert.equal(ok.status, 'verified')
    assert.equal(ok.nodeCount, 2)
    assert.equal(ok.levelCount, 2)
    assert.match(ok.updatedAt ?? '', /^\d{4}-\d{2}-\d{2}T/)
    assert.deepEqual(ok.nodes.map(node => node.level), [0, 1], '每层一个节点')
    assert.deepEqual(ok.nodes[0], {
      id: 'a',
      level: 0,
      type: 'agent',
      displayName: 'Scan',
      agentRef: 'scanner',
      businessRole: 'Intake',
    })
    assert.deepEqual(ok.nodes[1], { id: 'b', level: 1, type: 'agent', agentRef: 'scanner' })
    assert.deepEqual(ok.edges, [{ from: 'a', to: 'b' }])

    const broken = result.entries.find(entry => entry.file === 'broken.yaml')!
    assert.equal(broken.ok, false)
    assert.equal(broken.status, 'invalid')
    assert.match(broken.errors.join(''), /ghost|未知|不存在|after/)
    assert.match(broken.updatedAt ?? '', /^\d{4}-\d{2}-\d{2}T/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

void test('边契约：outputs 多目标只形成数据边，摘要图只画 after 调度边', () => {
  const source = [
    'workflow_id: edge-contract',
    'nodes:',
    '  scan:',
    '    type: agent',
    '    agent: workflow_owner',
    '    outputs:',
    '      records:',
    '        - analyze',
    '        - report',
    '  analyze:',
    '    type: agent',
    '    agent: workflow_owner',
    '  report:',
    '    type: agent',
    '    agent: workflow_owner',
    '    after: [analyze]',
  ].join('\n')
  const workflow = parseWorkflowYaml(source)
  const scan = workflow.nodes.find(node => node.id === 'scan')!
  const report = workflow.nodes.find(node => node.id === 'report')!

  assert.deepEqual(scheduleDependencies(scan), [], 'outputs 不能进入调度依赖')
  assert.deepEqual(scheduleDependencies(report), ['analyze'])
  assert.deepEqual(dataEdges(workflow.nodes), [
    { from: 'scan', to: 'analyze', port: 'records' },
    { from: 'scan', to: 'report', port: 'records' },
  ])
  assert.deepEqual(validateWorkflow(workflow).levels, [['analyze', 'scan'], ['report']])

  const dir = mkdtempSync(join(tmpdir(), 'agentops-edge-'))
  try {
    writeFileSync(join(dir, 'edge.yaml'), source)
    const entry = scanWorkflows(dir).entries[0]!
    assert.deepEqual(entry.edges, [{ from: 'analyze', to: 'report' }], '摘要图不能把数据边画成调度边')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
